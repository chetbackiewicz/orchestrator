import { spawn } from "node:child_process";
import { validatePublishablePaths } from "../pipeline/change-policy.js";
import {
  IncidentRecord,
  PublicationMetadata,
} from "../pipeline/types.js";

export interface IncidentPublisher {
  readonly baseBranch: string;
  publish(record: IncidentRecord): Promise<PublicationMetadata>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PublisherCommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export interface GitHubIncidentPublisherConfig {
  baseBranch?: string;
  repository?: string;
  remote?: string;
  commandRunner?: PublisherCommandRunner;
}

interface GitHubObject {
  number: number;
  url: string;
  body: string;
}

interface GitHubPullRequest extends GitHubObject {
  headRefName: string;
  headRefOid: string;
}

interface PublishedFix {
  commitSha: string;
  branch: string;
  prUrl: string;
  prNumber: number;
}

export class GitHubIncidentPublisher implements IncidentPublisher {
  readonly baseBranch: string;
  private readonly remote: string;
  private readonly commands: PublisherCommandRunner;

  constructor(private readonly config: GitHubIncidentPublisherConfig = {}) {
    this.baseBranch = config.baseBranch ?? "main";
    this.remote = config.remote ?? "origin";
    this.commands = config.commandRunner ?? defaultPublisherCommandRunner;
  }

  async publish(record: IncidentRecord): Promise<PublicationMetadata> {
    const repository =
      this.config.repository ?? (await this.deriveRepository(record.input.cwd));
    const marker = incidentMarker(record.input.id);
    const [existingIssue, existingPr] = await Promise.all([
      this.findIssue(repository, marker, record.input.cwd),
      this.findPullRequest(repository, marker, record.input.cwd),
    ]);

    if (record.state !== "verified_fixed") {
      const body = issueBody(record, marker);
      const issue = existingIssue
        ? await this.updateIssue(
            repository,
            existingIssue,
            body,
            record.input.cwd,
          )
        : await this.createIssue(repository, record, body, record.input.cwd);
      return {
        status: "issue_only",
        repository,
        baseBranch: this.baseBranch,
        issueUrl: issue.url,
        issueNumber: issue.number,
      };
    }

    if (existingIssue && existingPr) {
      const fix = {
        commitSha: existingPr.headRefOid,
        branch: existingPr.headRefName,
        prUrl: existingPr.url,
        prNumber: existingPr.number,
      };
      const issue = await this.updateIssue(
        repository,
        existingIssue,
        issueBody(record, marker, fix),
        record.input.cwd,
      );
      return {
        status: "published",
        repository,
        baseBranch: this.baseBranch,
        commitSha: existingPr.headRefOid,
        branch: existingPr.headRefName,
        prUrl: existingPr.url,
        prNumber: existingPr.number,
        issueUrl: issue.url,
        issueNumber: issue.number,
      };
    }

    let fix: PublishedFix | undefined = existingPr
      ? {
          commitSha: existingPr.headRefOid,
          branch: existingPr.headRefName,
          prUrl: existingPr.url,
          prNumber: existingPr.number,
        }
      : undefined;
    let publicationError: string | undefined;
    if (!fix) {
      try {
        fix = await this.publishVerifiedFix(repository, record, marker);
      } catch (error) {
        publicationError = formatError(error);
      }
    }

    const body = issueBody(record, marker, fix, publicationError);
    const issue = existingIssue
      ? await this.updateIssue(
          repository,
          existingIssue,
          body,
          record.input.cwd,
        )
      : await this.createIssue(repository, record, body, record.input.cwd);

    return {
      status: publicationError ? "failed" : "published",
      repository,
      baseBranch: this.baseBranch,
      ...(fix
        ? {
            commitSha: fix.commitSha,
            branch: fix.branch,
            prUrl: fix.prUrl,
            prNumber: fix.prNumber,
          }
        : {}),
      issueUrl: issue.url,
      issueNumber: issue.number,
      ...(publicationError ? { error: publicationError } : {}),
    };
  }

  private async publishVerifiedFix(
    repository: string,
    record: IncidentRecord,
    marker: string,
  ): Promise<PublishedFix> {
    const testPath = record.claim?.testPath;
    const verifiedPaths = record.verification?.verifiedPaths;
    if (!testPath || !verifiedPaths?.length) {
      throw new Error(
        "Verified publication requires the exact verified path set and reproduction test path.",
      );
    }
    const violations = validatePublishablePaths(verifiedPaths, testPath);
    if (violations.length > 0) {
      throw new Error(
        `Verified path set contains protected or unrelated paths: ${violations.join(", ")}`,
      );
    }

    const cwd = record.input.cwd;
    const dirtyPaths = await this.workingTreePaths(cwd);
    const unexpectedDirty = dirtyPaths.filter(
      (path) => !verifiedPaths.includes(path),
    );
    if (unexpectedDirty.length > 0) {
      throw new Error(
        `Refusing publication with unrelated working-tree changes: ${unexpectedDirty.join(", ")}`,
      );
    }

    await this.mustRun(
      "git",
      ["fetch", "--no-tags", this.remote, this.baseBranch],
      cwd,
    );
    const baseRef = await this.resolveBaseRef(cwd);
    const existingCommittedPaths = splitLines(
      (
        await this.mustRun(
          "git",
          ["diff", "--name-only", `${baseRef}...HEAD`, "--"],
          cwd,
        )
      ).stdout,
    );
    assertSubsetPaths(existingCommittedPaths, verifiedPaths, "existing commits");

    const branch =
      record.input.workspaceBranch ??
      `incident-fix/${slug(record.input.id)}`;
    const currentBranch = (
      await this.mustRun("git", ["branch", "--show-current"], cwd)
    ).stdout.trim();
    if (record.input.workspaceBranch && currentBranch !== branch) {
      throw new Error(
        `Managed workspace is on branch ${currentBranch || "(detached)"}, expected ${branch}.`,
      );
    }
    if (!record.input.workspaceBranch && currentBranch !== branch) {
      const branchExists = await this.commands.run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        cwd,
      );
      await this.mustRun(
        "git",
        branchExists.code === 0
          ? ["switch", branch]
          : ["switch", "-c", branch],
        cwd,
      );
    }

    if (dirtyPaths.length > 0) {
      await this.mustRun("git", ["add", "--", ...dirtyPaths], cwd);
      const staged = splitLines(
        (
          await this.mustRun(
            "git",
            ["diff", "--cached", "--name-only", "--"],
            cwd,
          )
        ).stdout,
      );
      assertSamePaths(staged, dirtyPaths, "staged");
      await this.mustRun(
        "git",
        [
          "commit",
          "-m",
          `fix: resolve incident ${record.input.id}`,
          "-m",
          "Produced by incident-orchestrator after independent verification.",
        ],
        cwd,
      );
    }

    const committedPaths = splitLines(
      (
        await this.mustRun(
          "git",
          ["diff", "--name-only", `${baseRef}...HEAD`, "--"],
          cwd,
        )
      ).stdout,
    );
    assertSamePaths(committedPaths, verifiedPaths, "committed");
    const commitSha = (
      await this.mustRun("git", ["rev-parse", "HEAD"], cwd)
    ).stdout.trim();

    await this.mustRun(
      "git",
      ["push", "--set-upstream", this.remote, branch],
      cwd,
    );
    const title = `Fix incident ${record.input.id}`;
    const body = pullRequestBody(record, marker, commitSha, this.baseBranch);
    const created = await this.mustRun(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        this.baseBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
      cwd,
    );
    const prUrl = created.stdout.trim();
    return {
      commitSha,
      branch,
      prUrl,
      prNumber: parseGitHubNumber(prUrl, "pull"),
    };
  }

  private async deriveRepository(cwd: string): Promise<string> {
    const remote = (
      await this.mustRun("git", ["remote", "get-url", this.remote], cwd)
    ).stdout.trim();
    const repository = parseGitHubRepository(remote);
    if (!repository) {
      throw new Error(
        `Unable to derive a GitHub owner/repository from remote ${this.remote}: ${remote}`,
      );
    }
    return repository;
  }

  private async resolveBaseRef(cwd: string): Promise<string> {
    const remoteRef = `${this.remote}/${this.baseBranch}`;
    const result = await this.commands.run(
      "git",
      ["rev-parse", "--verify", "--quiet", remoteRef],
      cwd,
    );
    return result.code === 0 ? remoteRef : this.baseBranch;
  }

  private async workingTreePaths(cwd: string): Promise<string[]> {
    const result = await this.mustRun(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd,
    );
    return parseStatusPaths(result.stdout);
  }

  private async findIssue(
    repository: string,
    marker: string,
    cwd: string,
  ): Promise<GitHubObject | undefined> {
    const result = await this.mustRun(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--limit",
        "10",
        "--search",
        markerSearch(marker),
        "--json",
        "number,url,body",
      ],
      cwd,
    );
    return parseObjects<GitHubObject>(result.stdout).find((item) =>
      item.body.includes(marker),
    );
  }

  private async findPullRequest(
    repository: string,
    marker: string,
    cwd: string,
  ): Promise<GitHubPullRequest | undefined> {
    const result = await this.mustRun(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--limit",
        "10",
        "--search",
        markerSearch(marker),
        "--json",
        "number,url,body,headRefName,headRefOid",
      ],
      cwd,
    );
    return parseObjects<GitHubPullRequest>(result.stdout).find((item) =>
      item.body.includes(marker),
    );
  }

  private async createIssue(
    repository: string,
    record: IncidentRecord,
    body: string,
    cwd: string,
  ): Promise<GitHubObject> {
    const result = await this.mustRun(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        `Incident ${record.input.id}: ${record.state}`,
        "--body",
        body,
      ],
      cwd,
    );
    const url = result.stdout.trim();
    return { number: parseGitHubNumber(url, "issues"), url, body };
  }

  private async updateIssue(
    repository: string,
    issue: GitHubObject,
    body: string,
    cwd: string,
  ): Promise<GitHubObject> {
    if (issue.body === body) return issue;
    await this.mustRun(
      "gh",
      [
        "issue",
        "edit",
        String(issue.number),
        "--repo",
        repository,
        "--body",
        body,
      ],
      cwd,
    );
    return { ...issue, body };
  }

  private async mustRun(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<CommandResult> {
    const result = await this.commands.run(command, args, cwd);
    if (result.code !== 0) {
      throw new Error(
        `${formatCommand(command, args)} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
      );
    }
    return result;
  }
}

export const defaultPublisherCommandRunner: PublisherCommandRunner = {
  run(command, args, cwd) {
    return new Promise((resolveResult) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        resolveResult({ code: 1, stdout, stderr: formatError(error) });
      });
      child.on("close", (code) => {
        resolveResult({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};

export function parseGitHubRepository(remote: string): string | undefined {
  const scp = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (scp?.[1]) return scp[1];
  try {
    const url = new URL(remote);
    if (url.hostname !== "github.com") return undefined;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return /^[^/]+\/[^/]+$/.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function incidentMarker(id: string): string {
  return `<!-- incident-orchestrator:id=${id} -->`;
}

function markerSearch(marker: string): string {
  return `"${marker.slice(5, -4)}" in:body`;
}

function issueBody(
  record: IncidentRecord,
  marker: string,
  fix?: PublishedFix,
  publicationError?: string,
): string {
  const verification = record.verification;
  return [
    marker,
    "## Original incident",
    `- **Incident ID:** ${record.input.id}`,
    `- **Trigger:** ${record.input.trigger}`,
    `- **Report:** ${record.input.report}`,
    "",
    "## Assessment and autonomy",
    record.assessment
      ? `- **Type/severity:** ${record.assessment.type} / ${record.assessment.severity}\n- **Decision:** ${record.assessment.autonomy}\n- **Rationale:** ${record.assessment.rationale}`
      : "- Assessment unavailable.",
    "",
    "## Investigation",
    record.hypothesis
      ? `- **Root-cause hypothesis:** ${record.hypothesis.rootCause}\n- **Offending commit:** ${record.hypothesis.offendingCommit ?? "Unknown"}\n- **Suspect files:** ${record.hypothesis.suspectFiles.join(", ") || "None recorded"}\n- **Proposed fix:** ${record.hypothesis.proposedFix}`
      : "- Investigation was not completed.",
    "",
    "## Outcome",
    `- **State:** ${record.state}`,
    `- **Fix summary:** ${record.claim?.summary ?? "No fix was produced."}`,
    `- **Recommended mitigation:** ${record.claim?.recommendedMitigation ?? "N/A"}`,
    publicationError
      ? `- **Publication failure:** ${publicationError}`
      : "- **Publication failure:** None",
    "",
    "## Independent verification",
    verification
      ? [
          `- **Pre-fix reproduction failed:** ${verification.reproFailedBeforeFix}`,
          `- **Post-fix reproduction passed:** ${verification.reproPassedAfterFix}`,
          `- **Full suite passed:** ${verification.fullSuitePassed}`,
          `- **Result:** ${verification.outcome}`,
          "",
          "```text",
          verification.detail,
          "```",
        ].join("\n")
      : "- Verification was not reached.",
    "",
    "## Published change",
    fix
      ? `- **Commit:** ${fix.commitSha}\n- **Branch:** ${fix.branch}\n- **Pull request:** ${fix.prUrl} (#${fix.prNumber})`
      : "- No fix pull request was published.",
    "",
    "## Correlation",
    `- **Total tokens:** ${record.totalTokens}`,
    `- **Request IDs:** ${record.requestIds.join(", ") || "None"}`,
    "",
    "## State transition history",
    ...record.events.map(
      (event) => `- ${event.at} - \`${event.kind}\`: ${event.detail || "N/A"}`,
    ),
  ].join("\n");
}

function pullRequestBody(
  record: IncidentRecord,
  marker: string,
  commitSha: string,
  baseBranch: string,
): string {
  return [
    marker,
    `Fixes independently verified incident \`${record.input.id}\`.`,
    "",
    `**Report:** ${record.input.report}`,
    `**Fix:** ${record.claim?.summary ?? "See commit."}`,
    `**Commit:** ${commitSha}`,
    "",
    "Verification confirmed the reproduction failed before the fix, passed after",
    "the fix, and the full suite passed. The orchestrator did not merge or push",
    `directly to \`${baseBranch}\`.`,
  ].join("\n");
}

function parseStatusPaths(output: string): string[] {
  const parts = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.length < 4 || part[2] !== " ") {
      throw new Error(`Unexpected git status entry: ${JSON.stringify(part)}`);
    }
    const status = part.slice(0, 2);
    if (/[RC]/.test(status)) {
      throw new Error(`Renamed or copied working-tree path is not publishable.`);
    }
    paths.push(part.slice(3));
  }
  return paths;
}

function parseObjects<T>(text: string): T[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array from GitHub CLI.");
  }
  return parsed as T[];
}

function parseGitHubNumber(url: string, kind: "issues" | "pull"): number {
  const match = url.match(new RegExp(`/${kind}/(\\d+)(?:$|[?#])`));
  if (!match?.[1]) throw new Error(`Unable to parse GitHub URL: ${url}`);
  return Number(match[1]);
}

function assertSamePaths(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (
    left.length !== right.length ||
    left.some((path, index) => path !== right[index])
  ) {
    throw new Error(
      `Refusing publication because ${label} paths differ from verified paths: ${left.join(", ") || "none"}`,
    );
  }
}

function assertSubsetPaths(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  const unexpected = [...new Set(actual)].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing publication because ${label} contain unverified paths: ${unexpected.join(", ")}`,
    );
  }
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized) {
    throw new Error(`Incident ID cannot form a branch name: ${value}`);
  }
  return normalized;
}

function formatCommand(command: string, args: readonly string[]): string {
  const safeArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--body") {
      safeArgs.push(arg, "<redacted>");
      index += 1;
    } else if (arg !== undefined) {
      safeArgs.push(arg);
    }
  }
  return `${command} ${safeArgs.join(" ")}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
