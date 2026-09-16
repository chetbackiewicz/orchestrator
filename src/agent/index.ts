import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { CursorAgentRunner } from "./cursor-runner.js";
import { AgentRunner } from "./runner.js";
import { StubAgentRunner, StubScriptFactory } from "./stub-runner.js";

export interface MakeAgentRunnerOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: string | false;
  stubScripts: StubScriptFactory;
}

export function makeAgentRunner(options: MakeAgentRunnerOptions): AgentRunner {
  if (!options.env) {
    loadOptionalEnvironmentFile(options.envFile);
  }
  const env = options.env ?? process.env;
  const kind = env.AGENT_RUNNER ?? "stub";
  if (kind === "stub") return new StubAgentRunner(options.stubScripts);
  if (kind !== "cursor") {
    throw new Error(`Unsupported AGENT_RUNNER value: ${kind}`);
  }

  const apiKey = env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("CURSOR_API_KEY is required for AGENT_RUNNER=cursor");

  return new CursorAgentRunner({
    apiKey,
    model: env.CURSOR_MODEL ?? "composer-2.5",
    sandbox: env.CURSOR_SANDBOX !== "false",
    autoReview: env.CURSOR_AUTO_REVIEW !== "false",
  });
}

function loadOptionalEnvironmentFile(envFile: string | false | undefined): void {
  if (envFile === false) return;
  const path = resolve(envFile ?? ".env");
  if (existsSync(path)) loadEnvFile(path);
}

export * from "./runner.js";
export * from "./stub-runner.js";
export * from "./cursor-runner.js";
