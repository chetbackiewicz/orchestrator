#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import {
  parseArgs,
  publishingConfig,
  workspaceConfig,
} from "./config/cli-config.js";
import { GitIncidentWorkspaceManager } from "./workspace/manager.js";

async function main(): Promise<void> {
  const envFile = resolve(".env");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const args = parseArgs(process.argv.slice(2));
  const publication = publishingConfig(args, process.env);
  const workspace = workspaceConfig(
    args,
    process.env,
    process.cwd(),
    `${publication.remote}/${publication.baseBranch}`,
  );
  if (workspace.mode !== "managed") {
    throw new Error(
      "Workspace cleanup requires managed mode with --repo-root.",
    );
  }
  const manager = new GitIncidentWorkspaceManager({
    repoRoot: workspace.repoRoot,
    workspaceRoot: workspace.workspaceRoot,
    targetRef: workspace.targetRef,
    remote: publication.remote,
  });
  const results = await manager.cleanup();
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
