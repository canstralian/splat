# Splat / Splatt — Product and Agent Integration Specification

- Status: implementation baseline with open acceptance gaps; not production acceptance.
- Updated: 2026-09-22.
- Scope: existing Splat application and the governed agent integration in [PR #30](https://github.com/canstralian/splat/pull/30).
- Inspected implementation: `17f6c1027cad22a4e50f8ba21449495476d2d087`, branch `agent/cf-agent-runtime-0799`.
- Owner: repository maintainers. Requirements below are proposed project acceptance criteria, not claims of completed implementation.

## 1. Purpose and interpretation

Splat is a bug-tracking application for developers and small teams. This change adds an agent that can answer tasks and search bug records accessible to the authenticated user while reusing the existing Supabase identity and data plane.

This specification separates **observed implementation**, **required behavior**, and **validation evidence**. MUST denotes a release requirement; SHOULD denotes a recommendation whose exception needs a documented rationale. A requirement is not satisfied merely because it appears here.

Evidence labels used in this document:
- **SOURCE**: inspected repository implementation; not an execution result.
- **REPORTED**: author-supplied result not independently reproduced here.
- **EXECUTED**: a retrieved execution record; scope and commit must be identified.
- **[UNVERIFIED]**: missing execution evidence or unresolved deployment assumption.

## 2. Product scope and boundaries

Existing product areas are documented in [README.md](README.md): bug creation and tracking, Kanban/table views, comments, analytics, team/role management, settings, and Paddle billing. Route components reside in `src/pages/`; schema changes reside in `supabase/migrations/`. Their complete acceptance coverage was not audited for this spec.

The application uses React, TypeScript, Vite, and Supabase. Dependency versions MUST be taken from the package manifests and lockfiles, not older README badges.

**Architecture correction:** the repository already contains Supabase Edge Functions under `supabase/functions/` for `get-paddle-price`, `update-subscription`, and `payments-webhook`. “No existing backend/API” is therefore inaccurate. PR #30 adds a separate Cloudflare agent Worker alongside that existing backend.

In scope: governed task execution, per-user agent state, read-only bug search, capability-gated derived memory, a typed SPA client, and auditable run records.

Out of scope: replacing Supabase auth/database, changing billing, arbitrary shell/code execution, general URL browsing, autonomous bug mutation, scheduled monitoring, and production provisioning. A client helper is not proof of a shipped UI interaction or browser end-to-end integration.

## 3. Architecture and data ownership

| Component | Responsibility | Source |
| --- | --- | --- |
| SPA | Existing product UI; supply current user access token to agent client | [client](src/lib/agentClient.ts), [root manifest](package.json) |
| Supabase | Existing identity, application records, row policies, and billing functions | `supabase/`, `src/integrations/supabase/` |
| Worker | Authenticate, validate HTTP input, route requests, enforce read ownership | [entry point](agent/src/index.ts) |
| Durable Object | Session transcript and run coordination; addressed by user/session | [orchestrator](agent/src/agent/orchestrator-agent.ts) |
| D1 | Runs, ordered evidence, derived memory; versioned run updates | [store](agent/src/state/run-store.ts), `agent/migrations/` |
| R2 / Queue | Evidence artifacts and asynchronous audit bundles | [entry point](agent/src/index.ts), [configuration](agent/wrangler.jsonc) |
| KV | Tool-readable configuration; MUST contain only data safe for all permitted callers | [built-ins](agent/src/tools/builtins.ts) |
| Workers AI | Default inference; alternative providers are runtime configuration | `agent/src/model/` |

Supabase remains the source of truth for product bugs. D1 is agent application state, not a duplicate bug database. Bug results may nevertheless enter model context, session transcripts, and evidence; these are additional copies requiring explicit retention and access decisions.

Cloudflare services add operational cost and failure surfaces. Their inclusion does not prove they are all necessary at every scale. Keep them only while their documented responsibilities justify the maintenance burden.

## 4. Current HTTP and client contract

All endpoints except health authenticate before route handling. Default mode expects a Supabase bearer token. Explicit `service` mode uses `API_AUTH_TOKEN` and the principal `service`; it supplies no user token to the bug tool.

| Method and path | Current successful response / behavior |
| --- | --- |
| GET /health | 200; status, agent ID, version; does not establish dependency readiness |
| POST /v1/sessions/:sessionId/messages | `{ run }`; 200 completed, 202 awaiting approval, 403 denied, 422 other run outcome |
| GET /v1/sessions/:sessionId | `{ session, history }` for caller's namespaced object |
| GET /v1/runs/:runId | `{ run }`; 404 for missing or non-owned run |
| GET /v1/runs/:runId/evidence | `{ runId, evidence }`; same ownership guard |
| GET /v1/runs/:runId/replay | `{ replay }`; same ownership guard |

Current validation ([schema](agent/src/api/schema.ts)): message 1–20,000 characters; optional idempotency key up to 200 characters; optional approvals up to 32 strings of at most 128 characters; session ID 1–128 characters in `[A-Za-z0-9._:-]`. The run-ID validator allows alphanumeric characters and hyphens; it is not a strict UUID validator. Invalid input returns 400, authentication errors 401, unknown authenticated routes 404, and unhandled errors 500.

The [client](src/lib/agentClient.ts) accepts base URL, access token, session ID, message, optional approvals and abort signal. It exposes task and health helpers. It does not currently expose the API's idempotency key.

**Browser gap:** the Worker has no OPTIONS/preflight handling or CORS response headers. The documented separate-origin SPA-to-Worker flow therefore needs an allowlisted CORS implementation or a verified same-origin route. Tests MUST exercise a real browser origin, including error responses.

## 5. Execution, authority, and state

Authentication occurs at ingress, before run creation. It is not currently a `LifecycleStage` event. The implemented stage names are defined in [types](agent/src/types.ts); execution is in [lifecycle](agent/src/runtime/lifecycle.ts).

The flow assembles context, checks budget, asks the model for a schema-valid decision, checks the selected registered tool's capability, executes and validates the tool, updates state and evidence, and repeats or responds. Unknown tools and non-allow policy decisions MUST NOT execute.

Current defaults: eight tool calls, a 60,000 ms budget, and 10,000 ms default tool timeout. These are configured values, not proof of a hard end-to-end deadline. Blocking provider calls and cancellation behavior need explicit tests.

The policy uses an allowlist, with prohibited capabilities taking precedence. `memory:write` requires approval by default. Approvals currently arrive as caller-supplied capability strings; this is caller consent, not a separate administrator approval system. Model text MUST NOT grant capabilities. A run ending in `awaiting_approval` returns a pending capability; no dedicated resume endpoint is implemented.

| Tool | Current purpose |
| --- | --- |
| echo | Return bounded input text |
| calculator | Arithmetic without code evaluation |
| config_read | Read a syntactically valid KV key |
| memory_read / memory_write | Read/write derived memory; write requires policy approval |
| splat_bug_search | Search configured Supabase bugs using caller's token; no service-role key |

Bug search selects tracking ID, title, status, severity, category, and creation time, with a default limit of 10 and maximum 25. Actual visibility follows the deployed RLS policies; “only personally owned bugs” is not established by forwarding a token alone.

Run ownership and memory ownership are separate boundaries. Migration `0002` adds `owner_user_id` to runs; legacy rows default to an empty owner. Such rows MUST NOT be assigned to users by guessing.

## 6. Security requirements and acceptance tests

| ID | Required behavior | Observed status / acceptance evidence needed |
| --- | --- | --- |
| AUTH-01 | Validate signature, approved algorithm, expected issuer/audience, subject, required finite expiry, and optional not-before; reject malformed claims consistently | SOURCE: HS256 signature and subject checked; expiry only checked when numeric; issuer/audience not checked. Add negative tests for missing/wrong-type expiry, wrong issuer/audience, malformed JSON shapes, algorithm mismatch and boundary times |
| AUTH-02 | Select verification compatible with actual Supabase signing configuration; keep signing secrets out of client/model/logs | SOURCE: HS256-only custom verifier. [UNVERIFIED] project compatibility. Prefer maintained verification; assess JWKS or Auth-server validation before deployment |
| ISO-01 | Isolate runs, transcripts, evidence and memory by authenticated principal | SOURCE: DO names and run reads use ownership. **OPEN: memory queries/upserts use raw session ID + key without owner.** Two users choosing the same session/key address the same D1 memory. Add owner-scoped storage and cross-user read/write regression tests |
| GOV-01 | Deny absent/prohibited capabilities before side effects; approvals cannot override a deny | SOURCE: deterministic policy checks. Test authenticated adversarial prompts and each mutating path; missing-token rejection alone does not prove prompt-injection resistance |
| DATA-01 | Forward user token only to the configured trusted Supabase endpoint; enforce intended RLS visibility | SOURCE: token forwarding implemented. Test two real users, shared/team visibility, missing configuration, denied access and invalid upstream responses |
| WEB-01 | Support approved browser origin(s) without bypassing authentication | OPEN: no CORS handling. Test allowed/denied origins, preflight, bearer POST and error paths |
| SEC-01 | Exclude infrastructure secrets and auth tokens from every persistence/log/model path | [UNVERIFIED] comprehensive redaction. Current logging includes a message preview, and lifecycle evidence records full tool output; user-supplied sensitive text can therefore be persisted |
| REL-01 | Bound runs and retries; document mutation and duplicate-request semantics | SOURCE: every start creates a new run ID; caller idempotency key is not used to deduplicate runs. Do not advertise exactly-once execution. Test duplicate/concurrent requests, restart and timeout behavior |
| EVID-01 | Record ordered provenance and check replay invariants without re-executing side effects | Replay implementation exists; passing execution evidence remains separately required. Evidence classification does not certify external truth |
| OPS-01 | Define operational limits, failure visibility, retention and recovery before public exposure | [UNVERIFIED] rate limits, load/cost thresholds, retention, deletion, recovery and live provider behavior |

ISO-01 is a merge blocker for the advertised multi-user integration. AUTH-01 and WEB-01 also require repair or an explicit, reviewed restriction that prevents unsupported use; documenting a gap does not resolve it.

## 7. Evidence and reliability limits

Run statuses are `pending`, `running`, `awaiting_approval`, `completed`, `failed`, and `denied`. Normal lifecycle creation starts at `running`.

Evidence labels are `VERIFIED`, `INFERRED`, `MODEL_GENERATED`, and `UNVERIFIED`. In this runtime, VERIFIED describes an observed in-system operation, not the truth of arbitrary bug content or model answers. Replay is an audit/invariant check, not deterministic regeneration of model output.

The lifecycle records tool arguments and complete tool output. The bug-tool description's suggestion that only result counts are recorded is not an accurate description of the generic recorder. Retention and data-minimization decisions MUST account for this.

D1 compare-and-set protects an individual run row from stale updates. It does not establish an atomic transaction across DO state, D1, R2 and Queues. Whole-run serialization and crash consistency MUST be tested rather than inferred from the use of Durable Objects.

Queue enqueue errors are logged without failing the run. Archival retries write to a fixed R2 path, but include a new timestamp. Do not claim immutable or byte-identical archival, guaranteed archival completion, or exactly-once queue processing. Define dead-letter handling and recovery before deployment.

## 8. Validation record and completion gates

As reviewed on 2026-09-22, at implementation SHA above:

| Check | Evidence classification and result |
| --- | --- |
| Agent typecheck, lint, 48 tests, Wrangler dry-run | REPORTED in PR #30; not rerun during this documentation update |
| SPA typecheck, lint, 7 tests | REPORTED in PR #30; not rerun during this documentation update |
| GitHub Lint run 33839108543 | EXECUTED record inspected: failed during setup, before ESLint |
| Failure cause | Unable to resolve pinned `actions/setup-node@49933ea5288caeca8642d1e9af7e02d54d6953f0` |
| CodeRabbit status | Reported success by GitHub status API; not execution proof for application behavior |
| Live Supabase, live inference, browser integration | [UNVERIFIED] |
| This spec's source review | SOURCE only; no application code changes or new test results asserted |

[CI run](https://github.com/canstralian/splat/actions/runs/33839108543).
The author's linked Cursor artifact remains reported evidence until its contents and associated commit are inspected. A dry-run validates packaging/configuration, not live bindings, RLS, inference or deployment.

Reproducible validation commands, using the applicable committed lockfile and a recorded Node/npm version:

```bash
# Repository root
npm ci
npx tsc -p tsconfig.app.json
npm run lint
npm test
npm run build

# In agent/
npm ci --legacy-peer-deps
npm run typecheck
npm run lint
npm test
npx wrangler deploy --dry-run
```

These commands are acceptance instructions, not results of this update. The peer-dependency workaround is documented by the author; its underlying diagnosis is not independently verified here.

**Merge gate:** repair isolation/auth/browser gaps, resolve the action pin, execute applicable checks at the final implementation SHA, attach logs, and reconcile README claims with observed behavior. Add regression cases linked to requirement IDs. Do not convert historical passing counts into current-head evidence.

**Deployment gate:** independently verify actual signing keys, real two-user RLS, browser flow, live inference, resource bindings, migrations and legacy-row treatment. Keep scripted provider input disabled. Define numeric load/cost limits, telemetry, retention/deletion, queue recovery, credential rotation and rollback. These thresholds are TBD and must be resolved before production acceptance.

Provisioning, remote migrations, merge and deployment require their own authorization; maintaining this file does not grant it. Rollback planning must cover persistent schema compatibility and preserved evidence, not only Worker version rollback.

## 9. Maintenance and decisions

Update this file in the same PR whenever endpoints, auth, policy, ownership, schema, providers, bindings or release gates change. Preserve requirement IDs; update source SHA/date and evidence links. Each closed gap needs a test or observable acceptance result at an identified commit. Unresolved requirements stay visible.

The implementation is the reference for current behavior; this document defines intended acceptance. Disagreement is a tracked gap, not permission to assert the intended behavior already exists. The README remains the developer onboarding guide and must be kept consistent.

Recommended auth direction: use maintained verification compatible with the project's keys. JWKS verification reduces distribution of shared signing material but adds rotation/cache handling; Auth-server validation adds a network dependency. Do not add a silent unauthenticated fallback.

## 10. External guidance

Reviewed on 2026-09-22:

- [Supabase JWT guidance](https://supabase.com/docs/guides/auth/jwts): maintained verification, asymmetric JWKS, and Auth-server verification guidance for shared-secret tokens.
- [RFC 8725 — JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html): algorithm verification and issuer/subject/audience validation.
- [Cloudflare Durable Objects FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/): runtime/concurrency context; does not replace application concurrency tests.

The Supabase changelog index could not be retrieved during this update. No claim of exhaustive review of recent platform changes is made.
