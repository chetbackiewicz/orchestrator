#!/usr/bin/env node
import { resolve } from "node:path";
import { makeAgentRunner } from "./agent/index.js";
import { incidentScripts } from "./fixtures/scripts.js";
import { triageIncident } from "./pipeline/orchestrator.js";
import { IncidentInput, Trigger } from "./pipeline/types.js";
import { defaultStore } from "./store/json-store.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(required(args, "cwd"));
  const trigger = required(args, "trigger");
  if (trigger !== "manual" && trigger !== "automated") {
    throw new Error("--trigger must be manual or automated");
  }

  const input: IncidentInput = {
    id: required(args, "id"),
    trigger: trigger as Trigger,
    report: required(args, "report"),
    cwd,
  };
  const runner = makeAgentRunner({ stubScripts: incidentScripts });
  const store = defaultStore(cwd);
  const record = await triageIncident(input, runner, {
    maxTokensPerIncident: optionalNumber(args, "max-tokens") ?? 100_000,
    preFixRef: required(args, "pre-fix-ref"),
    onEvent: (incidentId, event) => {
      process.stderr.write(
        `${JSON.stringify({ incidentId, event })}\n`,
      );
    },
    onStateChange: (next) => {
      process.stderr.write(
        `${JSON.stringify({ incidentId: next.input.id, state: next.state })}\n`,
      );
    },
  });
  await store.put(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (!["verified_fixed", "escalated"].includes(record.state)) {
    process.exitCode = 1;
  }
}

function parseArgs(values: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --key value arguments near ${key ?? "end"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key);
  if (!value) throw new Error(`Missing required argument --${key}`);
  return value;
}

function optionalNumber(
  args: Map<string, string>,
  key: string,
): number | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${key} must be a non-negative number`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
