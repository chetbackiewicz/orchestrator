# Incident orchestrator

A TypeScript orchestrator that drives an incident through:

```text
assess -> investigate -> act -> independently verify
```

The implementation keeps the agent runtime behind an `AgentRunner` interface.
Development and tests use a deterministic stub; production runs use the Cursor
SDK local runtime.

## Requirements

- Node.js 22.13 or newer
- npm
- A clean target repository with Vitest installed
- `CURSOR_API_KEY` when `AGENT_RUNNER=cursor`

## Install and validate

```bash
npm install
npm test
npm run typecheck
```

## Run

```bash
npm run triage -- \
  --id incident-season \
  --trigger manual \
  --report "users report an incorrect season-open recommendation" \
  --cwd ../emerald-osprey \
  --pre-fix-ref main
```

The default runner is `stub`. To use Cursor:

```bash
AGENT_RUNNER=cursor \
CURSOR_API_KEY=... \
CURSOR_MODEL=composer-2.5 \
npm run triage -- \
  --id incident-season \
  --trigger manual \
  --report "users report an incorrect season-open recommendation" \
  --cwd ../emerald-osprey \
  --pre-fix-ref main
```

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

## Layout

```text
src/
  agent/       AgentRunner boundary and stub/Cursor implementations
  pipeline/    state machine, prompts, schemas, verification, orchestration
  store/       atomic JSON incident persistence
  tools/       in-process investigation tools
  cli.ts       command-line entry point
```
