# Splat Agent Runtime

A production-grade, **governed, evidence-first AI agent runtime** on Cloudflare
Workers, built with the [Agents SDK](https://developers.cloudflare.com/agents/).

> This is a **self-contained Worker subproject** with its own `package.json`,
> `wrangler.jsonc`, TypeScript, ESLint and test configuration. It does not share a
> build or runtime with the SPA, but it **integrates with Splatt at the product
> level**: it authenticates users with Splatt's existing **Supabase auth** and can
> read a user's Splatt data (bugs) through Supabase RLS on the user's behalf. The
> SPA calls it via `src/lib/agentClient.ts`. Root changes are limited to that
> client library (+ its test) and an ESLint ignore for `agent/`.

## Splatt integration

- **Authentication (reused, not reinvented):** the Worker verifies the user's
  Supabase access token (`AUTH_MODE=supabase`, HS256 via `SUPABASE_JWT_SECRET`).
  The authenticated Supabase `sub` is the isolation principal. A `service` mode
  (static `API_AUTH_TOKEN`) exists for trusted internal callers and never
  impersonates a user.
- **Isolation:** Durable Object sessions are namespaced `"<userId>::<sessionId>"`,
  so one user cannot address another's session; every Run is tagged with
  `owner_user_id` and read endpoints return `404` for non-owners.
- **Data:** the `splat_bug_search` tool queries the user's bugs via Supabase
  PostgREST using the user's own token, so Postgres RLS is fully enforced and no
  service-role key is used.
- **Frontend:** the SPA uses `src/lib/agentClient.ts` (`runAgentTask`,
  `checkAgentHealth`) with the current Supabase session token.

## Why this design

The runtime treats a single agent execution as a **Run** — the sole aggregate
root of the domain. Evidence records, tool calls and transcript messages are
children of a Run and are never independent aggregates. Every consequential
action passes an explicit governance gate, and every meaningful transition is
recorded as structured evidence so executions are **reproducible and auditable**
(not bit-identical — the goal is auditability, not LLM determinism).

## Architecture

```
Client ──HTTP──▶ Worker (src/index.ts)
                  │  auth (bearer), input validation, routing, queue consumer
                  ▼
        OrchestratorAgent (Durable Object, per session)
                  │  durable session state + transcript (DO SQLite)
                  ▼
        runLifecycle (src/runtime/lifecycle.ts)
   INPUT → INTENT → CONTEXT → POLICY → MODEL → TOOL-SELECT →
   POLICY(gate) → TOOL-EXEC → VALIDATE → STATE → EVIDENCE → RESPONSE
        │            │            │              │
   ModelProvider  ToolRegistry  PolicyEngine  EvidenceRecorder
   (workers-ai/    (+ builtins)  (governance)  (D1 ledger + R2)
    openai/scripted)
                  │
                  ▼         RunStore (D1, optimistic concurrency) ── replayRun()
                  ▼
        BACKGROUND_QUEUE ──▶ queue consumer ──▶ R2 audit bundle
```

### Cloudflare services

| Service | Binding | Purpose |
| --- | --- | --- |
| Durable Objects | `ORCHESTRATOR` | Per-session agent instance, durable state, transcript, serialized concurrency |
| D1 | `DB` | Run ledger (`runs`), evidence (`run_events`), derived memory (`agent_memory`) |
| R2 | `EVIDENCE_BUCKET` | Large evidence artifacts + consolidated per-run audit bundles |
| KV | `CONFIG_KV` | Lightweight configuration/cache reads |
| Queues | `BACKGROUND_QUEUE` | Asynchronous, idempotent evidence archival |
| Workers AI | `AI` | Default inference provider |

### Agent lifecycle (observable & testable stages)

`INPUT → INTENT/TASK CLASSIFICATION → CONTEXT ASSEMBLY → POLICY/GOVERNANCE CHECK
→ MODEL REASONING → TOOL SELECTION → TOOL EXECUTION → RESULT VALIDATION →
STATE UPDATE → EVIDENCE RECORDING → RESPONSE`

Each transition emits an evidence record. The reasoning loop is bounded by
governance (`maxToolCalls`, `maxWallClockMs`), independent of the model.

### Tool / capability model

Tools (`src/tools/`) declare `name`, `description`, Zod `inputSchema`/`outputSchema`,
`requiredCapability`, `effect` (`read_only` | `mutating`), `timeoutMs`,
`failureBehavior` and the evidence they produce. Arguments are validated before
execution; output is validated after. Arbitrary invocation is impossible — a tool
must be registered and its capability granted by policy. Built-ins: `echo`,
`calculator`, `config_read`, `memory_read`, `memory_write` (mutating, idempotent),
and `splat_bug_search` (reads the user's Splatt bugs via Supabase RLS).

### Governance model

`PolicyEngine` (`src/governance/policy.ts`) is pure and deterministic. It exposes
`checkBudget()` (pre-flight) and `authorizeTool()` (the capability gate evaluated
immediately before every tool call), returning `allow` / `deny` / `escalate`.
Denied capabilities and approval escalations stop execution **before** the tool
runs. The model never enforces governance.

### State & memory model

| Layer | Home | Notes |
| --- | --- | --- |
| Ephemeral execution state | in-memory during a Run | never persisted |
| Durable agent/session state | DO state + DO SQLite | small; `runCount`, transcript |
| User/application data (Runs) | D1 `runs` | optimistic concurrency (`version` CAS) |
| Derived memory | D1 `agent_memory` | idempotent writes |
| Evidence / audit | D1 `run_events` + R2 | append-only, `seq`-ordered |

Concurrency is safe: a Durable Object serializes calls to one instance, and the
Run ledger additionally detects stale writes via compare-and-set.

### Evidence & replay model

Every evidence record carries a `Verification` label: `VERIFIED` (in-system
operation), `INFERRED` (runtime-derived), `MODEL_GENERATED` (untrusted LLM
output) or `UNVERIFIED` (external input). Model-generated claims are never
recorded as verified facts. `replayRun()` (`src/replay/replay.ts`) reconstructs a
Run from evidence and checks invariants (dense `seq`, every tool execution
preceded by an `allow` gate, tool count matches the ledger, terminal stage
present).

### Security

Least privilege throughout: **Supabase JWT auth** at the Worker boundary
(fail-closed if the secret is unset; authorization always derives from the
runtime check, never from prompt/model content), per-user/session isolation, all
external input validated with Zod, model output treated as untrusted, capability
gates on every tool, no arbitrary URL fetch or code execution, and secrets read
only from bindings — never placed in prompts, evidence, or logs. The user's
access token is forwarded only to user-scoped tools (e.g. `splat_bug_search`) and
is never exposed to the model.

## Development

```bash
npm install --legacy-peer-deps   # see "Install note" below
npm run typecheck                # tsc --noEmit
npm run lint                     # eslint
npm test                         # vitest (Workers runtime, fully local)
npx wrangler deploy --dry-run    # validate config + bundle
```

### Install note

`@cloudflare/vitest-pool-workers` pulls in `vitest@4`, whose peer graph triggers a
known crash in npm 10.9.x (`Cannot read properties of null (reading 'edgesOut')`).
Install with `--legacy-peer-deps` (or npm ≥ 11). The `agents` SDK statically
imports its MCP client, so `@modelcontextprotocol/{client,sdk,server}` are pinned
as explicit dependencies even though MCP features are not used here.

## Deployment

```bash
wrangler d1 create agent_runtime           # put the id into wrangler.jsonc
wrangler kv namespace create CONFIG_KV      # put the id into wrangler.jsonc
wrangler r2 bucket create splat-agent-evidence
wrangler queues create splat-agent-background
wrangler queues create splat-agent-background-dlq
wrangler d1 migrations apply agent_runtime --remote
# Splatt auth + data (reuse the same Supabase project as the SPA):
wrangler secret put SUPABASE_JWT_SECRET     # required for AUTH_MODE=supabase
#   set SUPABASE_URL and SUPABASE_ANON_KEY (wrangler.jsonc vars or secrets) for splat_bug_search
wrangler secret put API_AUTH_TOKEN          # optional (service mode only)
wrangler secret put MODEL_API_KEY           # only for the openai-compatible provider
wrangler deploy
```

In the SPA, call the agent with the current session token:

```ts
import { runAgentTask } from "@/lib/agentClient";
const { data } = await supabase.auth.getSession();
const run = await runAgentTask({
  baseUrl: import.meta.env.VITE_AGENT_URL,
  accessToken: data.session!.access_token,
  sessionId: "triage",
  message: "search my open login bugs",
});
```

## HTTP API

| Method & path | Description |
| --- | --- |
| `GET /health` | Unauthenticated health check |
| `POST /v1/sessions/:sessionId/messages` | Run the agent for one message |
| `GET /v1/sessions/:sessionId` | Session summary + transcript |
| `GET /v1/runs/:runId` | Run ledger row |
| `GET /v1/runs/:runId/evidence` | Full evidence ledger |
| `GET /v1/runs/:runId/replay` | Reconstructed, invariant-checked Run |

All routes except `/health` require `Authorization: Bearer <API_AUTH_TOKEN>`.
