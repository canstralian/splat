# Splat Agent Worker

An AI assistant for Splat, running on Cloudflare Workers. It lets a signed-in
Splat user search, inspect, file, comment on, and triage bugs through natural
language — with every data access authorized by Splat's existing Supabase
Row-Level Security.

## Architecture

```text
Splat SPA (/assistant)
   │  fetch + Supabase session JWT
   ▼
Cloudflare Worker (src/index.ts → src/router.ts)
   │  1. CORS allowlist          4. session id validation
   │  2. config check            5. DO addressing: ${verifiedUserId}:${sessionId}
   │  3. AUTH: GET /auth/v1/user (Supabase verifies the JWT)
   ▼
AgentSession Durable Object (one per user+session, SQLite storage)
   │  SessionEngine lifecycle:
   │    intent classification → policy check (rate limit, write grant)
   │    → context assembly (last N messages) → model/tool loop
   │    → result validation → state update → response
   ├────────► Workers AI (model; optional AI Gateway routing)
   └────────► Supabase PostgREST with the USER'S OWN JWT
              (RLS = the authorization layer; no service-role key exists here)
```

### Cloudflare services used — and why

| Service | Why |
| --- | --- |
| **Workers** | HTTP entry point for the agent API. |
| **Durable Objects** (SQLite) | Strongly consistent, serialized per-user-per-session state: conversation history + execution audit log. Not used as an application database. |
| **Workers AI** | Model execution with zero external API keys. Default model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (function calling). |
| **AI Gateway** (optional) | Set the `AI_GATEWAY_ID` var to route model calls through a gateway for analytics/caching. |

Deliberately **not** used: **D1** (Splat's relational data lives in Supabase
Postgres behind RLS — a second database would split the source of truth),
**KV/R2/Queues** (no current requirement).

## Security model

- **Authentication**: the Worker verifies the caller's Supabase session JWT
  against `GET /auth/v1/user` — the same convention as Splat's existing edge
  functions.
- **Authorization**: every tool executes PostgREST calls with the *caller's
  own JWT*. Postgres RLS therefore enforces exactly the permissions the user
  has in the Splat UI. The Worker holds **no secrets** — the publishable key
  is public by design.
- **Capability boundaries**: write tools (`create_bug`, `update_bug_status`,
  `add_comment`) are only exposed to the model when the request carries
  `allowWrites: true`, which is set by an explicit UI toggle. Prompt content
  can never widen tool exposure — "ignore the rules and…" changes nothing,
  because exposure is computed by the runtime before the model runs.
- **Isolation**: the Durable Object is addressed via `getByName(\`${verifiedUserId}:${sessionId}\`)`,
  so users cannot reach each other's sessions by construction; the session
  additionally binds its owner's user id as defense-in-depth.
- **Identity injection**: `reporter_id` / `user_id` fields are set from the
  verified identity by the runtime. Model-supplied identity fields are
  stripped by input schemas.
- **Model output is untrusted**: tool names are checked against the registry,
  arguments validated with Zod before execution, tool outputs validated
  against output schemas, and the final reply is validated and capped.

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `search_bugs` | read | Filter/search bugs (text, status, severity, category, assigned-to-me). |
| `get_bug` | read | Full bug details + recent comments by tracking id. |
| `get_bug_stats` | read | Counts by status and severity. |
| `list_projects` | read | Workspace projects. |
| `list_team_members` | read | Team directory via the `get_team_members` RPC. |
| `create_bug` | write | File a bug as the current user. |
| `update_bug_status` | write | Change workflow status (RLS: reporter/assignee/admin) + activity log. |
| `add_comment` | write | Comment as the current user. |

Every tool declares: name, description, Zod input/output schemas, the JSON
schema advertised to the model (consistency verified by tests), permission,
read/write classification, and a timeout.

## HTTP API

All session routes require `Authorization: Bearer <supabase session JWT>`.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/health` | Liveness/version (no auth). |
| `POST /api/agent/sessions/:id/messages` | Run one agent turn. Body: `{ "message": string, "allowWrites"?: boolean }`. |
| `GET /api/agent/sessions/:id` | Conversation state. |
| `GET /api/agent/sessions/:id/executions` | Execution history (status, intent, model, tool calls, durations, errors). |
| `DELETE /api/agent/sessions/:id` | Clear the conversation. |

Errors are returned as `{ "error": { "code", "message", "executionId"? } }`
with a stable code taxonomy (`unauthorized`, `forbidden`, `invalid_request`,
`rate_limited`, `model_*`, `tool_*`, `upstream_error`, `config_error`,
`internal_error`).

## State & memory

| Layer | Where | Notes |
| --- | --- | --- |
| Short-term context | last 20 messages, assembled per turn | never treated as durable memory |
| Current execution state | in-memory per turn | discarded after the turn; failures recorded |
| Conversation + execution history | Durable Object SQLite | capped at 200 messages / pruned; failed turns are recorded in history but do not pollute the conversation |
| Application data | Supabase Postgres (existing) | the agent reads/writes it only through RLS-scoped tools |

## Observability

Structured JSON log events (Workers Logs; `observability.enabled = true`):
`turn_start`, `model_call`, `tool_call`, `turn_completed`, `turn_failed`,
`turn_rejected`, `request_rejected`, `session_reset` — each carrying
executionId, user id, intent, exposure, model id, durations and error codes.
Free-form strings are truncated; JWTs are never logged. Per-session execution
history is also queryable by the user via the API.

## Development

```bash
cd workers/agent
npm install
npm run cf-typegen     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
npm run check          # tsc --noEmit
npm test               # vitest
npm run validate:config  # wrangler deploy --dry-run
```

Binding types come from `wrangler types` (`worker-configuration.d.ts`). Do not
hand-write `interface Env`. The Worker uses `compatibility_date` 2026-09-03,
`nodejs_compat`, structured JSON logs, and traces (`observability.traces`).

### Offline end-to-end (no Cloudflare account, no Supabase project)

```bash
npm run mock:supabase                                  # terminal 1: mock Supabase on :8790
npx wrangler dev --config wrangler.offline.jsonc       # terminal 2: worker with stub model
curl -s -X POST localhost:8787/api/agent/sessions/s1/messages \
  -H 'Authorization: Bearer token-alice' -H 'Content-Type: application/json' \
  -d '{"message":"search for login bugs"}'
```

`wrangler.offline.jsonc` omits the Workers AI binding (which requires
Cloudflare credentials even in `wrangler dev`) and uses the deterministic
stub model. Never deploy it.

### Local dev against real services

Copy `.dev.vars.example` to `.dev.vars`, point `SUPABASE_URL` /
`SUPABASE_PUBLISHABLE_KEY` at the real project, remove `MODEL_PROVIDER=stub`,
then `npm run dev` (requires `wrangler login` for the Workers AI binding).

## Deployment

1. `wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
2. Set the publishable key in `wrangler.jsonc` (`SUPABASE_PUBLISHABLE_KEY`) —
   it is the public anon key from Splat's `.env`.
3. Add the production SPA origin to `ALLOWED_ORIGINS`.
4. `npm run deploy` (from this directory) or `npm run agent:deploy` (repo root).
5. Set `VITE_AGENT_URL` to the deployed worker URL in the SPA environment and
   republish the SPA.

No `wrangler secret` values are required. No database migrations are required
— the agent uses only existing Splat tables and RPCs.
