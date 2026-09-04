import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { splatBugSearchTool } from "../src/tools/splat-bugs";
import { invokeTool, type Tool } from "../src/tools/types";
import { ToolExecutionError } from "../src/errors";
import { Logger } from "../src/observability/logger";

function ctx(userToken: string | undefined) {
  return {
    runId: "run-bugs",
    sessionId: "sess-bugs",
    ownerUserId: "user-bugs",
    userToken,
    env,
    logger: new Logger(),
    now: () => Date.now(),
    idempotencyKey: "idem-bugs",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splat_bug_search tool (Splatt data integration)", () => {
  it("queries Supabase with the user's token and returns bugs", async () => {
    const seen: { url?: string; auth?: string; apikey?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.url = url;
      const headers = new Headers(init?.headers);
      seen.auth = headers.get("authorization") ?? undefined;
      seen.apikey = headers.get("apikey") ?? undefined;
      return new Response(
        JSON.stringify([
          { tracking_id: "SPL-00001", title: "Login race", status: "backlog" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await invokeTool(
      splatBugSearchTool as Tool,
      { query: "login" },
      ctx("user-jwt-token"),
      2000,
    );

    expect(res.output).toMatchObject({ count: 1 });
    // Calls Splatt's Supabase REST endpoint, as the user (RLS enforced).
    expect(seen.url).toContain("/rest/v1/bugs");
    expect(seen.url).toContain("ilike");
    expect(seen.auth).toBe("Bearer user-jwt-token");
    expect(seen.apikey).toBe("test-anon-key");
  });

  it("fails clearly when no user token is present", async () => {
    await expect(
      invokeTool(splatBugSearchTool as Tool, { query: "x" }, ctx(undefined), 2000),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("surfaces a ToolExecutionError on a Supabase error response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
    await expect(
      invokeTool(splatBugSearchTool as Tool, { query: "x" }, ctx("t"), 2000),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("validates input (rejects an unknown status filter)", async () => {
    await expect(
      invokeTool(
        splatBugSearchTool as Tool,
        { query: "x", status: "not_a_status" },
        ctx("t"),
        2000,
      ),
    ).rejects.toBeDefined();
  });
});
