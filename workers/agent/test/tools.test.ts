import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { createBugTool } from "../src/tools/splat/create-bug";
import { getBugTool } from "../src/tools/splat/get-bug";
import { searchBugsTool } from "../src/tools/splat/search-bugs";
import { sanitizeSearchTerm, trackingIdSchema } from "../src/tools/splat/shared";
import { splatTools } from "../src/tools/splat";
import { updateBugStatusTool } from "../src/tools/splat/update-bug-status";
import { addCommentTool } from "../src/tools/splat/add-comment";
import type { ToolContext } from "../src/tools/types";
import { fakeSupabase, neverAbort, testIdentity, type FakeRoute } from "./helpers";

const bugRow = {
  id: "bug-uuid-1",
  tracking_id: "SPL-00042",
  title: "Login crashes",
  description: "Crash on submit",
  status: "backlog",
  severity: "major",
  category: "ui",
  steps_to_reproduce: null,
  expected_behavior: null,
  actual_behavior: null,
  environment: "prod",
  reporter_id: "someone-else",
  assignee_id: null,
  project_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

function ctxWith(routes: Record<string, FakeRoute>) {
  const { client, captured } = fakeSupabase(routes);
  const ctx: ToolContext = { identity: testIdentity, supabase: client, signal: neverAbort() };
  return { ctx, captured };
}

describe("shared helpers", () => {
  it("sanitizes PostgREST filter grammar out of search terms", () => {
    expect(sanitizeSearchTerm('crash, (login) "boom" \\x')).toBe("crash login boom x");
  });

  it("normalizes tracking ids", () => {
    expect(trackingIdSchema.parse(" spl-7 ")).toBe("SPL-7");
    expect(() => trackingIdSchema.parse("BUG-1")).toThrow();
  });
});

describe("search_bugs", () => {
  it("builds RLS-safe query params and maps rows", async () => {
    const { ctx, captured } = ctxWith({
      "GET /rest/v1/bugs": () => ({ body: [bugRow] }),
    });
    const input = searchBugsTool.inputSchema.parse({
      query: "login, (crash)",
      status: "backlog",
      assignedToMe: true,
      limit: 5,
    });
    const output = await searchBugsTool.execute(input, ctx);

    const url = captured[0].url;
    expect(url.searchParams.get("status")).toBe("eq.backlog");
    expect(url.searchParams.get("assignee_id")).toBe(`eq.${testIdentity.userId}`);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("or")).toBe("(title.ilike.*login crash*,description.ilike.*login crash*)");
    // The user's JWT — not a service key — authorizes the call.
    expect(captured[0].headers.Authorization).toBe("Bearer user-jwt");

    expect(output.count).toBe(1);
    expect(output.bugs[0]).toMatchObject({ trackingId: "SPL-00042", title: "Login crashes", status: "backlog" });
  });
});

describe("get_bug", () => {
  it("reports found: false for unknown tracking ids", async () => {
    const { ctx } = ctxWith({ "GET /rest/v1/bugs": () => ({ body: [] }) });
    const output = await getBugTool.execute(getBugTool.inputSchema.parse({ trackingId: "SPL-99999" }), ctx);
    expect(output).toEqual({ found: false, trackingId: "SPL-99999" });
  });

  it("returns bug details with comment authors resolved", async () => {
    const { ctx } = ctxWith({
      "GET /rest/v1/bugs": () => ({ body: [bugRow] }),
      "GET /rest/v1/comments": () => ({
        body: [{ content: "On it", created_at: "2026-01-03T00:00:00Z", user_id: "user-9" }],
      }),
      "GET /rest/v1/profiles": () => ({ body: [{ user_id: "user-9", full_name: "Dana Dev" }] }),
    });
    const output = await getBugTool.execute(getBugTool.inputSchema.parse({ trackingId: "spl-00042" }), ctx);
    expect(output.found).toBe(true);
    if (output.found) {
      expect(output.bug.trackingId).toBe("SPL-00042");
      expect(output.comments).toEqual([{ author: "Dana Dev", content: "On it", createdAt: "2026-01-03T00:00:00Z" }]);
    }
  });
});

describe("create_bug", () => {
  it("injects the verified reporter_id and strips model-supplied identity fields", async () => {
    const { ctx, captured } = ctxWith({
      "POST /rest/v1/bugs": (req) => ({ body: [{ ...bugRow, ...(req.body as object), tracking_id: "SPL-00100" }] }),
    });
    // The model tries to smuggle a different reporter — zod strips unknown keys.
    const rawArgs = { title: "New bug", severity: "minor", category: "ui", reporter_id: "victim-user" };
    const input = createBugTool.inputSchema.parse(rawArgs);
    const output = await createBugTool.execute(input, ctx);

    const sentBody = captured[0].body as Record<string, unknown>;
    expect(sentBody.reporter_id).toBe(testIdentity.userId);
    expect(output).toMatchObject({ created: true, trackingId: "SPL-00100" });
  });
});

describe("update_bug_status", () => {
  it("reports not_found for unknown bugs", async () => {
    const { ctx } = ctxWith({ "GET /rest/v1/bugs": () => ({ body: [] }) });
    const output = await updateBugStatusTool.execute(
      updateBugStatusTool.inputSchema.parse({ trackingId: "SPL-1", status: "shipped" }),
      ctx,
    );
    expect(output).toMatchObject({ updated: false, reason: "not_found" });
  });

  it("reports not_permitted when RLS filters the update", async () => {
    const { ctx } = ctxWith({
      "GET /rest/v1/bugs": () => ({ body: [bugRow] }),
      "PATCH /rest/v1/bugs": () => ({ body: [] }),
    });
    const output = await updateBugStatusTool.execute(
      updateBugStatusTool.inputSchema.parse({ trackingId: "SPL-00042", status: "shipped" }),
      ctx,
    );
    expect(output).toMatchObject({ updated: false, reason: "not_permitted" });
  });

  it("updates status and mirrors the UI's activity_log convention", async () => {
    const { ctx, captured } = ctxWith({
      "GET /rest/v1/bugs": () => ({ body: [bugRow] }),
      "PATCH /rest/v1/bugs": () => ({ body: [{ ...bugRow, status: "shipped" }] }),
      "POST /rest/v1/activity_log": () => ({ body: [{}] }),
    });
    const output = await updateBugStatusTool.execute(
      updateBugStatusTool.inputSchema.parse({ trackingId: "SPL-00042", status: "shipped" }),
      ctx,
    );
    expect(output).toMatchObject({
      updated: true,
      previousStatus: "backlog",
      status: "shipped",
      activityLogged: true,
    });
    const activityInsert = captured.find((c) => c.url.pathname === "/rest/v1/activity_log");
    expect(activityInsert?.body).toMatchObject({
      bug_id: "bug-uuid-1",
      user_id: testIdentity.userId,
      action: "status_change",
      old_value: "backlog",
      new_value: "shipped",
    });
  });

  it("short-circuits when the status is already set", async () => {
    const { ctx, captured } = ctxWith({ "GET /rest/v1/bugs": () => ({ body: [bugRow] }) });
    const output = await updateBugStatusTool.execute(
      updateBugStatusTool.inputSchema.parse({ trackingId: "SPL-00042", status: "backlog" }),
      ctx,
    );
    expect(output).toMatchObject({ updated: false, reason: "already_set" });
    expect(captured.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
});

describe("add_comment", () => {
  it("injects the verified user_id on inserts", async () => {
    const { ctx, captured } = ctxWith({
      "GET /rest/v1/bugs": () => ({ body: [bugRow] }),
      "POST /rest/v1/comments": () => ({ body: [{ id: "comment-1" }] }),
    });
    const output = await addCommentTool.execute(
      addCommentTool.inputSchema.parse({ trackingId: "SPL-00042", content: "Looks fixed" }),
      ctx,
    );
    expect(output).toMatchObject({ added: true, trackingId: "SPL-00042" });
    const insert = captured.find((c) => c.url.pathname === "/rest/v1/comments");
    expect(insert?.body).toMatchObject({ bug_id: "bug-uuid-1", user_id: testIdentity.userId, content: "Looks fixed" });
  });
});

describe("tool metadata consistency", () => {
  it("keeps the advertised JSON schema in sync with the zod input schema", () => {
    for (const tool of splatTools) {
      const shape = (tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(tool.parameters.properties).sort(), tool.name).toEqual(Object.keys(shape).sort());
      for (const required of tool.parameters.required ?? []) {
        expect(Object.keys(shape), `${tool.name}.${required}`).toContain(required);
      }
    }
  });

  it("classifies every tool and sets a timeout", () => {
    for (const tool of splatTools) {
      expect(["read", "write"], tool.name).toContain(tool.access);
      expect(tool.permission).toBe("authenticated");
      expect(tool.timeoutMs).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});
