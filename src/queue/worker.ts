import { AgentRunner, RunEvent } from "../agent/runner.js";
import {
  OrchestratorConfig,
  triageIncident,
} from "../pipeline/orchestrator.js";
import {
  IncidentInput,
  IncidentRecord,
  Trigger,
} from "../pipeline/types.js";
import {
  ClaimedIncident,
  CompleteRequest,
  FailRequest,
  IncidentCompletionResult,
  IncidentProgress,
  IncidentQueueClient,
  QueueClientError,
} from "./client.js";
import {
  IncidentWorkspace,
  IncidentWorkspaceManager,
  WorkspaceDisposition,
  WorkspaceReleaseResult,
} from "../workspace/manager.js";

export interface IncidentRecordStore {
  put(record: IncidentRecord): Promise<void>;
}

export interface IncidentQueueWorkerOptions {
  client: IncidentQueueClient;
  workerId: string;
  workspaceManager: IncidentWorkspaceManager;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  runner: AgentRunner;
  orchestratorConfig: Omit<
    OrchestratorConfig,
    "onEvent" | "onStateChange" | "preFixRef"
  >;
  store: IncidentRecordStore;
  onEvent?: (incidentId: string, event: RunEvent) => void;
  onStateChange?: (record: IncidentRecord) => void;
  onError?: (error: Error) => void;
  onWorkspaceRelease?: (
    workspace: IncidentWorkspace,
    result: WorkspaceReleaseResult,
  ) => void;
  triage?: typeof triageIncident;
  now?: () => string;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class IncidentQueueWorker {
  private readonly triage: typeof triageIncident;
  private readonly now: () => string;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: IncidentQueueWorkerOptions) {
    this.triage = options.triage ?? triageIncident;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
  }

  async run(signal: AbortSignal): Promise<void> {
    let retryNumber = 0;
    while (!signal.aborted) {
      try {
        const processed = await this.processNext(signal);
        retryNumber = 0;
        if (!processed && !signal.aborted) {
          await this.sleep(this.options.pollIntervalMs, signal);
        }
      } catch (error) {
        const normalized = normalizeError(error);
        this.options.onError?.(normalized);
        if (!isRetryableQueueError(error)) throw normalized;
        const delay = retryDelay(retryNumber, this.random);
        retryNumber += 1;
        if (!signal.aborted) await this.sleep(delay, signal);
      }
    }
  }

  async processNext(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const claimed = await this.options.client.claim({
      workerId: this.options.workerId,
      leaseSeconds: this.options.leaseSeconds,
    });
    if (!claimed) return false;
    await this.processClaim(claimed);
    return true;
  }

  private async processClaim(claimed: ClaimedIncident): Promise<void> {
    const activeSignal = new AbortController().signal;
    const reporter = new LeaseReporter(
      this.options.client,
      claimed,
      {
        workerId: this.options.workerId,
        leaseSeconds: this.options.leaseSeconds,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      },
      this.now,
      this.sleep,
      activeSignal,
      this.options.onError,
    );
    reporter.start();
    let workspace: IncidentWorkspace | undefined;
    let workspaceDisposition: WorkspaceDisposition = "failed";

    try {
      let payload: Omit<IncidentInput, "cwd" | "workspaceBranch">;
      try {
        payload = incidentPayload(claimed);
      } catch (error) {
        await this.sendFailure(
          claimed,
          reporter,
          {
            retryable: false,
            error: formatError(error),
          },
          activeSignal,
        );
        return;
      }

      try {
        workspace = await this.options.workspaceManager.acquire(
          claimed.incident.id,
          claimed.incident.attemptCount,
        );
      } catch (error) {
        await this.sendFailure(
          claimed,
          reporter,
          {
            retryable: true,
            retryAfterSeconds: 30,
            error: `Unable to prepare incident workspace: ${formatError(error)}`,
          },
          activeSignal,
        );
        return;
      }

      const input: IncidentInput = {
        ...payload,
        cwd: workspace.cwd,
        ...(workspace.branch
          ? { workspaceBranch: workspace.branch }
          : {}),
      };
      let record: IncidentRecord;
      try {
        record = await this.triage(
          input,
          this.options.runner,
          {
            ...this.options.orchestratorConfig,
            preFixRef: workspace.preFixRef,
            onEvent: (incidentId, event) => {
              this.options.onEvent?.(incidentId, event);
            },
            onStateChange: (next) => {
              this.options.onStateChange?.(next);
              reporter.publish(progressFor(next, this.now()));
            },
          },
        );
      } catch (error) {
        await this.sendFailure(
          claimed,
          reporter,
          {
            retryable: true,
            retryAfterSeconds: 30,
            error: formatError(error),
          },
          activeSignal,
        );
        return;
      }

      await reporter.flush();
      try {
        await this.options.store.put(record);
      } catch (error) {
        await this.sendFailure(
          claimed,
          reporter,
          {
            retryable: true,
            retryAfterSeconds: 30,
            error: `Unable to persist triage result: ${formatError(error)}`,
          },
          activeSignal,
        );
        return;
      }
      if (reporter.lostClaim) return;

      const request: CompleteRequest = {
        workerId: this.options.workerId,
        claimToken: claimed.claim.token,
        callbackId: callbackId(claimed, "complete"),
        outcome: "resolved",
        result: completionResult(record),
      };
      const acknowledged = await retryFinalCallback(
        () => this.options.client.complete(claimed.incident.id, request),
        reporter,
        this.sleep,
        activeSignal,
        this.random,
      );
      if (acknowledged) {
        workspaceDisposition = dispositionFor(record);
      }
    } finally {
      await reporter.close();
      if (workspace) {
        try {
          const result = await this.options.workspaceManager.release(
            workspace,
            workspaceDisposition,
          );
          this.options.onWorkspaceRelease?.(workspace, result);
        } catch (error) {
          this.options.onError?.(
            new Error(
              `Unable to release incident workspace ${workspace.cwd}: ${formatError(error)}`,
            ),
          );
        }
      }
    }
  }

  private async sendFailure(
    claimed: ClaimedIncident,
    reporter: LeaseReporter,
    failure: Pick<
      FailRequest,
      "retryable" | "retryAfterSeconds" | "error"
    >,
    signal: AbortSignal,
  ): Promise<void> {
    const request: FailRequest = {
      workerId: this.options.workerId,
      claimToken: claimed.claim.token,
      callbackId: callbackId(claimed, "fail"),
      retryable: failure.retryable,
      error: failure.error.slice(0, 4_000),
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds }),
    };
    await retryFinalCallback(
      () => this.options.client.fail(claimed.incident.id, request),
      reporter,
      this.sleep,
      signal,
      this.random,
    );
  }
}

class LeaseReporter {
  private latest: IncidentProgress;
  private queue = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private expiresAt: number;
  private lost = false;
  private fatalError: Error | undefined;
  private renewing = false;
  private renewalPending = false;

  constructor(
    private readonly client: IncidentQueueClient,
    private readonly claimed: ClaimedIncident,
    private readonly config: {
      workerId: string;
      leaseSeconds: number;
      heartbeatIntervalMs: number;
    },
    private readonly now: () => string,
    private readonly sleep: (
      milliseconds: number,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly signal: AbortSignal,
    private readonly onError:
      | ((error: Error) => void)
      | undefined,
  ) {
    this.latest = {
      state: "received",
      updatedAt: now(),
      totalTokens: 0,
      summary: claimed.incident.summary,
    };
    this.expiresAt = Date.parse(claimed.claim.expiresAt);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.publish({
        ...this.latest,
        updatedAt: this.now(),
      });
    }, this.config.heartbeatIntervalMs);
  }

  publish(progress: IncidentProgress): void {
    this.latest = progress;
    if (this.lost || this.fatalError || this.signal.aborted) return;
    this.renewalPending = true;
    if (this.renewing) return;
    this.renewing = true;
    this.queue = this.queue
      .then(async () => {
        while (
          this.renewalPending &&
          !this.lost &&
          !this.fatalError &&
          !this.signal.aborted
        ) {
          this.renewalPending = false;
          await this.renew(this.latest);
        }
      })
      .finally(() => {
        this.renewing = false;
      });
  }

  get lostClaim(): boolean {
    return this.lost;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
  }

  private async renew(progress: IncidentProgress): Promise<void> {
    let retryNumber = 0;
    while (!this.lost && !this.fatalError && !this.signal.aborted) {
      try {
        const response = await this.client.renewLease(
          this.claimed.incident.id,
          {
            workerId: this.config.workerId,
            claimToken: this.claimed.claim.token,
            leaseSeconds: this.config.leaseSeconds,
            status: progress,
          },
        );
        this.expiresAt = Date.parse(response.expiresAt);
        return;
      } catch (error) {
        if (isStaleClaim(error)) {
          this.lost = true;
          return;
        }
        if (!isRetryableQueueError(error)) {
          this.fatalError = normalizeError(error);
          this.onError?.(this.fatalError);
          return;
        }
        const delay = Math.min(
          retryDelay(retryNumber, () => 0),
          Math.max(0, this.expiresAt - Date.now()),
        );
        retryNumber += 1;
        if (delay <= 0) {
          this.lost = true;
          return;
        }
        try {
          await this.sleep(delay, this.signal);
        } catch (sleepError) {
          if (!this.signal.aborted) {
            this.fatalError = normalizeError(sleepError);
          }
          return;
        }
      }
    }
  }
}

function incidentPayload(
  claimed: ClaimedIncident,
): Omit<IncidentInput, "cwd" | "workspaceBranch"> {
  const trigger = claimed.incident.payload.trigger;
  const report = claimed.incident.payload.report;
  if (trigger !== "manual" && trigger !== "automated") {
    throw new Error("payload.trigger must be manual or automated");
  }
  if (typeof report !== "string" || !report.trim()) {
    throw new Error("payload.report must be a non-empty string");
  }
  return {
    id: claimed.incident.id,
    trigger: trigger as Trigger,
    report,
  };
}

function dispositionFor(record: IncidentRecord): WorkspaceDisposition {
  if (record.publication?.status === "published") return "published";
  if (
    record.state === "failed" ||
    record.state === "needs_human" ||
    record.state === "budget_exceeded"
  ) {
    return "failed";
  }
  return "completed";
}

export function completionResult(
  record: IncidentRecord,
): IncidentCompletionResult {
  const {
    input: _input,
    events,
    assessment,
    hypothesis,
    claim,
    verification,
    publication,
    ...result
  } = record;
  return {
    ...result,
    events: events
      .filter((event) => !event.kind.startsWith("event:"))
      .slice(-12)
      .map((event) => ({
        ...event,
        detail: compactText(event.detail, 500),
      })),
    ...(assessment
      ? {
          assessment: {
            ...assessment,
            rationale: compactText(assessment.rationale, 2_000),
          },
        }
      : {}),
    ...(hypothesis
      ? {
          hypothesis: {
            ...hypothesis,
            rootCause: compactText(hypothesis.rootCause, 2_000),
            suspectFiles: hypothesis.suspectFiles
              .slice(0, 20)
              .map((path) => compactText(path, 500)),
            proposedFix: compactText(hypothesis.proposedFix, 2_000),
          },
        }
      : {}),
    ...(claim
      ? {
          claim: {
            ...claim,
            summary: compactText(claim.summary, 2_000),
            ...(claim.recommendedMitigation
              ? {
                  recommendedMitigation: compactText(
                    claim.recommendedMitigation,
                    2_000,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(verification
      ? {
          verification: {
            ...verification,
            detail: compactText(verification.detail, 6_000),
            ...(verification.verifiedPaths
              ? { verifiedPaths: verification.verifiedPaths.slice(0, 100) }
              : {}),
          },
        }
      : {}),
    ...(publication
      ? {
          publication: {
            ...publication,
            ...(publication.error
              ? { error: compactText(publication.error, 2_000) }
              : {}),
          },
        }
      : {}),
  };
}

function compactText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 14)}\n...[truncated]`;
}

function progressFor(
  record: IncidentRecord,
  updatedAt: string,
): IncidentProgress {
  const summary =
    record.verification?.detail ??
    record.claim?.summary ??
    record.hypothesis?.rootCause ??
    record.assessment?.rationale ??
    record.input.report;
  return {
    state: record.state,
    updatedAt,
    totalTokens: record.totalTokens,
    summary: summary.slice(0, 2_000),
  };
}

async function retryFinalCallback<T>(
  operation: () => Promise<T>,
  reporter: LeaseReporter,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  random: () => number,
): Promise<boolean> {
  let retryNumber = 0;
  let lastError: unknown;
  while (!signal.aborted && retryNumber < 8) {
    await reporter.flush();
    if (reporter.lostClaim) return false;
    try {
      await operation();
      return true;
    } catch (error) {
      if (isStaleClaim(error)) return false;
      if (!isRetryableQueueError(error)) throw error;
      lastError = error;
      await sleep(retryDelay(retryNumber, random), signal);
      retryNumber += 1;
    }
  }
  if (lastError) throw lastError;
  return false;
}

function callbackId(
  claimed: ClaimedIncident,
  kind: "complete" | "fail",
): string {
  return `${claimed.incident.id}:${claimed.incident.attemptCount}:${kind}`;
}

function retryDelay(retryNumber: number, random: () => number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(retryNumber, 6));
  return Math.round(base * (0.8 + random() * 0.4));
}

function isRetryableQueueError(error: unknown): boolean {
  return error instanceof QueueClientError && error.retryable;
}

function isStaleClaim(error: unknown): boolean {
  return error instanceof QueueClientError && error.staleClaim;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatError(error: unknown): string {
  return normalizeError(error).message;
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
