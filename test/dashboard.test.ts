import { afterEach, describe, expect, it } from "vitest";
import { TriageDashboardServer } from "../src/dashboard/server.js";
import { IncidentRecord } from "../src/pipeline/types.js";

const servers: TriageDashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function record(state: IncidentRecord["state"]): IncidentRecord {
  return {
    input: {
      id: "incident-demo",
      trigger: "manual",
      report: "demo incident",
      cwd: process.cwd(),
    },
    state,
    totalTokens: 42,
    requestIds: ["request-1"],
    events: [],
  };
}

describe("TriageDashboardServer", () => {
  it("serves the dark dashboard and current incident state", async () => {
    const server = new TriageDashboardServer({ port: 0 });
    servers.push(server);
    const url = await server.start();
    server.publishState(record("investigating"));

    const [page, state] = await Promise.all([
      fetch(url).then((response) => response.text()),
      fetch(`${url}/api/state`).then((response) => response.json()),
    ]);

    expect(page).toContain("<title>Incident triage</title>");
    expect(page).toContain("<h1>Incident Triage</h1>");
    expect(page).toContain(
      '"Incident " + record.input.id',
    );
    expect(page).toContain("Resume polling");
    expect(page).toContain("color-scheme: dark");
    expect(page).toContain('id="agent-event"');
    expect(page).not.toContain('id="events"');
    expect(page).not.toContain("renderEvents");
    expect(page).not.toContain("record?.events");
    expect(state.record).toMatchObject({
      state: "investigating",
      input: { id: "incident-demo" },
    });
  });

  it("streams state snapshots to connected browsers", async () => {
    const server = new TriageDashboardServer({ port: 0 });
    servers.push(server);
    const url = await server.start();
    const response = await fetch(`${url}/events`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      server.publishState(record("acting"));
      let text = "";
      while (!text.includes('"kind":"snapshot"')) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }

      expect(text).toContain('"kind":"snapshot"');
      expect(text).toContain('"state":"acting"');
    } finally {
      await reader!.cancel();
    }
  });

  it("clears a terminal incident without stopping polling", async () => {
    const server = new TriageDashboardServer({ port: 0 });
    servers.push(server);
    const url = await server.start();
    server.publishState(record("verified_fixed"));

    await fetch(`${url}/api/reset`, { method: "POST" }).then((response) => {
      expect(response.status).toBe(204);
    });

    await expect(
      fetch(`${url}/api/state`).then((response) => response.json()),
    ).resolves.toEqual({ record: null });
  });
});
