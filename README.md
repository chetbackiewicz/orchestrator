# Incident orchestrator

A TypeScript orchestrator that drives an incident through:

```text
assess -> investigate -> act -> independently verify -> publish outcome
```

The implementation keeps the agent runtime behind an `AgentRunner` interface.
Development and tests use a deterministic stub; production runs use the Cursor
SDK local runtime.

## Requirements

- Node.js 22.13 or newer
- npm
- A clean target repository with Vitest installed
- A Cursor API key for real agent runs
- GitHub CLI authentication with push and issue/pull-request access when
  publishing is enabled

## Install and validate

```bash
npm install
npm test
npm run typecheck
```

Copy `.env.example` to `.env` if the local file is not already present, then
set the API key:

```dotenv
AGENT_RUNNER=cursor
CURSOR_API_KEY=your-key
CURSOR_MODEL=composer-2.5
CURSOR_SANDBOX=true
CURSOR_AUTO_REVIEW=true
INCIDENT_PUBLISH=false
INCIDENT_PUBLISH_BASE=main
INCIDENT_GITHUB_REMOTE=origin
```

`.env` and environment-specific variants are ignored by Git. The orchestrator
loads `.env` automatically before selecting the runner. Values already present
in the process environment take precedence.

Authenticate the host process before enabling publication. Credentials remain
in the orchestrator process and are never included in model prompts:

```bash
gh auth login
gh auth status
```

## End-to-end run

Publishing is opt-in so tests and local dry runs do not mutate GitHub. This
exact command runs triage, independent verification, persistence, and outcome
publication:

```bash
npm run triage -- \
  --id incident-season \
  --trigger manual \
  --report "users report an incorrect season-open recommendation" \
  --cwd ../emerald-osprey \
  --pre-fix-ref main \
  --publish \
  --publish-base main
```

Add `--dashboard` to expose a live, dark-themed browser dashboard at
`http://127.0.0.1:4317`. It displays the current triage stage, the active
streamed agent operation, severity, autonomy decision, token usage, findings,
and terminal outcome. Tool activity is ephemeral and is not replayed as a
historical list. The dashboard remains available after triage completes until
the process is stopped:

```bash
npm run triage -- \
  --id incident-season \
  --trigger manual \
  --report "users report an incorrect season-open recommendation" \
  --cwd ../emerald-osprey \
  --pre-fix-ref main \
  --dashboard
```

Use `--dashboard-port 4400`, `INCIDENT_DASHBOARD=true`, or
`INCIDENT_DASHBOARD_PORT=4400` to change how it is enabled. The server binds to
localhost only.

## Emerald Osprey queue worker

Run the dedicated worker to poll Emerald Osprey's durable SQLite-backed HTTP
queue and process one incident at a time:

```bash
npm run worker -- \
  --queue-url http://127.0.0.1:3000 \
  --cwd ../emerald-osprey \
  --pre-fix-ref main \
  --dashboard
```

The one-shot `triage` command is unchanged. The worker reuses its runner, token
budget, verification, optional GitHub publication, JSON incident store, and
dashboard behavior. Serial processing protects the shared target checkout,
agent edits, verification worktrees, branches, and publication flow.

Queue settings can be supplied by flags or environment:

| Flag | Environment | Default |
| --- | --- | --- |
| `--queue-url` | `INCIDENT_QUEUE_URL` | Required |
| `--poll-interval-ms` | `INCIDENT_POLL_INTERVAL_MS` | `5000` |
| `--lease-seconds` | `INCIDENT_LEASE_SECONDS` | `120` |
| `--heartbeat-interval-ms` | `INCIDENT_HEARTBEAT_INTERVAL_MS` | `30000` |
| `--worker-id` | `INCIDENT_WORKER_ID` | Host/PID/random identifier |
| `--max-tokens` | — | `1000000` |

The heartbeat interval must be shorter than the lease. Queue transport and 5xx
failures use bounded exponential backoff; invalid contracts and permanent 4xx
errors stop the worker explicitly. `SIGINT` and `SIGTERM` stop new claims,
allow active triage to return, close the dashboard, and then exit.

### Queue contract

Emerald submits a durable incident with a client idempotency key:

```json
{
  "idempotencyKey": "ui:season:01J...",
  "summary": "Incorrect season recommendation",
  "payload": {
    "trigger": "manual",
    "report": "Users receive an incorrect season-open recommendation near the boundary."
  }
}
```

The orchestrator requires the server-assigned incident `id`,
`payload.trigger` (`manual` or `automated`), and a non-empty
`payload.report`. It supplies `cwd` from trusted local configuration and never
accepts a filesystem path from the queue.

The worker uses:

- `POST /api/incidents/claim` with `{ workerId, leaseSeconds }`. Emerald returns
  `204` when empty, or an atomic claim containing the incident,
  `attemptCount`, and `{ token, expiresAt }`.
- `POST /api/incidents/:id/lease` with the worker ID, claim token, lease
  duration, and latest triage state. State is one of `received`, `assessing`,
  `investigating`, `acting`, `awaiting_verification`, `verified_fixed`,
  `escalated`, `needs_human`, `failed`, or `budget_exceeded`.
- `POST /api/incidents/:id/complete` with an attempt-scoped `callbackId`,
  `outcome: "resolved"`, and the terminal incident result. Terminal result
  states are `verified_fixed`, `escalated`, `needs_human`, `failed`, and
  `budget_exceeded`. The callback excludes the local absolute `cwd`, raw
  token-by-token stream events, and oversized diagnostic text. The full record
  remains in the local JSON incident store.
- `POST /api/incidents/:id/fail` only when no terminal incident record can be
  produced, with the same attempt-scoped idempotency behavior plus
  `retryable`, optional `retryAfterSeconds`, and `error`.

Emerald owns queue status, atomic claim transactions, lease expiry, retry
delays, and the server-wide maximum attempt count. The recommended maximum is
three claims per incident. Callback retries reuse
`<incident-id>:<attempt-count>:complete|fail`; identical retries must return
success, while changed payloads and stale claim tokens return `409`.

The worker writes the detailed terminal record to
`.incident-orchestrator/incidents.json` under the directory where the worker
was launched before acknowledging completion. Keeping worker state outside the
target checkout prevents orchestrator bookkeeping from being mistaken for an
agent-authored source change during verification. All terminal triage states,
including a pipeline-recorded `failed` state, are completed processing results.
The failure endpoint is reserved for worker infrastructure, invalid ticket, or
persistence failures.

The publisher derives `owner/repository` from the target repository's `origin`
remote. Use `--github-repo owner/repository` or `--github-remote upstream` when
derivation is not appropriate. `INCIDENT_PUBLISH=true` provides the equivalent
environment opt-in.

Set `AGENT_RUNNER=stub` in `.env` to use deterministic fixture scripts instead.

Cursor local agents run with the SDK sandbox and Auto-review enabled by
default. The SDK no longer exposes the draft design's per-session
`allowTools`/`denyTools` options, so the adapter rejects those options rather
than silently ignoring them. Repository-level hooks and permissions remain the
hard policy boundary for built-in Cursor tools.

## Verification

The verifier does not trust the agent's success claim. It creates detached
temporary worktrees and checks that:

1. The agent-authored reproduction test fails against the pre-fix ref.
2. The same test passes against the claimed fix ref.
3. The full suite passes against the claimed fix ref.

When the reproduction test is new, its contents are copied into the pre-fix
worktree before the first check. Existing tests, CI configuration, and Vitest
configuration are protected from modification by the default verifier.
Controlled uncommitted source changes are overlaid into the post-fix worktrees,
and the verifier records the exact path set that passed all three gates.

## Outcome publication

For `verified_fixed`, the host-side publisher:

1. Rejects protected files, unrelated dirty files, extra tests, configuration,
   dependency manifests, and lockfiles.
2. Stages only the verified source paths and the single new reproduction test.
3. Creates a deterministic commit when verified changes are still uncommitted.
4. Pushes `incident-fix/<incident-id>` and opens a pull request targeting
   `main` (or `--publish-base`). It never pushes directly to or merges the base.
5. Creates an incident issue containing the report, assessment/autonomy
   decision, root-cause hypothesis and offending commit, fix and verification
   evidence, commit/branch/PR, request IDs, token usage, and state history.

For `escalated`, `needs_human`, `failed`, and `budget_exceeded`, publication is
issue-only and includes the available evidence and terminal failure/escalation
detail. Hidden incident-ID markers are queried before creation so reruns reuse
existing issues and pull requests. Publication URLs, numbers, branch, commit,
status, and errors are persisted with the incident in
`.incident-orchestrator/incidents.json`. A publication failure is explicit,
does not change the independent verification result, and causes the CLI to exit
non-zero.

## Layout

```text
src/
  agent/       AgentRunner boundary and stub/Cursor implementations
  config/      CLI and publication configuration parsing
  pipeline/    state machine, prompts, schemas, verification, orchestration
  publisher/   injectable host-side GitHub outcome publication
  queue/       typed Emerald HTTP client and serial lease-aware worker
  store/       atomic JSON incident persistence
  tools/       in-process investigation tools
  cli.ts       command-line entry point
  worker-cli.ts long-running Emerald incident queue entry point
```
