import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitIncidentWorkspaceManager,
  workspaceIdentity,
} from "../src/workspace/manager.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("GitIncidentWorkspaceManager", () => {
  it("creates an isolated attempt workspace and removes it after completion", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });

    const workspace = await manager.acquire("Incident / Season", 2);

    expect(workspace.preFixRef).toBe(fixture.baseSha);
    expect(workspace.branch).toBe(
      `incident-fix/${workspaceIdentity("Incident / Season", 2)}`,
    );
    expect(await git(workspace.cwd, "branch", "--show-current")).toBe(
      workspace.branch,
    );
    expect((await lstat(join(workspace.cwd, "node_modules"))).isDirectory())
      .toBe(true);

    await writeFile(join(workspace.cwd, "agent-change.txt"), "isolated\n");
    await expect(
      readFile(join(fixture.repo, "agent-change.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const preserved = await manager.release(workspace, "completed");
    expect(preserved).toMatchObject({
      removed: false,
      reason: expect.stringContaining("uncommitted changes"),
    });

    await unlink(join(workspace.cwd, "agent-change.txt"));
    const released = await manager.release(workspace, "completed");
    expect(released).toEqual({ removed: true });
    await expect(lstat(workspace.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      execFileAsync("git", [
        "-C",
        fixture.repo,
        "show-ref",
        "--verify",
        `refs/heads/${workspace.branch}`,
      ]),
    ).rejects.toBeDefined();
  });

  it("preserves unpublished commits and removes published workspaces", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });
    const workspace = await manager.acquire("incident-committed", 1);
    await writeFile(join(workspace.cwd, "fix.txt"), "fixed\n");
    await git(workspace.cwd, "add", "fix.txt");
    await git(workspace.cwd, "commit", "-m", "fix");

    const preserved = await manager.release(workspace, "completed");
    expect(preserved).toMatchObject({
      removed: false,
      reason: expect.stringContaining("unpublished commits"),
    });

    const released = await manager.release(workspace, "published");
    expect(released).toEqual({ removed: true });
  });

  it("preserves failed workspaces without inspecting or modifying them", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });
    const workspace = await manager.acquire("incident-failed", 1);
    await writeFile(join(workspace.cwd, "partial.txt"), "partial\n");

    const result = await manager.release(workspace, "failed");

    expect(result).toMatchObject({
      removed: false,
      reason: expect.stringContaining(workspace.cwd),
    });
    expect(await readFile(join(workspace.cwd, "partial.txt"), "utf8")).toBe(
      "partial\n",
    );
  });

  it("rejects a duplicate incident attempt instead of reusing stale work", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });
    await manager.acquire("incident-duplicate", 1);

    await expect(manager.acquire("incident-duplicate", 1)).rejects.toThrow(
      /workspace already exists|branch already exists/,
    );
  });

  it("refuses to release workspaces it did not acquire", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });

    await expect(
      manager.release(
        {
          cwd: join(fixture.workspaces, "forged"),
          branch: "main",
          preFixRef: fixture.baseSha,
        },
        "published",
      ),
    ).rejects.toThrow("not acquired by this manager");
  });

  it("cleans preserved workspaces only when their state is safe", async () => {
    const fixture = await createRepositoryFixture();
    const firstManager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });
    const clean = await firstManager.acquire("incident-clean", 1);
    const dirty = await firstManager.acquire("incident-dirty", 1);
    const published = await firstManager.acquire("incident-published", 1);
    await writeFile(join(dirty.cwd, "partial.txt"), "partial\n");
    await writeFile(join(published.cwd, "fix.txt"), "fixed\n");
    await git(published.cwd, "add", "fix.txt");
    await git(published.cwd, "commit", "-m", "published fix");
    await git(
      published.cwd,
      "push",
      "--set-upstream",
      "origin",
      published.branch!,
    );
    await firstManager.release(clean, "failed");
    await firstManager.release(dirty, "failed");
    await firstManager.release(published, "failed");

    const cleanupManager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });
    const results = await cleanupManager.cleanup();

    expect(results).toEqual(
      expect.arrayContaining([
        {
          cwd: clean.cwd,
          branch: clean.branch,
          removed: true,
        },
        {
          cwd: dirty.cwd,
          branch: dirty.branch,
          removed: false,
          reason: "Preserved workspace with uncommitted changes.",
        },
        {
          cwd: published.cwd,
          branch: published.branch,
          removed: true,
        },
      ]),
    );
    await expect(lstat(clean.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(published.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(dirty.cwd, "partial.txt"), "utf8")).toBe(
      "partial\n",
    );
  });

  it("ignores worktrees without the exact managed path and branch pairing", async () => {
    const fixture = await createRepositoryFixture();
    const unrelated = join(fixture.workspaces, "different-name");
    await mkdir(fixture.workspaces, { recursive: true });
    await git(
      fixture.repo,
      "worktree",
      "add",
      "-b",
      "incident-fix/not-the-directory",
      unrelated,
      "origin/main",
    );
    const manager = new GitIncidentWorkspaceManager({
      repoRoot: fixture.repo,
      workspaceRoot: fixture.workspaces,
      targetRef: "origin/main",
    });

    const results = await manager.cleanup();

    expect(results).toEqual([]);
    expect((await lstat(unrelated)).isDirectory()).toBe(true);
  });

  it("rejects managed workspace roots inside the target repository", async () => {
    const fixture = await createRepositoryFixture();

    expect(
      () =>
        new GitIncidentWorkspaceManager({
          repoRoot: fixture.repo,
          workspaceRoot: join(fixture.repo, ".incident-worktrees"),
          targetRef: "origin/main",
        }),
    ).toThrow("outside the target repository");
  });
});

describe("workspaceIdentity", () => {
  it("creates deterministic path-safe attempt identities", () => {
    const identity = workspaceIdentity("../../Season Incident", 3);

    expect(identity).toMatch(
      /^season-incident-[0-9a-f]{10}-attempt-3$/,
    );
    expect(identity).not.toContain("..");
    expect(identity).not.toContain("/");
  });
});

async function createRepositoryFixture(): Promise<{
  repo: string;
  workspaces: string;
  baseSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "incident-workspace-test-"));
  temporaryRoots.push(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const workspaces = join(root, "workspaces");
  await mkdir(repo);
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await git(repo, "config", "user.name", "Incident Test");
  await git(repo, "config", "user.email", "incident@example.test");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await writeFile(join(repo, "package.json"), '{"private":true}\n');
  await mkdir(join(repo, "node_modules"));
  await writeFile(join(repo, "node_modules", "fixture-package"), "installed\n");
  await git(repo, "add", ".gitignore", "package.json");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  return { repo, workspaces, baseSha };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}
