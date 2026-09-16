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
      { name: "read_file", args: { path: "src/regulations/season.ts" } },
    ],
    result: {
      text: json({
        rootCause:
          "The season-end boundary excludes the final valid day.",
        offendingCommit: "5fe267c",
        suspectFiles: ["src/regulations/season.ts"],
        proposedFix: "Make the season-end boundary inclusive.",
      }),
    },
  },
  {
    match: "durable fix",
    mode: "agent",
    result: {
      text: json({
        status: "fixed",
        testPath: "test/incident-season.test.ts",
        summary:
          "Added a reproduction test and made the season-end boundary inclusive.",
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
