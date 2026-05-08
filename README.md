# Splat

> **Crush bugs faster. Ship more.**
>
> Splat is an indie‑developer‑focused bug tracker built for small teams that want Linear‑grade ergonomics without the enterprise overhead. It pairs a fast, real‑time Kanban/Table workspace with built‑in analytics, role‑based access, team invitations, and a self‑serve Paddle‑powered subscription tier.

[![Built with Lovable](https://img.shields.io/badge/Built%20with-Lovable-ff2d87?style=flat-square)](https://lovable.dev)
![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646cff?style=flat-square&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38bdf8?style=flat-square&logo=tailwindcss&logoColor=white)
![Supabase](https://img.shields.io/badge/Backend-Lovable%20Cloud-3ecf8e?style=flat-square&logo=supabase&logoColor=white)

---

## Table of contents

1. [Overview](#overview)
2. [Feature highlights](#feature-highlights)
3. [Tech stack](#tech-stack)
4. [Architecture](#architecture)
5. [Project structure](#project-structure)
6. [Getting started](#getting-started)
7. [Environment variables](#environment-variables)
8. [Available scripts](#available-scripts)
9. [Database & backend](#database--backend)
10. [Authentication & roles](#authentication--roles)
11. [Billing (Paddle)](#billing-paddle)
12. [Design system](#design-system)
13. [Testing](#testing)
14. [Security](#security)
15. [API reference](#api-reference)
16. [Deployment](#deployment)
17. [Contributing](#contributing)
18. [License](#license)

---

## Overview

Splat is a full‑stack web application for tracking bugs, triaging severity, and shipping fixes as a team. It is built on top of **Lovable Cloud** (managed Postgres + Auth + Storage + Edge Functions) and a modern **React + Vite + TypeScript + Tailwind** front end.

The product is intentionally opinionated:

- **Real‑time** by default — bug and comment changes stream over WebSockets.
- **Mobile‑first** UI with a Linear‑inspired dark aesthetic and neon magenta accents.
- **Self‑serve teams** — any signed‑in user can invite collaborators and manage roles.
- **Paid tier** wired through Paddle (sandbox + live) with proration‑free plan changes that take effect at the next renewal.

## Feature highlights

| Area | What you get |
| --- | --- |
| **Bug tracking** | Sequential `SPL‑XXXXX` IDs, severity (`blocker`/`major`/`minor`/`polish`), status workflow (`backlog` → `in_progress` → `in_review` → `shipped`/`wont_fix`), category tagging, full‑text search, attachments. |
| **Views** | Dual Kanban + Table view, project filters, assignee assignment, SLA deadlines. |
| **Comments & activity** | Threaded comments and a per‑bug activity log, both real‑time. |
| **Analytics** | Six Recharts visualizations (status mix, severity distribution, throughput, etc.) using the project’s neon palette. |
| **Team & roles** | `admin` / `moderator` / `user` roles stored in a dedicated `user_roles` table with a `has_role()` security‑definer helper. Email + Google OAuth invitations. |
| **Settings** | Profile, company settings (with audit trail), notification preferences, avatar uploads (≤ 5 MB). |
| **Billing** | Paddle checkout, plan upgrades/downgrades that schedule at next renewal, webhook‑driven subscription sync. |
| **Security audit page** | In‑app `/security` view that documents every fix applied to the codebase. |

## Tech stack

**Frontend**
- React 18, TypeScript 5, Vite 5
- Tailwind CSS 3 + `tailwindcss-animate` + `@tailwindcss/typography`
- shadcn/ui (Radix primitives) + `lucide-react`
- TanStack Query for server state
- React Router v6
- React Hook Form + Zod for validation
- Recharts for analytics
- `next-themes` for theme switching
- `@react-three/fiber` + `drei` for the 3D landing logo

**Backend (Lovable Cloud / Supabase)**
- Postgres with Row‑Level Security on every table
- Supabase Auth (email/password + Google OAuth)
- Supabase Storage (`avatars` public bucket, `bug-attachments` private bucket)
- Supabase Realtime on `bugs` and `comments`
- Deno Edge Functions for Paddle integration

**Tooling**
- Vitest + Testing Library + jsdom
- ESLint 9 (`typescript-eslint`, React Hooks, React Refresh)
- Playwright (installed for future E2E)

## Architecture

```text
┌────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                       │
│   React + Vite + Tailwind + shadcn/ui + TanStack Query     │
└──────────┬───────────────────────────────────┬─────────────┘
           │ supabase-js (REST + Realtime WS)  │ fetch()
           ▼                                   ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│      Lovable Cloud       │       │      Edge Functions      │
│  (Supabase: Postgres,    │◀─────▶│  get-paddle-price        │
│   Auth, Storage,         │       │  update-subscription     │
│   Realtime)              │       │  payments-webhook        │
└──────────┬───────────────┘       └──────────────┬───────────┘
           │                                      │
           ▼                                      ▼
     RLS‑protected tables                 Paddle Billing API
```

All client traffic is authenticated through Supabase Auth. RLS policies are *deny by default* — every read/write requires an explicit policy referencing `auth.uid()` or `public.has_role()`.

## Project structure

```text
.
├── public/                       # Static assets (robots.txt, og images, …)
├── src/
│   ├── assets/                   # Imported images / 3D textures
│   ├── components/               # Reusable UI (AppSidebar, NavLink, badges, ui/*)
│   │   └── ui/                   # shadcn/ui primitives
│   ├── contexts/                 # AuthContext (session + profile)
│   ├── hooks/                    # usePaddleCheckout, useSubscription, use-toast, …
│   ├── integrations/
│   │   ├── lovable/              # Lovable Cloud client helpers
│   │   └── supabase/             # ⚠️ Auto‑generated client.ts & types.ts — do not edit
│   ├── lib/                      # paddle.ts, utils.ts (cn, formatters)
│   ├── pages/                    # Route components (Dashboard, BugList, Auth, …)
│   ├── test/                     # Vitest setup + sample tests
│   ├── App.tsx                   # Routes + providers
│   ├── main.tsx                  # Entry
│   └── index.css                 # Design tokens (HSL CSS variables)
├── supabase/
│   ├── config.toml               # Project + per‑function config
│   ├── functions/                # Deno edge functions
│   │   ├── _shared/paddle.ts
│   │   ├── get-paddle-price/
│   │   ├── update-subscription/
│   │   └── payments-webhook/
│   └── migrations/               # SQL migrations (timestamped)
├── tailwind.config.ts            # Theme tokens + plugins
├── vite.config.ts                # Vite + SWC + path aliases (@/ → src/)
├── vitest.config.ts              # Test runner config
└── package.json
```

## Getting started

### Prerequisites

- **Node.js ≥ 20** (or **Bun ≥ 1.1** — the repo is Bun‑friendly)
- A Lovable account with **Lovable Cloud** enabled (provides Supabase project, Auth, Storage, Edge Functions)

### Local setup

```bash
# 1. Clone
git clone <YOUR_GIT_URL>
cd <YOUR_PROJECT_NAME>

# 2. Install dependencies
npm install        # or: bun install

# 3. Copy env template (Lovable Cloud auto‑populates these in the cloud editor)
cp .env.example .env   # if present, otherwise see below

# 4. Run the dev server
npm run dev
```

The dev server runs at <http://localhost:8080> by default (see `vite.config.ts`).

> 💡 When working inside Lovable, dependencies, env vars, and the database are managed for you. The steps above only matter for local development.

## Environment variables

`.env` is generated automatically by Lovable Cloud — **never edit it by hand**. Expected variables:

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Public Supabase URL used by the client SDK. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Anon/publishable key for the client SDK. |
| `VITE_SUPABASE_PROJECT_ID` | Project ref, used by edge function helpers. |
| `VITE_PAYMENTS_CLIENT_TOKEN` | Paddle client‑side token (sandbox in `.env.development`). |

**Server‑side secrets** (set via Lovable Cloud → Secrets, never committed):

| Secret | Used by |
| --- | --- |
| `PADDLE_SANDBOX_API_KEY` / `PADDLE_LIVE_API_KEY` | Edge functions calling Paddle. |
| `PAYMENTS_SANDBOX_WEBHOOK_SECRET` / `PAYMENTS_LIVE_WEBHOOK_SECRET` | Verifying Paddle webhook signatures. |
| `LOVABLE_API_KEY` | Lovable AI Gateway. |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server operations from edge functions. |

## Available scripts

```bash
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run build:dev    # Development‑mode build (sourcemaps, no minify)
npm run preview      # Preview the production build locally
npm run lint         # Run ESLint over the project
npm test             # Run Vitest once
npm run test:watch   # Vitest in watch mode
```

## Database & backend

- All schema changes live in `supabase/migrations/` and are applied automatically by Lovable Cloud.
- The TypeScript schema in `src/integrations/supabase/types.ts` is **auto‑generated** — do not edit by hand.
- Bug IDs are generated by the `generate_tracking_id()` trigger using the `bug_tracking_seq` sequence (`SPL-00001`, `SPL-00002`, …).
- Profiles are auto‑created via the `handle_new_user()` trigger on `auth.users` insert.
- Real‑time is enabled on the `bugs` and `comments` tables via the `supabase_realtime` publication.

### Adding migrations

Use the Lovable database migration tool (or the Supabase CLI locally). Migrations should be additive when possible and must:

- Enable RLS on every new table (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`).
- Define explicit, role‑scoped policies — never rely on a default‑allow stance.
- Use **validation triggers** rather than `CHECK` constraints for time‑based rules (Postgres requires `CHECK` to be immutable).

## Authentication & roles

- Email/password and Google OAuth are both supported on `/auth`.
- Roles live in a **separate** `user_roles` table — never on `profiles`. Look‑ups go through the `has_role(_user_id, _role)` security‑definer function to avoid RLS recursion.
- Protected routes use `<ProtectedRoute>` (see `src/components/ProtectedRoute.tsx`) and rely on the session in `AuthContext`.
- This project is intentionally a **self‑serve team template**: any authenticated user can see team‑wide data and grant themselves roles. Tighten the RLS policies on `user_roles` and `invitations` before shipping a multi‑tenant build.

## Billing (Paddle)

- Client‑side checkout is bootstrapped via `src/hooks/usePaddleCheckout.ts` using `VITE_PAYMENTS_CLIENT_TOKEN`.
- Plan changes go through the `update-subscription` edge function and are scheduled to take effect at the **next renewal** with no immediate proration charges.
- The `payments-webhook` edge function verifies Paddle’s signature and syncs `subscriptions` rows.
- `has_active_subscription()` and `get_subscription_tier()` SQL helpers are available for gating premium features.

Sandbox vs live is selected by the `environment` column on `subscriptions` and the corresponding pair of API/webhook secrets.

## Design system

- **Visual direction:** Linear‑inspired, dark mode by default, magenta primary (`322 85% 52%` light / `322 90% 60%` dark) with neon accents and crisp grid lines.
- **All colors are HSL CSS variables** declared in `src/index.css` and exposed to Tailwind through `tailwind.config.ts`. Components must use semantic tokens (`bg-background`, `text-primary-foreground`, …) — never raw color classes.
- Buttons follow a high‑contrast variant system via `class-variance-authority`.
- Mobile‑first layouts; touch targets are at least 44 × 44 px; the sidebar collapses into a `Sheet` below the `md` breakpoint.

## Testing

```bash
npm test
```

- Vitest with the `jsdom` environment.
- Test setup in `src/test/setup.ts` (loads `@testing-library/jest-dom`).
- Add component tests next to the components they cover, or under `src/test/`.

## Security

- **RLS everywhere.** Every table is RLS‑enabled with explicit policies.
- **Generic error toasts.** User‑facing errors never leak raw exception messages — full errors are logged server‑side via `console.error`.
- **JWT‑gated edge functions.** Sensitive functions validate `Authorization` headers with `supabase.auth.getUser()` before doing work.
- **Folder‑scoped storage.** The `avatars` bucket only allows users to read their own folder; the `bug-attachments` bucket is fully private.
- **Audit trail.** The in‑app `/security` page lists every applied fix and the files it touched. The `company_settings_audit` table records change history for company settings.

If you discover a vulnerability, please open a private issue or contact the maintainer directly — do not disclose publicly until a fix is shipped.

## API reference

Splat does not expose a custom REST API. The frontend talks to **Lovable Cloud** through `supabase-js` (PostgREST + Realtime) and to a small set of **Deno edge functions** for Paddle billing. This section documents both surfaces, the request/response shape they expect, and the RLS/auth rules that gate them.

### Auth header & client

All authenticated calls require a Supabase session JWT. The browser SDK attaches it automatically:

```ts
import { supabase } from "@/integrations/supabase/client";
// supabase-js sends `Authorization: Bearer <access_token>` and `apikey: <publishable key>`
```

For direct `fetch()` calls to PostgREST or edge functions:

```http
Authorization: Bearer <supabase access_token>
apikey: <VITE_SUPABASE_PUBLISHABLE_KEY>
Content-Type: application/json
```

Unauthenticated calls are rejected by RLS (tables) or by an explicit `getUser()` check (edge functions).

### Database tables (PostgREST)

Base URL: `${VITE_SUPABASE_URL}/rest/v1/<table>`. All tables have RLS **enabled**; the policies below are the *only* paths that succeed.

#### `bugs`

Sequential `SPL-XXXXX` tracking IDs assigned by the `generate_tracking_id()` trigger.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | PK, server-generated |
| `tracking_id` | text | Auto: `SPL-00001`, `SPL-00002`, … |
| `title` | text | required |
| `description` | text | default `''` |
| `steps_to_reproduce` / `expected_behavior` / `actual_behavior` | text | optional |
| `status` | enum | `backlog` \| `in_progress` \| `in_review` \| `shipped` \| `wont_fix` |
| `severity` | enum | `blocker` \| `major` \| `minor` \| `polish` |
| `category` | enum | `ui` \| `logic` \| `performance` \| `infra` \| `content` |
| `environment` | text | free-form (e.g. `prod`, `staging`) |
| `reporter_id` | uuid | required, must equal `auth.uid()` on insert |
| `assignee_id` / `project_id` | uuid | optional |
| `sla_deadline` | timestamptz | optional |
| `created_at` / `updated_at` | timestamptz | server-managed |

**RLS**

| Op | Who |
| --- | --- |
| SELECT | any authenticated user |
| INSERT | authenticated, `reporter_id = auth.uid()` |
| UPDATE | reporter, assignee, or `admin` role |
| DELETE | `admin` role only |

#### `comments`

| Field | Type | Notes |
| --- | --- | --- |
| `bug_id` | uuid | required |
| `user_id` | uuid | required, must equal `auth.uid()` |
| `content` | text | required |

**RLS:** SELECT any authenticated; INSERT/UPDATE/DELETE only own rows. Realtime-enabled.

#### `attachments`

| Field | Type | Notes |
| --- | --- | --- |
| `bug_id` | uuid | required |
| `user_id` | uuid | must equal `auth.uid()` on insert |
| `file_name` / `file_path` | text | required |
| `mime_type` | text | optional |
| `file_size` | bigint | bytes |

**RLS:** SELECT any authenticated; INSERT only own; DELETE only own. Files live in the private `bug-attachments` bucket.

#### `activity_log`

Append-only audit of bug changes (`status`, `assignee`, etc.). SELECT any authenticated; INSERT only with `auth.uid() = user_id`; no UPDATE/DELETE.

#### `profiles`

`user_id`, `full_name`, `job_title`, `avatar_url`. Auto-created by the `handle_new_user()` trigger. SELECT any authenticated; INSERT/UPDATE only own row.

#### `user_roles`

`user_id`, `role` (`admin` \| `moderator` \| `user`). SELECT any authenticated (team-wide visibility). INSERT/UPDATE/DELETE require `admin` role. Always check membership via `public.has_role(_user_id, _role)` to avoid RLS recursion.

#### `projects`

`name`, `description`, `created_by`. SELECT any authenticated; full ALL access for `admin` role.

#### `invitations`

`email`, `role`, `invited_by`, `status`, `expires_at` (default `now() + 7 days`). SELECT/DELETE for inviter or admin. INSERT requires `invited_by = auth.uid()` AND (`role = 'user'` OR caller is admin).

#### `notification_preferences`

Boolean flags: `email_on_assignment`, `email_on_comment`, `email_on_status_change`, `email_on_new_bug`, `email_on_sla_breach`, `daily_digest`. SELECT/INSERT/UPDATE only own row.

#### `company_settings` & `company_settings_audit`

Owner-only CRUD on `company_settings`. Every UPDATE/DELETE is mirrored into `company_settings_audit` by the `log_company_settings_change()` trigger. Audit rows are visible to the owner or any `admin`; inserts/updates/deletes are blocked.

#### `subscriptions`

Written by edge functions only.

| Field | Type | Notes |
| --- | --- | --- |
| `user_id` | uuid | links to `auth.users` |
| `paddle_subscription_id` | text | unique key for upserts |
| `paddle_customer_id` | text | |
| `product_id` / `price_id` | text | human-readable IDs (`starter_plan`, `starter_monthly`) |
| `status` | text | `active` \| `trialing` \| `past_due` \| `canceled` |
| `current_period_start` / `current_period_end` | timestamptz | |
| `cancel_at_period_end` | bool | |
| `scheduled_change_action` / `scheduled_change_effective_at` | text / timestamptz | downgrade/upgrade scheduling |
| `environment` | text | `sandbox` \| `live` — **always filter on this** |

**RLS:** users SELECT only their own row; `service_role` has full ALL access.

### SQL helper functions (RPC)

Call via `supabase.rpc('<name>', { ...args })`. All have `SET search_path = public` and the security mode shown.

| Function | Args | Returns | Security | Purpose |
| --- | --- | --- | --- | --- |
| `has_role` | `_user_id uuid`, `_role app_role` | `bool` | DEFINER | RLS-safe role check |
| `has_active_subscription` | `check_env text` (default `'live'`) | `bool` | INVOKER | Gate premium features |
| `get_subscription_tier` | `check_env text` (default `'live'`) | `text` (product id) | INVOKER | Return current tier |
| `get_team_members` | — | `setof (user_id, full_name, job_title, avatar_url, role)` | INVOKER | Team directory; requires `auth.uid()` |

### Storage

Base URL: `${VITE_SUPABASE_URL}/storage/v1`.

| Bucket | Public | Read | Write |
| --- | --- | --- | --- |
| `avatars` | ✅ (CDN URLs resolve) | Listing scoped to `auth.uid()`-prefixed folder | Owner folder only, ≤ 5 MB |
| `bug-attachments` | ❌ | Authenticated via signed URLs | Owner folder only |

Upload paths must start with the user's UID, e.g. `avatars/<uid>/avatar.png` — enforced by `storage.foldername(name)[1] = (auth.uid())::text`.

### Realtime

The `supabase_realtime` publication includes `bugs` and `comments`. Subscribe with the JS SDK:

```ts
supabase
  .channel("bugs")
  .on("postgres_changes", { event: "*", schema: "public", table: "bugs" }, handler)
  .subscribe();
```

Realtime payloads still respect RLS — clients only receive rows they could `SELECT`.

### Edge functions

Base URL: `${VITE_SUPABASE_URL}/functions/v1/<name>`. CORS is open (`*`); auth is enforced per-function as noted.

#### `POST /functions/v1/get-paddle-price`

Resolves a human-readable Paddle price external ID to its internal `pri_…` ID for checkout.

- **Auth:** requires `Authorization: Bearer <jwt>`; rejects with `401` if `supabase.auth.getUser()` fails.
- **Request:**
  ```json
  { "priceId": "starter_monthly", "environment": "sandbox" }
  ```
- **Response 200:** `{ "paddleId": "pri_01h…" }`
- **Response 404:** `{ "error": "Price not found" }`
- **Response 500:** `{ "error": "An internal error occurred" }` (details logged server-side)

#### `POST /functions/v1/update-subscription`

Schedules a plan change at the next renewal (no immediate proration).

- **Auth:** requires session JWT; the function loads the user's own subscription before mutating.
- **Request:**
  ```json
  {
    "subscriptionId": "sub_01h…",
    "newPriceId": "team_monthly",
    "environment": "sandbox"
  }
  ```
- **Response 200:** `{ "success": true, "scheduledChange": { "action": "…", "effectiveAt": "…" } }`
- **Errors:** `401` unauthenticated, `403` if the subscription does not belong to the caller, `400` for Paddle validation errors.

#### `POST /functions/v1/payments-webhook?env=sandbox|live`

Paddle → Splat webhook. Verifies the `paddle-signature` header against `PAYMENTS_{SANDBOX,LIVE}_WEBHOOK_SECRET` and upserts into `subscriptions` using the `service_role` key.

- **Auth:** signature verification only — **do not** send a Supabase JWT.
- **Handled events:** `subscription.created`, `subscription.updated`, `subscription.canceled`. Unknown events are logged and acknowledged with `200`.
- **Response 200:** `{ "received": true }`
- **Response 400:** `Webhook error` (signature failure or handler exception)
- **Response 405:** non-`POST` requests

### Error contract

All edge functions return JSON `{ "error": "<generic message>" }` and log the underlying exception via `console.error`. Never surface raw error strings in the UI — use the toast helpers in `src/hooks/use-toast.ts`.

## Deployment

Splat is designed to be deployed via Lovable:

1. Open the project in [Lovable](https://lovable.dev).
2. Click **Share → Publish**.
3. Configure a custom domain under **Project → Settings → Domains** if desired.

The published URL is served as a single‑page app; Lovable Cloud handles backend, database, storage, and edge function deployment automatically.

## Contributing

1. Create a feature branch.
2. Keep changes focused — small PRs are easier to review.
3. Run `npm run lint` and `npm test` before opening a PR.
4. Follow the design‑system rules: semantic tokens only, mobile‑first, no raw colors.
5. For database changes, add a migration in `supabase/migrations/` rather than editing schema by hand.

## License

This project is provided as a template under the MIT License unless otherwise specified by the repository owner. See `LICENSE` if present.
