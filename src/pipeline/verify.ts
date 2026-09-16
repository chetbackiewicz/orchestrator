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
import { FixClaim, VerificationResult } from "./types.js";

export interface TestRunResult {
  passed: boolean;
  detail: string;
}

export interface VerifyDeps {
  runTestsAtRef(
    ref: string,
    testPath?: string,
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
  const after = await deps.runTestsAtRef(fixRef, claim.testPath);
  const suite = await deps.runTestsAtRef(fixRef);
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
  };
}

export function defaultVerifyDeps(
  cwd: string,
  timeoutMs = 60_000,
): VerifyDeps {
  const root = resolve(cwd);
  return {
    runTestsAtRef: (ref, testPath) =>
      runTestsInWorktree(root, ref, testPath, timeoutMs),
    validateChangedFiles: (preFixRef, fixRef, testPath) =>
      validateChangedFiles(root, preFixRef, fixRef, testPath),
  };
}

async function runTestsInWorktree(
  root: string,
  ref: string,
  testPath: string | undefined,
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

    await linkNodeModules(root, worktree);
    return runCommand(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--no-install", "vitest", "run", ...(testPath ? [testPath] : [])],
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
  const normalizedTestPath = testPath?.replaceAll("\\", "/");
  const violations: string[] = [];

  for (const path of changed) {
    const normalized = path.replaceAll("\\", "/");
    if (
      normalized.startsWith(".github/") ||
      /(^|\/)vitest\.config\.[^/]+$/.test(normalized)
    ) {
      violations.push(path);
      continue;
    }
    if (isTestPath(normalized) && normalized !== normalizedTestPath) {
      violations.push(path);
    }
  }

  if (normalizedTestPath) {
    const existed = await runCommand(
      "git",
      ["cat-file", "-e", `${preFixRef}:${normalizedTestPath}`],
      root,
      10_000,
    );
    if (existed.passed) violations.push(normalizedTestPath);
  }

  return violations.length === 0
    ? { passed: true, detail: "protected files unchanged" }
    : {
        passed: false,
        detail: `Protected verification files changed: ${[...new Set(violations)].join(", ")}`,
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

function isTestPath(path: string): boolean {
  return (
    path.startsWith("test/") ||
    path.startsWith("tests/") ||
    path.includes("/__tests__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
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
      finish({
        passed: !timedOut && code === 0,
        detail: timedOut
          ? `Timed out after ${timeoutMs}ms`
          : output.trim() || `Exited with code ${code ?? "unknown"}`,
      });
    });
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
