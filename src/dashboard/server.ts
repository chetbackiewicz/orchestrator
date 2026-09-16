import { createServer, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { RunEvent } from "../agent/runner.js";
import { IncidentRecord } from "../pipeline/types.js";

export interface DashboardServerOptions {
  port: number;
  host?: string;
}

type DashboardMessage =
  | { kind: "snapshot"; record: IncidentRecord }
  | {
      kind: "agent_event";
      incidentId: string;
      event: RunEvent;
      at: string;
    };

export class TriageDashboardServer {
  private readonly clients = new Set<ServerResponse>();
  private server: Server | undefined;
  private record: IncidentRecord | undefined;
  private url: string | undefined;

  constructor(private readonly options: DashboardServerOptions) {}

  async start(): Promise<string> {
    if (this.server) {
      if (!this.url) throw new Error("Dashboard server has no URL");
      return this.url;
    }

    const server = createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );

      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(dashboardHtml);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ record: this.record ?? null }));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write("retry: 1000\n\n");
        this.clients.add(response);
        if (this.record) {
          writeSse(response, { kind: "snapshot", record: this.record });
        }
        request.on("close", () => this.clients.delete(response));
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });

    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host ?? "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Dashboard server did not expose a TCP address");
    }
    this.url = formatUrl(address);
    return this.url;
  }

  publishState(record: IncidentRecord): void {
    this.record = record;
    this.broadcast({ kind: "snapshot", record });
  }

  publishAgentEvent(
    incidentId: string,
    event: RunEvent,
    at = new Date().toISOString(),
  ): void {
    this.broadcast({ kind: "agent_event", incidentId, event, at });
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private broadcast(message: DashboardMessage): void {
    for (const client of this.clients) writeSse(client, message);
  }
}

function writeSse(response: ServerResponse, message: DashboardMessage): void {
  response.write(`data: ${JSON.stringify(message)}\n\n`);
}

function formatUrl(address: AddressInfo): string {
  const host = address.address === "::" ? "localhost" : address.address;
  return `http://${host}:${address.port}`;
}

export const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Incident triage</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b10;
      --panel: #11151d;
      --panel-raised: #171c26;
      --border: #252c38;
      --muted: #8b95a7;
      --text: #f2f5f9;
      --accent: #7c5cff;
      --accent-soft: rgba(124, 92, 255, 0.16);
      --green: #42d392;
      --yellow: #f6c85f;
      --red: #ff6b7a;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 12% 0%, rgba(124, 92, 255, 0.14), transparent 32rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 40px 0 64px;
    }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 28px;
    }

    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    h1 {
      margin: 7px 0 6px;
      font-size: clamp(26px, 4vw, 38px);
      letter-spacing: -0.04em;
      line-height: 1.1;
    }

    #report {
      max-width: 720px;
      margin: 0;
      color: var(--muted);
    }

    .connection {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 11px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(17, 21, 29, 0.8);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .connection-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--yellow);
      box-shadow: 0 0 12px currentColor;
    }

    .connection.live .connection-dot { background: var(--green); }
    .connection.offline .connection-dot { background: var(--red); }

    .panel {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(23, 28, 38, 0.88), rgba(17, 21, 29, 0.96));
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.22);
    }

    .progress-panel { padding: 24px; }

    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }

    .panel-heading h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: -0.01em;
    }

    .status {
      padding: 5px 10px;
      border: 1px solid rgba(124, 92, 255, 0.4);
      border-radius: 999px;
      background: var(--accent-soft);
      color: #cfc4ff;
      font-size: 12px;
      font-weight: 700;
      text-transform: capitalize;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0;
    }

    .step {
      position: relative;
      min-width: 0;
      color: var(--muted);
      text-align: center;
    }

    .step:not(:last-child)::after {
      content: "";
      position: absolute;
      top: 15px;
      left: calc(50% + 18px);
      right: calc(-50% + 18px);
      height: 2px;
      background: var(--border);
    }

    .step.complete:not(:last-child)::after { background: var(--accent); }

    .step-dot {
      position: relative;
      z-index: 1;
      display: grid;
      width: 32px;
      height: 32px;
      margin: 0 auto 10px;
      place-items: center;
      border: 2px solid var(--border);
      border-radius: 50%;
      background: var(--panel);
      font-size: 11px;
      font-weight: 800;
    }

    .step.complete .step-dot {
      border-color: var(--accent);
      background: var(--accent);
      color: white;
    }

    .step.current { color: var(--text); }

    .step.current .step-dot {
      border-color: var(--accent);
      box-shadow: 0 0 0 5px var(--accent-soft);
      color: white;
    }

    .step-label {
      overflow: hidden;
      font-size: 12px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.75fr);
      gap: 16px;
      margin-top: 16px;
    }

    .activity, .summary { min-height: 330px; }

    .activity {
      display: flex;
      flex-direction: column;
      padding: 22px;
    }

    .agent-now {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 18px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(9, 11, 16, 0.45);
    }

    .pulse {
      flex: 0 0 auto;
      width: 10px;
      height: 10px;
      margin-top: 5px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 0 rgba(124, 92, 255, 0.5);
      animation: pulse 1.8s infinite;
    }

    @keyframes pulse {
      70% { box-shadow: 0 0 0 8px rgba(124, 92, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(124, 92, 255, 0); }
    }

    #agent-event {
      margin-top: 2px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    .event-list {
      min-height: 0;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }

    .event-list li {
      display: grid;
      grid-template-columns: 78px 1fr;
      gap: 12px;
      padding: 9px 2px;
      border-top: 1px solid rgba(37, 44, 56, 0.7);
    }

    .event-time {
      color: var(--muted);
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .event-kind {
      font-weight: 650;
      text-transform: capitalize;
    }

    .summary { padding: 22px; }

    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 18px;
    }

    .metric {
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 11px;
      background: rgba(9, 11, 16, 0.38);
    }

    .metric-label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .metric-value {
      display: block;
      margin-top: 4px;
      font-size: 15px;
      font-weight: 750;
      text-transform: capitalize;
    }

    .detail {
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .detail-label {
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .detail p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .empty {
      display: grid;
      min-height: 220px;
      place-items: center;
      color: var(--muted);
      text-align: center;
    }

    @media (max-width: 760px) {
      main { width: min(100% - 20px, 1120px); padding-top: 24px; }
      header { flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .progress-panel { overflow-x: auto; }
      .steps { min-width: 620px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Agent operations</div>
        <h1 id="incident-title">Waiting for triage</h1>
        <p id="report">The dashboard will update as soon as an incident starts.</p>
      </div>
      <div id="connection" class="connection">
        <span class="connection-dot"></span>
        <span id="connection-label">Connecting</span>
      </div>
    </header>

    <section class="panel progress-panel">
      <div class="panel-heading">
        <h2>Triage progress</h2>
        <span id="status" class="status">waiting</span>
      </div>
      <div id="steps" class="steps"></div>
    </section>

    <div class="grid">
      <section class="panel activity">
        <div class="panel-heading">
          <h2>Agent activity</h2>
        </div>
        <div class="agent-now">
          <span class="pulse"></span>
          <div>
            <strong id="agent-heading">Waiting for agent</strong>
            <div id="agent-event">No activity received yet.</div>
          </div>
        </div>
        <ol id="events" class="event-list"></ol>
      </section>

      <aside class="panel summary">
        <div class="panel-heading">
          <h2>Incident summary</h2>
        </div>
        <div class="metrics">
          <div class="metric">
            <span class="metric-label">Severity</span>
            <span id="severity" class="metric-value">—</span>
          </div>
          <div class="metric">
            <span class="metric-label">Autonomy</span>
            <span id="autonomy" class="metric-value">—</span>
          </div>
          <div class="metric">
            <span class="metric-label">Tokens</span>
            <span id="tokens" class="metric-value">0</span>
          </div>
          <div class="metric">
            <span class="metric-label">Requests</span>
            <span id="requests" class="metric-value">0</span>
          </div>
        </div>
        <div class="detail">
          <div class="detail-label">Current finding</div>
          <p id="finding">Assessment has not started.</p>
        </div>
      </aside>
    </div>
  </main>

  <script>
    const stepDefinitions = [
      ["received", "Received"],
      ["assessing", "Assess"],
      ["investigating", "Investigate"],
      ["acting", "Act"],
      ["awaiting_verification", "Verify"],
      ["complete", "Complete"],
    ];
    const terminalStates = new Set([
      "verified_fixed",
      "escalated",
      "needs_human",
      "failed",
      "budget_exceeded",
    ]);
    const stateIndexes = {
      received: 0,
      assessing: 1,
      investigating: 2,
      acting: 3,
      awaiting_verification: 4,
      verified_fixed: 5,
      escalated: 5,
      needs_human: 5,
      failed: 5,
      budget_exceeded: 5,
    };
    const elements = Object.fromEntries(
      [
        "incident-title", "report", "connection", "connection-label", "status",
        "steps", "agent-heading", "agent-event", "events", "severity",
        "autonomy", "tokens", "requests", "finding",
      ].map((id) => [id, document.getElementById(id)]),
    );

    let currentRecord = null;
    let liveEvents = [];

    function humanize(value) {
      return String(value ?? "—").replaceAll("_", " ");
    }

    function setConnection(state, label) {
      elements.connection.className = "connection " + state;
      elements["connection-label"].textContent = label;
    }

    function renderSteps(state) {
      const currentIndex = stateIndexes[state] ?? 0;
      elements.steps.replaceChildren(
        ...stepDefinitions.map(([key, label], index) => {
          const step = document.createElement("div");
          const complete = index < currentIndex || (index === 5 && terminalStates.has(state));
          step.className = "step" +
            (complete ? " complete" : "") +
            (index === currentIndex && !complete ? " current" : "");

          const dot = document.createElement("div");
          dot.className = "step-dot";
          dot.textContent = complete ? "✓" : String(index + 1);

          const text = document.createElement("div");
          text.className = "step-label";
          text.textContent = label;
          step.append(dot, text);
          return step;
        }),
      );
    }

    function findingFor(record) {
      if (record.verification) return record.verification.detail;
      if (record.claim) return record.claim.summary;
      if (record.hypothesis) return record.hypothesis.rootCause;
      if (record.assessment) return record.assessment.rationale;
      return "Assessment has not started.";
    }

    function eventDescription(event) {
      if (!event) return "No activity received yet.";
      if (event.type === "tool_call") {
        return event.name + " · " + event.status;
      }
      return event.text ?? event.status ?? event.type;
    }

    function renderEvents(record) {
      const stateEvents = (record?.events ?? []).map((event) => ({
        at: event.at,
        kind: humanize(event.kind.replace("event:", "")),
        detail: event.detail,
      }));
      const combined = [...stateEvents, ...liveEvents]
        .sort((left, right) => left.at.localeCompare(right.at))
        .slice(-50)
        .reverse();

      elements.events.replaceChildren(
        ...combined.map((event) => {
          const row = document.createElement("li");
          const time = document.createElement("span");
          time.className = "event-time";
          time.textContent = new Date(event.at).toLocaleTimeString();
          const description = document.createElement("span");
          description.className = "event-kind";
          description.textContent = event.kind;
          description.title = event.detail;
          row.append(time, description);
          return row;
        }),
      );
    }

    function render(record) {
      if (!record) return;
      currentRecord = record;
      elements["incident-title"].textContent = record.input.id;
      elements.report.textContent = record.input.report;
      elements.status.textContent = humanize(record.state);
      elements.severity.textContent = humanize(record.assessment?.severity);
      elements.autonomy.textContent = humanize(record.assessment?.autonomy);
      elements.tokens.textContent = Number(record.totalTokens ?? 0).toLocaleString();
      elements.requests.textContent = String(record.requestIds?.length ?? 0);
      elements.finding.textContent = findingFor(record);
      elements["agent-heading"].textContent = terminalStates.has(record.state)
        ? "Triage complete"
        : "Agent is " + humanize(record.state);
      renderSteps(record.state);
      renderEvents(record);
    }

    fetch("/api/state")
      .then((response) => response.json())
      .then(({ record }) => render(record))
      .catch(() => {});

    const stream = new EventSource("/events");
    stream.onopen = () => setConnection("live", "Live");
    stream.onerror = () => setConnection("offline", "Reconnecting");
    stream.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.kind === "snapshot") {
        render(message.record);
        return;
      }
      if (message.kind === "agent_event") {
        const detail = eventDescription(message.event);
        elements["agent-heading"].textContent = "Agent is working";
        elements["agent-event"].textContent = detail;
        liveEvents.push({
          at: message.at,
          kind: humanize(message.event.type),
          detail,
        });
        liveEvents = liveEvents.slice(-50);
        renderEvents(currentRecord);
      }
    };

    renderSteps("received");
  </script>
</body>
</html>`;
