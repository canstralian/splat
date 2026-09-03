import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";
import {
  BUG_CATEGORIES,
  BUG_SEVERITIES,
  BUG_STATUSES,
  bugCategorySchema,
  bugSeveritySchema,
  bugStatusSchema,
  bugSummarySchema,
  sanitizeSearchTerm,
  toBugSummary,
  type BugRow,
} from "./shared";

const inputSchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  status: bugStatusSchema.optional(),
  severity: bugSeveritySchema.optional(),
  category: bugCategorySchema.optional(),
  assignedToMe: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const outputSchema = z.object({
  bugs: z.array(bugSummarySchema),
  count: z.number().int(),
});

export const searchBugsTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "search_bugs",
  description:
    "Search Splat bugs by free text and/or filters (status, severity, category, assigned to the current user). Returns the most recent matches.",
  access: "read",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search over title and description" },
      status: { type: "string", enum: [...BUG_STATUSES] },
      severity: { type: "string", enum: [...BUG_SEVERITIES] },
      category: { type: "string", enum: [...BUG_CATEGORIES] },
      assignedToMe: { type: "boolean", description: "Only bugs assigned to the current user" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(input, ctx) {
    const params: Record<string, string> = {
      select: "tracking_id,title,status,severity,category,created_at",
      order: "created_at.desc",
      limit: String(input.limit ?? 10),
    };
    if (input.status) params.status = `eq.${input.status}`;
    if (input.severity) params.severity = `eq.${input.severity}`;
    if (input.category) params.category = `eq.${input.category}`;
    if (input.assignedToMe) params.assignee_id = `eq.${ctx.identity.userId}`;
    if (input.query) {
      const term = sanitizeSearchTerm(input.query);
      if (term.length > 0) {
        params.or = `(title.ilike.*${term}*,description.ilike.*${term}*)`;
      }
    }

    const rows = await ctx.supabase.select<BugRow>("bugs", params, { signal: ctx.signal });
    const bugs = rows.map(toBugSummary);
    return { bugs, count: bugs.length };
  },
};
