import {
  access,
  copyFile,
  lstat,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { validatePublishablePaths } from "./change-policy.js";
import { FixClaim, VerificationResult } from "./types.js";

export interface TestRunResult {
  passed: boolean;
  detail: string;
  changedFiles?: string[];
}

export interface VerifyDeps {
  runTestsAtRef(
    ref: string,
    testPath?: string,
    options?: { includeWorkingTree?: boolean },
  ): Promise<TestRunResult>;
  validateChangedFiles?(
    preFixRef: string,
    fixRef: string,
    testPath?: string,
  ): Promise<TestRunResult>;
}

export async function verifyFix(
  claim: FixClaim,
  preFixRef: string,
  deps: VerifyDeps,
): Promise<VerificationResult> {
  if (claim.status !== "fixed") {
    return rejected("Agent did not claim a fix.");
  }
  if (!claim.testPath) {
    return rejected("Agent did not provide a reproduction test path.");
  }

  const fixRef = claim.branch ?? "HEAD";
  const guard = deps.validateChangedFiles
    ? await deps.validateChangedFiles(preFixRef, fixRef, claim.testPath)
    : { passed: true, detail: "No changed-file guard configured." };
  if (!guard.passed) return rejected(guard.detail);

  const before = await deps.runTestsAtRef(preFixRef, claim.testPath);
  const after = await deps.runTestsAtRef(fixRef, claim.testPath, {
    includeWorkingTree: true,
  });
  const suite = await deps.runTestsAtRef(fixRef, undefined, {
    includeWorkingTree: true,
  });
  const reproFailedBeforeFix = !before.passed;
  const reproPassedAfterFix = after.passed;
  const fullSuitePassed = suite.passed;
  const outcome =
    reproFailedBeforeFix && reproPassedAfterFix && fullSuitePassed
      ? "verified"
      : "rejected";

  return {
    outcome,
    reproFailedBeforeFix,
    reproPassedAfterFix,
    fullSuitePassed,
    detail: [
      `changed-file guard: ${guard.detail}`,
      `pre-fix reproduction: ${before.detail}`,
      `post-fix reproduction: ${after.detail}`,
      `post-fix full suite: ${suite.detail}`,
    ].join("\n"),
    ...(guard.changedFiles ? { verifiedPaths: guard.changedFiles } : {}),
  };
}

export function defaultVerifyDeps(
  cwd: string,
  timeoutMs = 60_000,
): VerifyDeps {
  const root = resolve(cwd);
  return {
    runTestsAtRef: (ref, testPath, options) =>
      runTestsInWorktree(
        root,
        ref,
        testPath,
        options?.includeWorkingTree ?? false,
        timeoutMs,
      ),
    validateChangedFiles: (preFixRef, fixRef, testPath) =>
      validateChangedFiles(root, preFixRef, fixRef, testPath),
  };
}

async function runTestsInWorktree(
  root: string,
  ref: string,
  testPath: string | undefined,
  includeWorkingTree: boolean,
  timeoutMs: number,
): Promise<TestRunResult> {
  validateGitRef(ref);
  if (testPath?.startsWith("-")) {
    return {
      passed: false,
      detail: `Invalid reproduction test path: ${testPath}`,
    };
  }
  const temporaryRoot = await makeTempDirectory("incident-verify-");
  const worktree = join(temporaryRoot, "worktree");
  try {
    const add = await runCommand(
      "git",
      ["worktree", "add", "--detach", worktree, ref],
      root,
      timeoutMs,
    );
    if (!add.passed) return add;

    if (testPath) {
      const source = safePath(root, testPath);
      const destination = safePath(worktree, testPath);
      try {
        await access(source);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      } catch (error) {
        return {
          passed: false,
          detail: `Unable to stage reproduction test ${testPath}: ${formatError(error)}`,
        };
      }
    }

    if (includeWorkingTree) {
      const overlay = await overlayWorkingTree(root, worktree);
      if (!overlay.passed) return overlay;
    }

    await linkNodeModules(root, worktree);
    return await runCommand(
      process.execPath,
      [
        resolve(worktree, "node_modules", "vitest", "vitest.mjs"),
        "run",
        ...(testPath ? [testPath] : []),
      ],
      worktree,
      timeoutMs,
    );
  } finally {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", worktree],
      root,
      timeoutMs,
    ).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function validateChangedFiles(
  root: string,
  preFixRef: string,
  fixRef: string,
  testPath?: string,
): Promise<TestRunResult> {
  validateGitRef(preFixRef);
  validateGitRef(fixRef);
  const diff = await runCommand(
    "git",
    ["diff", "--name-only", `${preFixRef}...${fixRef}`],
    root,
    10_000,
  );
  if (!diff.passed) return diff;

  const changed = diff.detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const working = await listWorkingTreeChanges(root);
  if (!working.passed) return working;
  const workingPaths = working.changedFiles ?? [];
  const allChanged = [...new Set([...changed, ...workingPaths])];
  const violations = testPath
    ? validatePublishablePaths(allChanged, testPath)
    : ["Agent did not provide a reproduction test path."];

  if (testPath) {
    const normalizedTestPath = testPath.replaceAll("\\", "/");
    const existed = await runCommand(
      "git",
      ["cat-file", "-e", `${preFixRef}:${normalizedTestPath}`],
      root,
      10_000,
    );
    if (existed.passed) violations.push(normalizedTestPath);
  }

  return violations.length === 0
    ? {
        passed: true,
        detail: "only verified source changes and one new reproduction test changed",
        changedFiles: allChanged,
      }
    : {
        passed: false,
        detail: `Unpublishable or protected files changed: ${[...new Set(violations)].join(", ")}`,
      };
}

function rejected(detail: string): VerificationResult {
  return {
    outcome: "rejected",
    reproFailedBeforeFix: false,
    reproPassedAfterFix: false,
    fullSuitePassed: false,
    detail,
  };
}

async function linkNodeModules(root: string, worktree: string): Promise<void> {
  const source = resolve(root, "node_modules");
  const destination = resolve(worktree, "node_modules");
  try {
    const stat = await lstat(source);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      await symlink(source, destination, "junction");
    }
  } catch {
    // The command result will clearly report a missing local Vitest install.
  }
}

interface WorkingTreeEntry {
  status: string;
  path: string;
}

async function listWorkingTreeChanges(
  root: string,
): Promise<TestRunResult> {
  const status = await runCommand(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    root,
    10_000,
    false,
  );
  if (!status.passed) return status;

  try {
    const entries = parseWorkingTreeStatus(status.detail);
    const unsupported = entries.filter(({ status }) => /[RC]/.test(status));
    if (unsupported.length > 0) {
      return {
        passed: false,
        detail: `Renamed or copied working-tree paths are not publishable: ${unsupported.map(({ path }) => path).join(", ")}`,
      };
    }
    return {
      passed: true,
      detail: "working-tree changes enumerated",
      changedFiles: entries.map(({ path }) => path),
    };
  } catch (error) {
    return { passed: false, detail: formatError(error) };
  }
}

async function overlayWorkingTree(
  root: string,
  worktree: string,
): Promise<TestRunResult> {
  const status = await runCommand(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    root,
    10_000,
    false,
  );
  if (!status.passed) return status;

  try {
    const entries = parseWorkingTreeStatus(status.detail);
    for (const entry of entries) {
      if (/[RC]/.test(entry.status)) {
        return {
          passed: false,
          detail: `Cannot verify renamed or copied working-tree path: ${entry.path}`,
        };
      }
      const destination = safePath(worktree, entry.path);
      if (entry.status.includes("D")) {
        await rm(destination, { force: true });
        continue;
      }
      const source = safePath(root, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    return { passed: true, detail: "working-tree changes overlaid" };
  } catch (error) {
    return {
      passed: false,
      detail: `Unable to overlay working-tree changes: ${formatError(error)}`,
    };
  }
}

function parseWorkingTreeStatus(output: string): WorkingTreeEntry[] {
  const parts = output.split("\0");
  const entries: WorkingTreeEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.length < 4 || part[2] !== " ") {
      throw new Error(`Unexpected git status entry: ${JSON.stringify(part)}`);
    }
    const status = part.slice(0, 2);
    const path = part.slice(3);
    entries.push({ status, path });
    if (/[RC]/.test(status)) index += 1;
  }
  return entries;
}

async function makeTempDirectory(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(resolve(tmpdir(), prefix));
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Expected a relative path: ${path}`);
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes repository: ${path}`);
  }
  return resolved;
}

function validateGitRef(ref: string): void {
  if (
    ref.trim() === "" ||
    ref.startsWith("-") ||
    /[\u0000-\u001f\u007f\s]/.test(ref)
  ) {
    throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  trimOutput = true,
): Promise<TestRunResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: TestRunResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ passed: false, detail: formatError(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const detail = trimOutput ? output.trim() : output;
      finish({
        passed: !timedOut && code === 0,
        detail: timedOut
          ? `Timed out after ${timeoutMs}ms`
          : detail ||
            (code === 0 ? "" : `Exited with code ${code ?? "unknown"}`),
      });
    });
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
