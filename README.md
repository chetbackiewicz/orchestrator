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
  store/       atomic JSON incident persistence
  tools/       in-process investigation tools
  cli.ts       command-line entry point
```
