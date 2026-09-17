import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";

export type CliArgs = Map<string, string | true>;

export interface PublishingCliConfig {
  enabled: boolean;
  baseBranch: string;
  repository?: string;
  remote: string;
}

export interface DashboardCliConfig {
  enabled: boolean;
  port: number;
}

export interface QueueWorkerCliConfig {
  baseUrl: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  workerId: string;
}

export type WorkspaceCliConfig =
  | {
      mode: "fixed";
      cwd: string;
      preFixRef: string;
    }
  | {
      mode: "managed";
      repoRoot: string;
      workspaceRoot: string;
      targetRef: string;
    };

export function parseArgs(values: string[]): CliArgs {
  const args: CliArgs = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Expected --key near ${key ?? "end"}`);
    }
    const name = key.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(name, true);
      continue;
    }
    args.set(name, next);
    index += 1;
  }
  return args;
}

export function publishingConfig(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): PublishingCliConfig {
  const enabled =
    optionalBoolean(args, "publish") ??
    optionalEnvironmentBoolean(env.INCIDENT_PUBLISH, "INCIDENT_PUBLISH") ??
    false;
  const repository = optionalString(args, "github-repo");
  const configuredRepository =
    repository ?? env.INCIDENT_GITHUB_REPOSITORY;
  return {
    enabled,
    baseBranch:
      optionalString(args, "publish-base") ??
      env.INCIDENT_PUBLISH_BASE ??
      "main",
    remote:
      optionalString(args, "github-remote") ??
      env.INCIDENT_GITHUB_REMOTE ??
      "origin",
    ...(configuredRepository ? { repository: configuredRepository } : {}),
  };
}

export function dashboardConfig(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): DashboardCliConfig {
  const enabled =
    optionalBoolean(args, "dashboard") ??
    optionalEnvironmentBoolean(env.INCIDENT_DASHBOARD, "INCIDENT_DASHBOARD") ??
    false;
  const port =
    optionalNumber(args, "dashboard-port") ??
    optionalEnvironmentPort(env.INCIDENT_DASHBOARD_PORT) ??
    4317;
  if (!Number.isInteger(port) || port > 65_535) {
    throw new Error("--dashboard-port must be an integer from 0 to 65535");
  }
  return { enabled, port };
}

export function queueWorkerConfig(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  defaultWorkerId = makeWorkerId(),
): QueueWorkerCliConfig {
  const configuredUrl =
    optionalString(args, "queue-url") ?? env.INCIDENT_QUEUE_URL;
  if (!configuredUrl) {
    throw new Error(
      "Missing queue URL: use --queue-url or INCIDENT_QUEUE_URL",
    );
  }
  const baseUrl = normalizeHttpBaseUrl(configuredUrl);
  const pollIntervalMs =
    optionalPositiveInteger(args, "poll-interval-ms") ??
    optionalEnvironmentPositiveInteger(
      env.INCIDENT_POLL_INTERVAL_MS,
      "INCIDENT_POLL_INTERVAL_MS",
    ) ??
    5_000;
  const leaseSeconds =
    optionalPositiveInteger(args, "lease-seconds") ??
    optionalEnvironmentPositiveInteger(
      env.INCIDENT_LEASE_SECONDS,
      "INCIDENT_LEASE_SECONDS",
    ) ??
    120;
  const heartbeatIntervalMs =
    optionalPositiveInteger(args, "heartbeat-interval-ms") ??
    optionalEnvironmentPositiveInteger(
      env.INCIDENT_HEARTBEAT_INTERVAL_MS,
      "INCIDENT_HEARTBEAT_INTERVAL_MS",
    ) ??
    30_000;
  if (heartbeatIntervalMs >= leaseSeconds * 1_000) {
    throw new Error(
      "Heartbeat interval must be shorter than the incident lease",
    );
  }
  const workerId =
    optionalString(args, "worker-id") ??
    env.INCIDENT_WORKER_ID ??
    defaultWorkerId;
  if (!workerId.trim()) {
    throw new Error("Incident worker ID must be a non-empty string");
  }
  return {
    baseUrl,
    pollIntervalMs,
    leaseSeconds,
    heartbeatIntervalMs,
    workerId,
  };
}

export function workspaceConfig(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  launchCwd = process.cwd(),
  defaultTargetRef = "origin/main",
): WorkspaceCliConfig {
  const cwd = optionalString(args, "cwd") ?? env.INCIDENT_TARGET_CWD;
  const repoRoot =
    optionalString(args, "repo-root") ?? env.INCIDENT_REPO_ROOT;
  if (cwd && repoRoot) {
    throw new Error("Use either --cwd or --repo-root, not both");
  }
  if (!cwd && !repoRoot) {
    throw new Error(
      "Missing target workspace: use --cwd or --repo-root",
    );
  }

  const preFixRef =
    optionalString(args, "pre-fix-ref") ?? env.INCIDENT_PRE_FIX_REF;
  const targetRef =
    optionalString(args, "target-ref") ?? env.INCIDENT_TARGET_REF;
  if (cwd) {
    if (targetRef) {
      throw new Error("--target-ref is only valid with --repo-root");
    }
    if (!preFixRef) {
      throw new Error(
        "Missing pre-fix ref: use --pre-fix-ref with --cwd",
      );
    }
    return {
      mode: "fixed",
      cwd: resolve(launchCwd, cwd),
      preFixRef,
    };
  }

  if (preFixRef) {
    throw new Error("--pre-fix-ref is only valid with --cwd");
  }
  const workspaceRoot =
    optionalString(args, "workspace-root") ??
    env.INCIDENT_WORKSPACE_ROOT ??
    resolve(launchCwd, ".incident-orchestrator", "worktrees");
  return {
    mode: "managed",
    repoRoot: resolve(launchCwd, repoRoot!),
    workspaceRoot: resolve(launchCwd, workspaceRoot),
    targetRef: targetRef ?? defaultTargetRef,
  };
}

export function required(args: CliArgs, key: string): string {
  const value = args.get(key);
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

export function optionalNumber(
  args: CliArgs,
  key: string,
): number | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${key} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${key} must be a non-negative number`);
  }
  return parsed;
}

function optionalString(args: CliArgs, key: string): string | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${key} requires a value`);
  return value;
}

function optionalPositiveInteger(
  args: CliArgs,
  key: string,
): number | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${key} requires a value`);
  return parsePositiveInteger(value, `--${key}`);
}

function optionalBoolean(
  args: CliArgs,
  key: string,
): boolean | undefined {
  const value = args.get(key);
  if (value === undefined || value === true) return value;
  return parseBoolean(value, `--${key}`);
}

function optionalEnvironmentBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  return value === undefined ? undefined : parseBoolean(value, name);
}

function optionalEnvironmentPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      "INCIDENT_DASHBOARD_PORT must be an integer from 0 to 65535",
    );
  }
  return parsed;
}

function optionalEnvironmentPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, name);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function normalizeHttpBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Incident queue URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Incident queue URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Incident queue URL must not contain credentials, query parameters, or a fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function makeWorkerId(): string {
  return `orchestrator-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}
