#!/usr/bin/env node
import { resolve } from "node:path";
import { makeAgentRunner } from "./agent/index.js";
import {
  dashboardConfig,
  optionalNumber,
  parseArgs,
  publishingConfig,
  queueWorkerConfig,
  required,
} from "./config/cli-config.js";
import { TriageDashboardServer } from "./dashboard/server.js";
import { incidentScripts } from "./fixtures/scripts.js";
import { HttpIncidentQueueClient } from "./queue/client.js";
import { IncidentQueueWorker } from "./queue/worker.js";
import { GitHubIncidentPublisher } from "./publisher/incident-publisher.js";
import { defaultStore } from "./store/json-store.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runner = makeAgentRunner({ stubScripts: incidentScripts });
  const cwd = resolve(required(args, "cwd"));
  const queueOptions = queueWorkerConfig(args, process.env);
  const publication = publishingConfig(args, process.env);
  const dashboardOptions = dashboardConfig(args, process.env);
  const dashboard = dashboardOptions.enabled
    ? new TriageDashboardServer({ port: dashboardOptions.port })
    : undefined;
  const abortController = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    process.stderr.write(
      `Received ${signal}; stopping after the active incident.\n`,
    );
    abortController.abort();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    if (dashboard) {
      const url = await dashboard.start();
      process.stderr.write(`Triage dashboard: ${url}\n`);
    }

    const worker = new IncidentQueueWorker({
      client: new HttpIncidentQueueClient({
        baseUrl: queueOptions.baseUrl,
      }),
      workerId: queueOptions.workerId,
      cwd,
      pollIntervalMs: queueOptions.pollIntervalMs,
      leaseSeconds: queueOptions.leaseSeconds,
      heartbeatIntervalMs: queueOptions.heartbeatIntervalMs,
      runner,
      store: defaultStore(process.cwd()),
      orchestratorConfig: {
        maxTokensPerIncident:
          optionalNumber(args, "max-tokens") ?? 1_000_000,
        preFixRef: required(args, "pre-fix-ref"),
        ...(publication.enabled
          ? {
              publisher: new GitHubIncidentPublisher({
                baseBranch: publication.baseBranch,
                remote: publication.remote,
                ...(publication.repository
                  ? { repository: publication.repository }
                  : {}),
              }),
            }
          : {}),
      },
      onEvent: (incidentId, event) => {
        dashboard?.publishAgentEvent(incidentId, event);
        process.stderr.write(`${JSON.stringify({ incidentId, event })}\n`);
      },
      onStateChange: (record) => {
        dashboard?.publishState(record);
        process.stderr.write(
          `${JSON.stringify({
            incidentId: record.input.id,
            state: record.state,
          })}\n`,
        );
      },
      onError: (error) => {
        process.stderr.write(`Incident queue error: ${error.message}\n`);
      },
    });

    process.stderr.write(
      `Polling ${queueOptions.baseUrl} as ${queueOptions.workerId}.\n`,
    );
    await worker.run(abortController.signal);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await dashboard?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
