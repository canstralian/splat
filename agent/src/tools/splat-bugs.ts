import { z } from "zod";
import { CAPABILITIES } from "../governance/capabilities";
import { ToolExecutionError } from "../errors";
import type { Tool, ToolContext } from "./types";

/**
 * splat_bug_search — a Splatt-integration tool. It searches the caller's bugs in
 * Splatt's Supabase database, on the user's behalf, using the user's own access
 * token so Postgres Row-Level Security is fully enforced. The agent therefore
 * never sees data the user could not already see, and no service-role key is
 * used.
 */
export const splatBugSearchTool: Tool<
  { query: string; status?: string; limit?: number },
  { count: number; bugs: Array<Record<string, unknown>> }
> = {
  name: "splat_bug_search",
  description:
    "Search the current Splatt user's bugs by title/description text, optionally filtered by status. Read-only.",
  inputSchema: z.object({
    query: z.string().min(1).max(200),
    status: z
      .enum(["backlog", "in_progress", "in_review", "shipped", "wont_fix"])
      .optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  outputSchema: z.object({
    count: z.number(),
    bugs: z.array(z.record(z.string(), z.unknown())),
  }),
  requiredCapability: CAPABILITIES.SPLAT_BUGS_READ,
  effect: "read_only",
  failureBehavior: "report_and_continue",
  evidenceDescription:
    "Records the search query, status filter and the number of bugs returned (not their full contents).",
  async execute(input, ctx: ToolContext) {
    const baseUrl = ctx.env.SUPABASE_URL;
    const anonKey = ctx.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) {
      throw new ToolExecutionError(
        "splat_bug_search",
        "Supabase is not configured (SUPABASE_URL / SUPABASE_ANON_KEY)",
      );
    }
    if (!ctx.userToken) {
      throw new ToolExecutionError(
        "splat_bug_search",
        "No user token available; this tool requires an authenticated user",
      );
    }

    const limit = input.limit ?? 10;
    const params = new URLSearchParams();
    params.set(
      "select",
      "tracking_id,title,status,severity,category,created_at",
    );
    // PostgREST full-text-ish filter on title OR description (RLS still applies).
    const term = `*${input.query.replace(/[*,()]/g, "")}*`;
    params.set("or", `(title.ilike.${term},description.ilike.${term})`);
    if (input.status) params.set("status", `eq.${input.status}`);
    params.set("order", "created_at.desc");
    params.set("limit", String(limit));

    const url = `${baseUrl.replace(/\/$/, "")}/rest/v1/bugs?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${ctx.userToken}`,
          accept: "application/json",
        },
        signal: ctx.signal,
      });
    } catch (err) {
      throw new ToolExecutionError(
        "splat_bug_search",
        `Supabase request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new ToolExecutionError(
        "splat_bug_search",
        `Supabase returned HTTP ${res.status}`,
        { status: res.status },
      );
    }
    const bugs = (await res.json()) as Array<Record<string, unknown>>;
    return { count: bugs.length, bugs };
  },
};
