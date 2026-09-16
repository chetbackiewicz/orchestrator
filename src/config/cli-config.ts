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

function parseBoolean(value: string, name: string): boolean {
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}
