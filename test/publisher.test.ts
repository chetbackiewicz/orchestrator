import { describe, expect, it } from "vitest";
import {
  CommandResult,
  GitHubIncidentPublisher,
  parseGitHubRepository,
  PublisherCommandRunner,
} from "../src/publisher/incident-publisher.js";
import { IncidentRecord } from "../src/pipeline/types.js";

function record(state: IncidentRecord["state"] = "verified_fixed"): IncidentRecord {
  return {
    input: {
      id: "incident-season",
      trigger: "manual",
      report: "season boundary is wrong",
      cwd: "/target",
    },
    state,
    totalTokens: 45,
    requestIds: ["assess", "investigate", "act"],
    events: [
      {
        at: "2026-01-01T00:00:00.000Z",
        kind: state,
        detail: "terminal",
      },
    ],
    assessment: {
      type: "logic",
      severity: "high",
      autonomy: "auto_fix",
      rationale: "bounded change",
    },
    hypothesis: {
      rootCause: "exclusive boundary",
      offendingCommit: "deadbeef",
      suspectFiles: ["src/season.ts"],
      proposedFix: "use an inclusive boundary",
    },
    claim: {
      status: state === "verified_fixed" ? "fixed" : "declined",
      summary:
        state === "verified_fixed" ? "fixed boundary" : "human review required",
      ...(state === "verified_fixed"
        ? { testPath: "test/season.test.ts" }
        : {}),
    },
    ...(state === "verified_fixed"
      ? {
          verification: {
            outcome: "verified",
            reproFailedBeforeFix: true,
            reproPassedAfterFix: true,
            fullSuitePassed: true,
            detail: "all verification gates passed",
            verifiedPaths: ["src/season.ts", "test/season.test.ts"],
          },
        }
      : {}),
  };
}

class FakeCommands implements PublisherCommandRunner {
  readonly calls: string[] = [];

  constructor(
    private readonly respond: (
      command: string,
      args: string[],
    ) => CommandResult,
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    return this.respond(command, args);
  }
}

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
});

describe("GitHubIncidentPublisher", () => {
  it("commits controlled verified changes, pushes a fix branch, and creates a PR and issue", async () => {
    let branchDiffCalls = 0;
    const commands = new FakeCommands((command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.startsWith("gh issue list")) return ok("[]");
      if (joined.startsWith("gh pr list")) return ok("[]");
      if (joined === "git status --porcelain=v1 -z --untracked-files=all") {
        return ok(" M src/season.ts\0?? test/season.test.ts\0");
      }
      if (joined === "git fetch --no-tags origin main") return ok();
      if (joined === "git rev-parse --verify --quiet origin/main") return ok();
      if (joined === "git diff --name-only origin/main...HEAD --") {
        branchDiffCalls += 1;
        return branchDiffCalls === 1
          ? ok()
          : ok("src/season.ts\ntest/season.test.ts\n");
      }
      if (joined === "git branch --show-current") return ok("agent-work\n");
      if (
        joined ===
        "git show-ref --verify --quiet refs/heads/incident-fix/incident-season"
      ) {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (joined.startsWith("git switch -c ")) return ok();
      if (joined.startsWith("git add -- ")) return ok();
      if (joined === "git diff --cached --name-only --") {
        return ok("src/season.ts\ntest/season.test.ts\n");
      }
      if (joined.startsWith("git commit ")) return ok();
      if (joined === "git rev-parse HEAD") return ok("abc123\n");
      if (joined.startsWith("git push --set-upstream origin ")) return ok();
      if (joined.startsWith("gh pr create")) {
        return ok("https://github.com/octo/service/pull/17\n");
      }
      if (joined.startsWith("gh issue create")) {
        const body = args[args.indexOf("--body") + 1];
        expect(body).toContain("## Original incident");
        expect(body).toContain("**Decision:** auto_fix");
        expect(body).toContain("**Offending commit:** deadbeef");
        expect(body).toContain("**Pre-fix reproduction failed:** true");
        expect(body).toContain("**Commit:** abc123");
        expect(body).toContain("**Request IDs:** assess, investigate, act");
        expect(body).toContain("## State transition history");
        return ok("https://github.com/octo/service/issues/23\n");
      }
      throw new Error(`Unexpected command: ${joined}`);
    });
    const publisher = new GitHubIncidentPublisher({
      repository: "octo/service",
      commandRunner: commands,
    });

    const result = await publisher.publish(record());

    expect(result).toMatchObject({
      status: "published",
      commitSha: "abc123",
      branch: "incident-fix/incident-season",
      prNumber: 17,
      issueNumber: 23,
    });
    expect(commands.calls).toContain(
      "git push --set-upstream origin incident-fix/incident-season",
    );
  });

  it("publishes from the pre-created managed branch without switching branches", async () => {
    const managed = record();
    managed.input.workspaceBranch =
      "incident-fix/incident-season-managed-attempt-2";
    let branchDiffCalls = 0;
    const commands = new FakeCommands((command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.startsWith("gh issue list")) return ok("[]");
      if (joined.startsWith("gh pr list")) return ok("[]");
      if (joined === "git status --porcelain=v1 -z --untracked-files=all") {
        return ok(" M src/season.ts\0?? test/season.test.ts\0");
      }
      if (joined === "git fetch --no-tags origin main") return ok();
      if (joined === "git rev-parse --verify --quiet origin/main") return ok();
      if (joined === "git diff --name-only origin/main...HEAD --") {
        branchDiffCalls += 1;
        return branchDiffCalls === 1
          ? ok()
          : ok("src/season.ts\ntest/season.test.ts\n");
      }
      if (joined === "git branch --show-current") {
        return ok(`${managed.input.workspaceBranch}\n`);
      }
      if (joined.startsWith("git add -- ")) return ok();
      if (joined === "git diff --cached --name-only --") {
        return ok("src/season.ts\ntest/season.test.ts\n");
      }
      if (joined.startsWith("git commit ")) return ok();
      if (joined === "git rev-parse HEAD") return ok("def456\n");
      if (
        joined ===
        `git push --set-upstream origin ${managed.input.workspaceBranch}`
      ) {
        return ok();
      }
      if (joined.startsWith("gh pr create")) {
        return ok("https://github.com/octo/service/pull/18\n");
      }
      if (joined.startsWith("gh issue create")) {
        return ok("https://github.com/octo/service/issues/24\n");
      }
      throw new Error(`Unexpected command: ${joined}`);
    });
    const publisher = new GitHubIncidentPublisher({
      repository: "octo/service",
      commandRunner: commands,
    });

    const result = await publisher.publish(managed);

    expect(result).toMatchObject({
      status: "published",
      branch: managed.input.workspaceBranch,
      commitSha: "def456",
    });
    expect(
      commands.calls.some((call) => call.startsWith("git switch")),
    ).toBe(false);
  });

  it("refuses publication when a managed workspace is on another branch", async () => {
    const managed = record();
    managed.input.workspaceBranch =
      "incident-fix/incident-season-managed-attempt-2";
    const commands = new FakeCommands((command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.startsWith("gh issue list")) return ok("[]");
      if (joined.startsWith("gh pr list")) return ok("[]");
      if (joined === "git status --porcelain=v1 -z --untracked-files=all") {
        return ok(" M src/season.ts\0?? test/season.test.ts\0");
      }
      if (joined === "git fetch --no-tags origin main") return ok();
      if (joined === "git rev-parse --verify --quiet origin/main") return ok();
      if (joined === "git diff --name-only origin/main...HEAD --") return ok();
      if (joined === "git branch --show-current") return ok("main\n");
      if (joined.startsWith("gh issue create")) {
        expect(args.join(" ")).toContain(
          "Managed workspace is on branch main",
        );
        return ok("https://github.com/octo/service/issues/25\n");
      }
      throw new Error(`Unexpected command: ${joined}`);
    });
    const publisher = new GitHubIncidentPublisher({
      repository: "octo/service",
      commandRunner: commands,
    });

    const result = await publisher.publish(managed);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("expected incident-fix/");
    expect(
      commands.calls.some((call) => call.startsWith("git switch")),
    ).toBe(false);
  });

  it.each(["escalated", "needs_human", "failed", "budget_exceeded"] as const)(
    "creates only an evidence issue for %s outcomes",
    async (state) => {
    const commands = new FakeCommands((command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.startsWith("gh issue list")) return ok("[]");
      if (joined.startsWith("gh pr list")) return ok("[]");
      if (joined.startsWith("gh issue create")) {
        return ok("https://github.com/octo/service/issues/24\n");
      }
      throw new Error(`Unexpected command: ${joined}`);
    });
    const publisher = new GitHubIncidentPublisher({
      repository: "octo/service",
      commandRunner: commands,
    });

      const result = await publisher.publish(record(state));

      expect(result.status).toBe("issue_only");
      expect(result.issueNumber).toBe(24);
      expect(commands.calls.some((call) => call.includes("pr create"))).toBe(
        false,
      );
    },
  );

  it("is idempotent when marker-matched issue and PR already exist", async () => {
    const marker = "<!-- incident-orchestrator:id=incident-season -->";
    const commands = new FakeCommands((_command, args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(
          JSON.stringify([
            {
              number: 23,
              url: "https://github.com/octo/service/issues/23",
              body: marker,
            },
          ]),
        );
      }
      if (args[0] === "pr" && args[1] === "list") {
        return ok(
          JSON.stringify([
            {
              number: 17,
              url: "https://github.com/octo/service/pull/17",
              body: marker,
              headRefName: "incident-fix/incident-season",
              headRefOid: "abc123",
            },
          ]),
        );
      }
      if (args[0] === "issue" && args[1] === "edit") return ok();
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    const publisher = new GitHubIncidentPublisher({
      repository: "octo/service",
      commandRunner: commands,
    });

    const result = await publisher.publish(record());

    expect(result.status).toBe("published");
    expect(commands.calls.some((call) => call.includes("issue create"))).toBe(
      false,
    );
    expect(commands.calls.some((call) => call.includes("pr create"))).toBe(
      false,
    );
  });

  it("rejects unrelated dirty files but still creates the incident issue", async () => {
    const commands = new FakeCommands((command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.startsWith("gh issue list")) return ok("[]");
      if (joined.startsWith("gh pr list")) return ok("[]");
      if (joined === "git status --porcelain=v1 -z --untracked-files=all") {
        return ok(" M src/season.ts\0?? test/season.test.ts\0 M README.md\0");
      }
      if (joined.startsWith("gh issue create")) {
        expect(args.join(" ")).toContain("Refusing publication with unrelated");
        return ok("https://github.com/octo/service/issues/25\n");
      }
      throw new Error(`Unexpected command: ${joined}`);
    });
    const publisher = new GitHubIncidentPublisher({
      repository: "octo/service",
      commandRunner: commands,
    });

    const result = await publisher.publish(record());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("README.md");
    expect(commands.calls.some((call) => call.startsWith("git add"))).toBe(false);
    expect(commands.calls.some((call) => call.includes("pr create"))).toBe(false);
  });

  it("derives GitHub repositories from HTTPS and SSH remotes", () => {
    expect(
      parseGitHubRepository("https://github.com/octo/service.git"),
    ).toBe("octo/service");
    expect(parseGitHubRepository("git@github.com:octo/service.git")).toBe(
      "octo/service",
    );
  });
});
