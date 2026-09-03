/**
 * Minimal mock of the Supabase endpoints the agent worker uses, for offline
 * end-to-end testing with `wrangler dev` + `MODEL_PROVIDER=stub`.
 *
 * Tokens: "token-alice" and "token-bob" authenticate as two different users;
 * anything else is rejected with 401. Data is held in memory.
 *
 *   node scripts/mock-supabase.mjs   # listens on 127.0.0.1:8790
 */
import { createServer } from "node:http";

const PORT = 8790;

const USERS = {
  "token-alice": { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.com" },
  "token-bob": { id: "22222222-2222-4222-8222-222222222222", email: "bob@example.com" },
};

let bugSeq = 2;
const bugs = [
  {
    id: "b0000001-0000-4000-8000-000000000001",
    tracking_id: "SPL-00001",
    title: "Login button unresponsive on mobile",
    description: "Tapping login does nothing on iOS Safari",
    status: "backlog",
    severity: "blocker",
    category: "ui",
    steps_to_reproduce: null,
    expected_behavior: null,
    actual_behavior: null,
    environment: "prod",
    reporter_id: USERS["token-alice"].id,
    assignee_id: null,
    project_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "b0000002-0000-4000-8000-000000000002",
    tracking_id: "SPL-00002",
    title: "Analytics chart mislabels severity",
    description: "Polish shown as major",
    status: "in_progress",
    severity: "minor",
    category: "logic",
    steps_to_reproduce: null,
    expected_behavior: null,
    actual_behavior: null,
    environment: "staging",
    reporter_id: USERS["token-bob"].id,
    assignee_id: null,
    project_id: null,
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];
const comments = [];
const activityLog = [];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function userFromRequest(req) {
  const auth = req.headers.authorization ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return USERS[token] ?? null;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : null;
}

function applyEqFilter(rows, params, field) {
  const value = params.get(field);
  if (!value?.startsWith("eq.")) return rows;
  return rows.filter((row) => String(row[field]) === value.slice(3));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const user = userFromRequest(req);
  console.log(`[mock-supabase] ${req.method} ${url.pathname} as ${user?.email ?? "anonymous"}`);

  if (url.pathname === "/auth/v1/user") {
    if (!user) return send(res, 401, { message: "invalid token" });
    return send(res, 200, user);
  }

  // PostgREST surface — RLS approximated: any authenticated user can read;
  // updates only by the reporter in this simplified mock.
  if (!user) return send(res, 401, { message: "no session" });

  if (url.pathname === "/rest/v1/bugs" && req.method === "GET") {
    let rows = [...bugs];
    for (const field of ["tracking_id", "status", "severity", "category", "assignee_id", "id"]) {
      rows = applyEqFilter(rows, url.searchParams, field);
    }
    const limit = Number(url.searchParams.get("limit") ?? "100");
    return send(res, 200, rows.slice(0, limit));
  }

  if (url.pathname === "/rest/v1/bugs" && req.method === "POST") {
    const body = await readJson(req);
    if (body.reporter_id !== user.id) {
      return send(res, 403, { message: "new row violates row-level security policy" });
    }
    bugSeq += 1;
    const row = {
      ...body,
      id: crypto.randomUUID(),
      tracking_id: `SPL-${String(bugSeq).padStart(5, "0")}`,
      status: "backlog",
      assignee_id: null,
      project_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    bugs.push(row);
    return send(res, 201, [row]);
  }

  if (url.pathname === "/rest/v1/bugs" && req.method === "PATCH") {
    const body = await readJson(req);
    const matched = applyEqFilter(bugs, url.searchParams, "id");
    // RLS: only the reporter may update (assignee/admin omitted in the mock).
    const permitted = matched.filter((row) => row.reporter_id === user.id);
    for (const row of permitted) Object.assign(row, body, { updated_at: new Date().toISOString() });
    return send(res, 200, permitted);
  }

  if (url.pathname === "/rest/v1/comments" && req.method === "GET") {
    let rows = [...comments];
    rows = applyEqFilter(rows, url.searchParams, "bug_id");
    return send(res, 200, rows);
  }

  if (url.pathname === "/rest/v1/comments" && req.method === "POST") {
    const body = await readJson(req);
    if (body.user_id !== user.id) {
      return send(res, 403, { message: "new row violates row-level security policy" });
    }
    const row = { ...body, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    comments.push(row);
    return send(res, 201, [row]);
  }

  if (url.pathname === "/rest/v1/activity_log" && req.method === "POST") {
    const body = await readJson(req);
    const row = { ...body, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    activityLog.push(row);
    return send(res, 201, [row]);
  }

  if (url.pathname === "/rest/v1/profiles" && req.method === "GET") {
    return send(res, 200, [
      { user_id: USERS["token-alice"].id, full_name: "Alice Example" },
      { user_id: USERS["token-bob"].id, full_name: "Bob Example" },
    ]);
  }

  if (url.pathname === "/rest/v1/projects" && req.method === "GET") {
    return send(res, 200, [{ name: "Core App", description: "Main product surface" }]);
  }

  if (url.pathname === "/rest/v1/rpc/get_team_members" && req.method === "POST") {
    return send(res, 200, [
      { user_id: USERS["token-alice"].id, full_name: "Alice Example", job_title: "Founder", role: "admin" },
      { user_id: USERS["token-bob"].id, full_name: "Bob Example", job_title: "Engineer", role: "user" },
    ]);
  }

  return send(res, 404, { message: `no mock for ${req.method} ${url.pathname}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-supabase] listening on http://127.0.0.1:${PORT}`);
});
