import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export interface IncidentWorkspace {
  cwd: string;
  preFixRef: string;
  branch?: string;
}

export type WorkspaceDisposition = "completed" | "failed" | "published";

export interface WorkspaceReleaseResult {
  removed: boolean;
  reason?: string;
}

export interface WorkspaceCleanupResult extends WorkspaceReleaseResult {
  cwd: string;
  branch: string;
}

export interface IncidentWorkspaceManager {
  acquire(
    incidentId: string,
    attemptCount: number,
  ): Promise<IncidentWorkspace>;
  release(
    workspace: IncidentWorkspace,
    disposition: WorkspaceDisposition,
  ): Promise<WorkspaceReleaseResult>;
}

export interface WorkspaceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceCommandRunner {
  run(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<WorkspaceCommandResult>;
}

export interface GitIncidentWorkspaceManagerConfig {
  repoRoot: string;
  workspaceRoot: string;
  targetRef: string;
  remote?: string;
  commandRunner?: WorkspaceCommandRunner;
}

export class FixedIncidentWorkspaceManager
  implements IncidentWorkspaceManager
{
  private readonly workspace: IncidentWorkspace;

  constructor(cwd: string, preFixRef: string) {
    this.workspace = {
      cwd: resolve(cwd),
      preFixRef,
    };
  }

  async acquire(): Promise<IncidentWorkspace> {
    return this.workspace;
  }

  async release(): Promise<WorkspaceReleaseResult> {
    return { removed: false, reason: "Workspace is managed externally." };
  }
}

export class GitIncidentWorkspaceManager
  implements IncidentWorkspaceManager
{
  private repoRoot: string;
  private workspaceRoot: string;
  private readonly targetRef: string;
  private readonly remote: string;
  private readonly commands: WorkspaceCommandRunner;
  private readonly activeWorkspaces = new Map<
    string,
    Required<IncidentWorkspace>
  >();

  constructor(config: GitIncidentWorkspaceManagerConfig) {
    this.repoRoot = resolve(config.repoRoot);
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.targetRef = validateGitRef(config.targetRef);
    this.remote = validateGitRemote(config.remote ?? "origin");
    this.commands = config.commandRunner ?? defaultWorkspaceCommandRunner;
    if (containsPath(this.repoRoot, this.workspaceRoot)) {
      throw new Error(
        "Managed workspace root must be outside the target repository.",
      );
    }
  }

  async acquire(
    incidentId: string,
    attemptCount: number,
  ): Promise<IncidentWorkspace> {
    if (!Number.isInteger(attemptCount) || attemptCount <= 0) {
      throw new Error("Incident attempt count must be a positive integer.");
    }
    await mkdir(this.workspaceRoot, { recursive: true });
    await this.validateRepository();
    await this.mustRun(
      "git",
      ["worktree", "prune"],
      this.repoRoot,
    );
    await this.mustRun(
      "git",
      ["fetch", "--no-tags", this.remote],
      this.repoRoot,
    );
    const preFixRef = (
      await this.mustRun(
        "git",
        ["rev-parse", "--verify", `${this.targetRef}^{commit}`],
        this.repoRoot,
      )
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(preFixRef)) {
      throw new Error(
        `Target ref ${this.targetRef} did not resolve to a commit SHA.`,
      );
    }

    const identity = workspaceIdentity(incidentId, attemptCount);
    const branch = `incident-fix/${identity}`;
    const cwd = safeChildPath(this.workspaceRoot, identity);
    await this.assertPathAbsent(cwd);
    const branchExists = await this.commands.run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      this.repoRoot,
    );
    if (branchExists.code === 0) {
      throw new Error(`Managed incident branch already exists: ${branch}`);
    }
    if (branchExists.code !== 1) {
      throw commandError(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        branchExists,
      );
    }

    let added = false;
    try {
      await this.mustRun(
        "git",
        ["worktree", "add", "-b", branch, cwd, preFixRef],
        this.repoRoot,
      );
      added = true;
      await this.linkDependencies(cwd);
      const workspace = { cwd, preFixRef, branch };
      this.activeWorkspaces.set(cwd, workspace);
      return workspace;
    } catch (error) {
      if (added) {
        await this.commands.run(
          "git",
          ["worktree", "remove", "--force", cwd],
          this.repoRoot,
        );
      }
      await this.commands.run(
        "git",
        ["branch", "-D", branch],
        this.repoRoot,
      );
      throw error;
    }
  }

  async release(
    workspace: IncidentWorkspace,
    disposition: WorkspaceDisposition,
  ): Promise<WorkspaceReleaseResult> {
    if (!workspace.branch) {
      return {
        removed: false,
        reason: "Managed workspace is missing its branch.",
      };
    }
    const cwd = safeChildPath(this.workspaceRoot, resolve(workspace.cwd));
    const acquired = this.activeWorkspaces.get(cwd);
    if (
      !acquired ||
      acquired.branch !== workspace.branch ||
      acquired.preFixRef !== workspace.preFixRef
    ) {
      throw new Error(
        `Refusing to release a workspace not acquired by this manager: ${cwd}`,
      );
    }
    if (disposition === "failed") {
      return {
        removed: false,
        reason: `Preserved failed workspace at ${cwd}.`,
      };
    }

    const status = await this.mustRun(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    );
    if (status.stdout.trim()) {
      return {
        removed: false,
        reason: `Preserved workspace with uncommitted changes at ${cwd}.`,
      };
    }
    if (disposition !== "published") {
      const ahead = await this.mustRun(
        "git",
        ["rev-list", "--count", `${workspace.preFixRef}..HEAD`],
        cwd,
      );
      if (Number(ahead.stdout.trim()) > 0) {
        return {
          removed: false,
          reason: `Preserved workspace with unpublished commits at ${cwd}.`,
        };
      }
    }

    await this.mustRun(
      "git",
      ["worktree", "remove", "--force", cwd],
      this.repoRoot,
    );
    await this.mustRun(
      "git",
      ["branch", "-D", workspace.branch],
      this.repoRoot,
    );
    this.activeWorkspaces.delete(cwd);
    return { removed: true };
  }

  async cleanup(): Promise<WorkspaceCleanupResult[]> {
    await mkdir(this.workspaceRoot, { recursive: true });
    await this.validateRepository();
    await this.mustRun("git", ["worktree", "prune"], this.repoRoot);
    await this.mustRun(
      "git",
      ["fetch", "--no-tags", this.remote],
      this.repoRoot,
    );
    const targetSha = (
      await this.mustRun(
        "git",
        ["rev-parse", "--verify", `${this.targetRef}^{commit}`],
        this.repoRoot,
      )
    ).stdout.trim();
    const listed = await this.mustRun(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      this.repoRoot,
    );
    const results: WorkspaceCleanupResult[] = [];
    for (const worktree of parseWorktrees(listed.stdout)) {
      const branch = managedBranchFor(
        this.workspaceRoot,
        worktree.cwd,
        worktree.branch,
      );
      if (!branch) continue;
      const status = await this.mustRun(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        worktree.cwd,
      );
      if (status.stdout.trim()) {
        results.push({
          cwd: worktree.cwd,
          branch,
          removed: false,
          reason: "Preserved workspace with uncommitted changes.",
        });
        continue;
      }

      const ahead = Number(
        (
          await this.mustRun(
            "git",
            ["rev-list", "--count", `${targetSha}..HEAD`],
            worktree.cwd,
          )
        ).stdout.trim(),
      );
      if (ahead > 0) {
        const remoteHead = await this.commands.run(
          "git",
          [
            "ls-remote",
            "--heads",
            this.remote,
            `refs/heads/${branch}`,
          ],
          worktree.cwd,
        );
        const publishedSha = remoteHead.stdout.trim().split(/\s+/, 1)[0];
        if (remoteHead.code !== 0 || publishedSha !== worktree.head) {
          results.push({
            cwd: worktree.cwd,
            branch,
            removed: false,
            reason: "Preserved workspace with unpublished commits.",
          });
          continue;
        }
      }

      await this.mustRun(
        "git",
        ["worktree", "remove", "--force", worktree.cwd],
        this.repoRoot,
      );
      await this.mustRun(
        "git",
        ["branch", "-D", branch],
        this.repoRoot,
      );
      results.push({ cwd: worktree.cwd, branch, removed: true });
    }
    return results;
  }

  private async validateRepository(): Promise<void> {
    const root = (
      await this.mustRun(
        "git",
        ["rev-parse", "--show-toplevel"],
        this.repoRoot,
      )
    ).stdout.trim();
    const [configured, discovered, managedRoot] = await Promise.all([
      realpath(this.repoRoot),
      realpath(root),
      realpath(this.workspaceRoot),
    ]);
    if (configured !== discovered) {
      throw new Error(
        `Configured repository root ${this.repoRoot} resolves to ${discovered}.`,
      );
    }
    if (containsPath(discovered, managedRoot)) {
      throw new Error(
        "Managed workspace root must be outside the target repository.",
      );
    }
    this.repoRoot = discovered;
    this.workspaceRoot = managedRoot;
  }

  private async assertPathAbsent(path: string): Promise<void> {
    try {
      await lstat(path);
      throw new Error(`Managed incident workspace already exists: ${path}`);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }

  private async linkDependencies(worktree: string): Promise<void> {
    const source = resolve(this.repoRoot, "node_modules");
    const destination = resolve(worktree, "node_modules");
    const sourceStat = await lstat(source).catch((error: unknown) => {
      throw new Error(
        `Target repository dependencies are unavailable at ${source}: ${formatError(error)}`,
      );
    });
    if (!sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) {
      throw new Error(`Target repository dependencies are not a directory: ${source}`);
    }
    await mkdir(destination);
    const ignored = await this.commands.run(
      "git",
      ["check-ignore", "--quiet", "node_modules"],
      worktree,
    );
    if (ignored.code !== 0) {
      throw new Error(
        "Target repository must ignore node_modules before dependencies can be linked.",
      );
    }
    for (const entry of await readdir(source)) {
      const entryStat = await stat(resolve(source, entry));
      await symlink(
        resolve(source, entry),
        resolve(destination, entry),
        entryStat.isDirectory() ? "junction" : "file",
      );
    }
  }

  private async mustRun(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<WorkspaceCommandResult> {
    const result = await this.commands.run(command, args, cwd);
    if (result.code !== 0) throw commandError(command, args, result);
    return result;
  }
}

export function workspaceIdentity(
  incidentId: string,
  attemptCount: number,
): string {
  const slug =
    incidentId
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 64) || "incident";
  const hash = createHash("sha256").update(incidentId).digest("hex").slice(0, 10);
  return `${slug}-${hash}-attempt-${attemptCount}`;
}

export const defaultWorkspaceCommandRunner: WorkspaceCommandRunner = {
  run(command, args, cwd) {
    return new Promise((resolveResult) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: WorkspaceCommandResult) => {
        if (settled) return;
        settled = true;
        resolveResult(result);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        finish({ code: 1, stdout, stderr: formatError(error) });
      });
      child.on("close", (code) => {
        finish({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};

function safeChildPath(root: string, path: string): string {
  if (isAbsolute(path)) {
    const rel = relative(root, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`Workspace path escapes managed root: ${path}`);
    }
    return path;
  }
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Workspace path escapes managed root: ${path}`);
  }
  return resolved;
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function managedBranchFor(
  root: string,
  candidate: string,
  branchRef: string | undefined,
): string | undefined {
  const rel = relative(root, resolve(candidate));
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.includes(sep) ||
    basename(candidate) !== rel
  ) {
    return undefined;
  }
  const branch = `incident-fix/${rel}`;
  return branchRef === `refs/heads/${branch}` ? branch : undefined;
}

function parseWorktrees(output: string): Array<{
  cwd: string;
  head: string;
  branch?: string;
}> {
  const entries: Array<{
    cwd: string;
    head: string;
    branch?: string;
  }> = [];
  let current:
    | {
        cwd: string;
        head: string;
        branch?: string;
      }
    | undefined;
  for (const field of output.split("\0")) {
    if (!field) continue;
    if (field.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { cwd: field.slice("worktree ".length), head: "" };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries.filter((entry) => entry.cwd && entry.head);
}

function validateGitRef(ref: string): string {
  if (
    !ref ||
    ref.startsWith("-") ||
    /[\u0000-\u001f\u007f\s]/.test(ref)
  ) {
    throw new Error(`Invalid target ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

function validateGitRemote(remote: string): string {
  if (
    !remote ||
    remote.startsWith("-") ||
    /[\u0000-\u001f\u007f\s]/.test(remote)
  ) {
    throw new Error(`Invalid Git remote: ${JSON.stringify(remote)}`);
  }
  return remote;
}

function commandError(
  command: string,
  args: string[],
  result: WorkspaceCommandResult,
): Error {
  return new Error(
    `${[command, ...args].join(" ")} failed: ${
      result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    }`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
