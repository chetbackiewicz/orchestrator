import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/runner.js";
import {
  IncidentRecord,
  IncidentState,
} from "../src/pipeline/types.js";
import {
  ClaimedIncident,
  CompleteRequest,
  FailRequest,
  IncidentQueueClient,
  LeaseRequest,
  QueueClientError,
} from "../src/queue/client.js";
import {
  completionResult,
  IncidentQueueWorker,
} from "../src/queue/worker.js";
import {
  FixedIncidentWorkspaceManager,
  IncidentWorkspace,
  IncidentWorkspaceManager,
  WorkspaceDisposition,
  WorkspaceReleaseResult,
} from "../src/workspace/manager.js";

const runner: AgentRunner = {
  kind: "stub",
  async open() {
    throw new Error("Injected triage should not open a runner");
  },
};

function claimed(
  id = "incident-season",
  payload: Record<string, unknown> = {
    trigger: "manual",
    report: "season boundary is wrong",
  },
): ClaimedIncident {
  return {
    incident: {
      id,
      idempotencyKey: `ui:${id}`,
      summary: "Incorrect season recommendation",
      payload,
      status: "processing",
      attemptCount: 2,
      createdAt: "2026-09-16T17:20:00.000Z",
      updatedAt: "2026-09-16T17:20:00.000Z",
    },
    claim: {
      token: `token:${id}`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  };
}

function record(
  id: string,
  state: IncidentState = "verified_fixed",
): IncidentRecord {
  return {
    input: {
      id,
      trigger: "manual",
      report: "season boundary is wrong",
      cwd: "/trusted/emerald-osprey",
    },
    state,
    totalTokens: 42,
    requestIds: ["request-1"],
    events: [],
    assessment: {
      type: "logic",
      severity: "high",
      autonomy: "auto_fix",
      rationale: "bounded",
    },
  };
}

class FakeQueueClient implements IncidentQueueClient {
  readonly leases: LeaseRequest[] = [];
  readonly completions: CompleteRequest[] = [];
  readonly failures: FailRequest[] = [];
  readonly claims: ClaimedIncident[];
  completeFailures = 0;
  staleLease = false;
  onComplete: (() => void) | undefined;

  constructor(...claims: ClaimedIncident[]) {
    this.claims = claims;
  }

  async claim(): Promise<ClaimedIncident | undefined> {
    return this.claims.shift();
  }

  async renewLease(
    _incidentId: string,
    request: LeaseRequest,
  ): Promise<{ expiresAt: string }> {
    this.leases.push(request);
    if (this.staleLease) {
      throw new QueueClientError("stale", {
        status: 409,
        staleClaim: true,
      });
    }
    return {
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  }

  async complete(
    _incidentId: string,
    request: CompleteRequest,
  ): Promise<void> {
    this.completions.push(request);
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      throw new QueueClientError("temporary", { retryable: true });
    }
    this.onComplete?.();
  }

  async fail(
    _incidentId: string,
    request: FailRequest,
  ): Promise<{ status: "failed" }> {
    this.failures.push(request);
    return { status: "failed" };
  }
}

class FakeWorkspaceManager implements IncidentWorkspaceManager {
  readonly acquisitions: Array<{
    incidentId: string;
    attemptCount: number;
  }> = [];
  readonly releases: Array<{
    workspace: IncidentWorkspace;
    disposition: WorkspaceDisposition;
  }> = [];
  acquireError: Error | undefined;
  onRelease: (() => void) | undefined;

  constructor(
    readonly workspace: IncidentWorkspace = {
      cwd: "/managed/incident-season",
      preFixRef: "abc123",
      branch: "incident-fix/incident-season-attempt-2",
    },
  ) {}

  async acquire(
    incidentId: string,
    attemptCount: number,
  ): Promise<IncidentWorkspace> {
    this.acquisitions.push({ incidentId, attemptCount });
    if (this.acquireError) throw this.acquireError;
    return this.workspace;
  }

  async release(
    workspace: IncidentWorkspace,
    disposition: WorkspaceDisposition,
  ): Promise<WorkspaceReleaseResult> {
    this.releases.push({ workspace, disposition });
    this.onRelease?.();
    return { removed: disposition === "published" };
  }
}

function makeWorker(
  client: FakeQueueClient,
  overrides: Partial<
    ConstructorParameters<typeof IncidentQueueWorker>[0]
  > = {},
): IncidentQueueWorker {
  return new IncidentQueueWorker({
    client,
    workerId: "worker-1",
    workspaceManager: new FixedIncidentWorkspaceManager(
      "/trusted/emerald-osprey",
      "main",
    ),
    pollIntervalMs: 5_000,
    leaseSeconds: 120,
    heartbeatIntervalMs: 30_000,
    runner,
    store: { async put() {} },
    orchestratorConfig: {
      maxTokensPerIncident: 100,
    },
    sleep: async () => {},
    random: () => 0,
    ...overrides,
  });
}

describe("IncidentQueueWorker", () => {
  it("maps trusted triage input, publishes progress, persists, then completes", async () => {
    const client = new FakeQueueClient(claimed());
    const order: string[] = [];
    let seenInput: IncidentRecord["input"] | undefined;
    const worker = makeWorker(client, {
      store: {
        async put() {
          order.push("persist");
        },
      },
      triage: async (input, _runner, config) => {
        seenInput = input;
        const investigating = record(input.id, "investigating");
        config.onStateChange?.(investigating);
        return record(input.id);
      },
    });

    client.onComplete = () => order.push("complete");

    await expect(
      worker.processNext(new AbortController().signal),
    ).resolves.toBe(true);

    expect(seenInput).toEqual({
      id: "incident-season",
      trigger: "manual",
      report: "season boundary is wrong",
      cwd: "/trusted/emerald-osprey",
    });
    expect(client.leases).toHaveLength(1);
    expect(client.leases[0]?.status).toMatchObject({
      state: "investigating",
      totalTokens: 42,
    });
    expect(order).toEqual(["persist", "complete"]);
    expect(client.completions[0]).toMatchObject({
      callbackId: "incident-season:2:complete",
      outcome: "resolved",
      result: { state: "verified_fixed" },
    });
    expect(client.completions[0]?.result).not.toHaveProperty("input");
  });

  it("uses an acquired managed workspace and its immutable pre-fix ref", async () => {
    const client = new FakeQueueClient(claimed());
    const workspaceManager = new FakeWorkspaceManager();
    let seenInput: IncidentRecord["input"] | undefined;
    let seenPreFixRef: string | undefined;
    const worker = makeWorker(client, {
      workspaceManager,
      triage: async (input, _runner, config) => {
        seenInput = input;
        seenPreFixRef = config.preFixRef;
        return record(input.id);
      },
    });

    await worker.processNext(new AbortController().signal);

    expect(workspaceManager.acquisitions).toEqual([
      { incidentId: "incident-season", attemptCount: 2 },
    ]);
    expect(seenInput).toEqual({
      id: "incident-season",
      trigger: "manual",
      report: "season boundary is wrong",
      cwd: "/managed/incident-season",
      workspaceBranch: "incident-fix/incident-season-attempt-2",
    });
    expect(seenPreFixRef).toBe("abc123");
    expect(workspaceManager.releases).toEqual([
      {
        workspace: workspaceManager.workspace,
        disposition: "completed",
      },
    ]);
  });

  it("reports workspace acquisition failures without starting triage", async () => {
    const client = new FakeQueueClient(claimed());
    const workspaceManager = new FakeWorkspaceManager();
    workspaceManager.acquireError = new Error("git worktree failed");
    const triage = vi.fn();
    const worker = makeWorker(client, { workspaceManager, triage });

    await worker.processNext(new AbortController().signal);

    expect(triage).not.toHaveBeenCalled();
    expect(client.failures).toEqual([
      expect.objectContaining({
        retryable: true,
        error:
          "Unable to prepare incident workspace: git worktree failed",
      }),
    ]);
    expect(workspaceManager.releases).toHaveLength(0);
  });

  it("acknowledges completion before releasing a managed workspace", async () => {
    const client = new FakeQueueClient(claimed());
    const workspaceManager = new FakeWorkspaceManager();
    const order: string[] = [];
    client.onComplete = () => order.push("complete");
    workspaceManager.onRelease = () => order.push("release");
    const worker = makeWorker(client, {
      workspaceManager,
      triage: async (input) => record(input.id),
    });

    await worker.processNext(new AbortController().signal);

    expect(order).toEqual(["complete", "release"]);
  });

  it("preserves managed workspaces when triage infrastructure fails", async () => {
    const client = new FakeQueueClient(claimed());
    const workspaceManager = new FakeWorkspaceManager();
    const worker = makeWorker(client, {
      workspaceManager,
      triage: async () => {
        throw new Error("agent unavailable");
      },
    });

    await worker.processNext(new AbortController().signal);

    expect(client.failures).toHaveLength(1);
    expect(workspaceManager.releases[0]?.disposition).toBe("failed");
  });

  it("marks published workspaces safe for cleanup", async () => {
    const client = new FakeQueueClient(claimed());
    const workspaceManager = new FakeWorkspaceManager();
    const worker = makeWorker(client, {
      workspaceManager,
      triage: async (input) => ({
        ...record(input.id),
        publication: {
          status: "published",
          baseBranch: "main",
          branch: workspaceManager.workspace.branch!,
        },
      }),
    });

    await worker.processNext(new AbortController().signal);

    expect(workspaceManager.releases[0]?.disposition).toBe("published");
  });

  it("rejects invalid ticket payloads without starting triage", async () => {
    const client = new FakeQueueClient(
      claimed("incident-invalid", {
        trigger: "scheduled",
        report: "",
      }),
    );
    const triage = vi.fn();
    const worker = makeWorker(client, { triage });

    await worker.processNext(new AbortController().signal);

    expect(triage).not.toHaveBeenCalled();
    expect(client.failures).toEqual([
      expect.objectContaining({
        callbackId: "incident-invalid:2:fail",
        retryable: false,
        error: "payload.trigger must be manual or automated",
      }),
    ]);
  });

  it("persists but does not complete after losing the claim", async () => {
    const client = new FakeQueueClient(claimed());
    client.staleLease = true;
    const put = vi.fn();
    const worker = makeWorker(client, {
      store: { put },
      triage: async (input, _runner, config) => {
        config.onStateChange?.(record(input.id, "assessing"));
        return record(input.id);
      },
    });

    await worker.processNext(new AbortController().signal);

    expect(put).toHaveBeenCalledOnce();
    expect(client.completions).toHaveLength(0);
  });

  it("retries ambiguous completion with the same callback id", async () => {
    const client = new FakeQueueClient(claimed());
    client.completeFailures = 1;
    const worker = makeWorker(client, {
      triage: async (input) => record(input.id),
    });

    await worker.processNext(new AbortController().signal);

    expect(client.completions).toHaveLength(2);
    expect(client.completions[0]?.callbackId).toBe(
      client.completions[1]?.callbackId,
    );
  });

  it("reports persistence failures as retryable worker failures", async () => {
    const client = new FakeQueueClient(claimed());
    const worker = makeWorker(client, {
      store: {
        async put() {
          throw new Error("disk unavailable");
        },
      },
      triage: async (input) => record(input.id),
    });

    await worker.processNext(new AbortController().signal);

    expect(client.completions).toHaveLength(0);
    expect(client.failures).toEqual([
      expect.objectContaining({
        callbackId: "incident-season:2:fail",
        retryable: true,
        retryAfterSeconds: 30,
        error: "Unable to persist triage result: disk unavailable",
      }),
    ]);
  });

  it("renews the active lease periodically", async () => {
    const client = new FakeQueueClient(claimed());
    const worker = makeWorker(client, {
      heartbeatIntervalMs: 10,
      triage: async (input, _runner, config) => {
        config.onStateChange?.(record(input.id, "investigating"));
        await new Promise((resolve) => setTimeout(resolve, 35));
        return record(input.id);
      },
    });

    await worker.processNext(new AbortController().signal);

    expect(client.leases.length).toBeGreaterThanOrEqual(2);
  });

  it("bounds progress summaries to the Emerald contract limit", async () => {
    const client = new FakeQueueClient(claimed());
    const worker = makeWorker(client, {
      triage: async (input, _runner, config) => {
        const next = {
          ...record(input.id, "needs_human"),
          verification: {
            outcome: "rejected" as const,
            reproFailedBeforeFix: true,
            reproPassedAfterFix: false,
            fullSuitePassed: false,
            detail: "x".repeat(2_500),
          },
        };
        config.onStateChange?.(next);
        return next;
      },
    });

    await worker.processNext(new AbortController().signal);

    expect(client.leases[0]?.status.summary).toHaveLength(2_000);
  });

  it("processes claims serially", async () => {
    const controller = new AbortController();
    const client = new FakeQueueClient(
      claimed("incident-one"),
      claimed("incident-two"),
    );
    let active = 0;
    let maximumActive = 0;
    client.onComplete = () => {
      if (client.completions.length === 2) controller.abort();
    };
    const worker = makeWorker(client, {
      triage: async (input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return record(input.id);
      },
    });

    await worker.run(controller.signal);

    expect(maximumActive).toBe(1);
    expect(client.completions.map((item) => item.callbackId)).toEqual([
      "incident-one:2:complete",
      "incident-two:2:complete",
    ]);
  });

  it("drains the active incident after shutdown is requested", async () => {
    const controller = new AbortController();
    const client = new FakeQueueClient(claimed());
    const worker = makeWorker(client, {
      triage: async (input) => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return record(input.id);
      },
    });

    await worker.run(controller.signal);

    expect(client.completions).toHaveLength(1);
  });
});

describe("completionResult", () => {
  it("removes the local incident input", () => {
    expect(completionResult(record("incident-season"))).not.toHaveProperty(
      "input",
    );
  });

  it("compacts streamed events and long details below the queue body limit", () => {
    const large = record("incident-large");
    large.events = Array.from({ length: 500 }, (_, index) => ({
      at: "2026-09-16T17:20:00.000Z",
      kind: index % 2 === 0 ? "event:assistant" : "investigating",
      detail: "x".repeat(2_000),
    }));
    large.verification = {
      outcome: "verified",
      reproFailedBeforeFix: true,
      reproPassedAfterFix: true,
      fullSuitePassed: true,
      detail: "y".repeat(40_000),
    };

    const result = completionResult(large);

    expect(result.events).toHaveLength(12);
    expect(result.events.every((event) => event.kind === "investigating")).toBe(
      true,
    );
    expect(JSON.stringify(result).length).toBeLessThan(32_000);
  });
});
