import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";

const inputSchema = z.object({}).strict();

const outputSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  bySeverity: z.record(z.string(), z.number().int()),
});

interface StatRow {
  status: string;
  severity: string;
}

export const bugStatsTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "get_bug_stats",
  description: "Aggregate counts of bugs by status and severity across the workspace.",
  access: "read",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: { type: "object", properties: {} },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(_input, ctx) {
    const rows = await ctx.supabase.select<StatRow>(
      "bugs",
      { select: "status,severity", limit: "1000" },
      { signal: ctx.signal },
    );
    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1;
    }
    return { total: rows.length, byStatus, bySeverity };
  },
};
