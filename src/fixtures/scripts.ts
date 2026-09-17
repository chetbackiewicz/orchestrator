import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OpenSessionOptions } from "../agent/runner.js";
import { StubScript } from "../agent/stub-runner.js";

function json(value: object): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

const seasonScripts: StubScript[] = [
  {
    match: "Decide the autonomy ceiling",
    mode: "plan",
    result: {
      text: json({
        type: "logic-error",
        severity: "high",
        autonomy: "auto_fix",
        rationale:
          "A bounded source-code regression with a reversible fix.",
      }),
    },
  },
  {
    match: "root-cause hypothesis",
    mode: "plan",
    callTools: [
      { name: "recent_commits", args: { count: 15 } },
      {
        name: "read_file",
        args: { path: "src/recommendations/service.ts" },
      },
    ],
    result: {
      text: json({
        rootCause:
          "The season-end boundary excludes the final valid day.",
        offendingCommit: "5fe267c",
        suspectFiles: ["src/recommendations/service.ts"],
        proposedFix: "Make the season-end boundary inclusive.",
      }),
    },
  },
  {
    match: "durable fix",
    mode: "agent",
    execute: applySeasonFixtureFix,
    result: {
      text: json({
        status: "fixed",
        testPath: "test/incident-season.test.ts",
        summary:
          "Added a focused reproduction test and made the season-end boundary inclusive.",
      }),
    },
  },
];

const poolScripts: StubScript[] = [
  {
    match: "Decide the autonomy ceiling",
    mode: "plan",
    callTools: [
      {
        name: "read_incident",
        args: { path: "fixtures/incident-pool.json" },
      },
    ],
    result: {
      text: json({
        type: "connection-pool-exhaustion",
        severity: "critical",
        autonomy: "auto_fix",
        rationale:
          "A recent bounded resource leak can be fixed reversibly in source.",
      }),
    },
  },
  {
    match: "root-cause hypothesis",
    mode: "plan",
    callTools: [
      { name: "recent_commits", args: { count: 15 } },
      { name: "db_pool_status", args: {} },
    ],
    result: {
      text: json({
        rootCause:
          "A successful recommendation path does not release its database lease.",
        offendingCommit: "266644b",
        suspectFiles: ["src/recommendations/handler.ts"],
        proposedFix: "Release every borrowed lease in a finally block.",
      }),
    },
  },
  {
    match: "durable fix",
    mode: "agent",
    result: {
      text: json({
        status: "fixed",
        testPath: "test/incident-pool.test.ts",
        summary:
          "Added a concurrent-load reproduction and guaranteed lease release.",
        recommendedMitigation:
          "Roll back the leaking deploy until the fix is reviewed.",
      }),
    },
  },
];

const riskyScripts: StubScript[] = [
  {
    match: "Decide the autonomy ceiling",
    mode: "plan",
    result: {
      text: json({
        type: "sast-critical",
        severity: "critical",
        autonomy: "escalate_only",
        rationale:
          "The report crosses an authentication boundary and needs security review.",
      }),
    },
  },
  {
    match: "evidence packet",
    mode: "plan",
    result: {
      text: json({
        status: "declined",
        summary:
          "Collected the affected authentication path for human review.",
        recommendedMitigation:
          "Assign the incident to security on-call and do not merge automatically.",
      }),
    },
  },
];

export function incidentScripts(options: OpenSessionOptions): StubScript[] {
  const label = options.label ?? "";
  if (label.includes("pool")) return poolScripts;
  if (label.includes("sast") || label.includes("risky")) return riskyScripts;
  return seasonScripts;
}

async function applySeasonFixtureFix(
  options: OpenSessionOptions,
): Promise<void> {
  const path = resolve(options.cwd, "src/recommendations/service.ts");
  const source = await readFile(path, "utf8");
  const before = "return date >= start && date < end;";
  const after = "return date >= start && date <= end;";
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    throw new Error(
      "Season fixture could not find the exclusive end-date boundary",
    );
  }
  await writeFile(path, source.replace(before, after), "utf8");
  await writeFile(
    resolve(options.cwd, "test/incident-season.test.ts"),
    `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DatabasePool } from "../src/db/pool.js";

describe("season incident reproduction", () => {
  let directory: string;
  let pool: DatabasePool;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emerald-season-"));
    pool = new DatabasePool(join(directory, "test.db"), 5, 250);
    pool.initialize();
  });

  afterEach(() => {
    pool.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the listed season end date open", async () => {
    const response = await request(createApp(pool))
      .get("/recommendations")
      .query({ species: "Coho", area: "Skykomish", date: "2026-09-30" })
      .expect(200);

    expect(response.body.open).toBe(true);
  });
});
`,
    "utf8",
  );
}
