import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";
import {
  BUG_CATEGORIES,
  BUG_SEVERITIES,
  bugCategorySchema,
  bugSeveritySchema,
  bugStatusSchema,
  type BugRow,
} from "./shared";

const inputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  severity: bugSeveritySchema,
  category: bugCategorySchema,
  stepsToReproduce: z.string().trim().max(5000).optional(),
  expectedBehavior: z.string().trim().max(2000).optional(),
  actualBehavior: z.string().trim().max(2000).optional(),
  environment: z.string().trim().max(100).optional(),
});

const outputSchema = z.object({
  created: z.literal(true),
  trackingId: z.string(),
  title: z.string(),
  status: bugStatusSchema,
});

export const createBugTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "create_bug",
  description:
    "File a new bug report in Splat on behalf of the current user. The reporter is always the current user.",
  access: "write",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 200 },
      description: { type: "string" },
      severity: { type: "string", enum: [...BUG_SEVERITIES] },
      category: { type: "string", enum: [...BUG_CATEGORIES] },
      stepsToReproduce: { type: "string" },
      expectedBehavior: { type: "string" },
      actualBehavior: { type: "string" },
      environment: { type: "string", description: "e.g. prod, staging" },
    },
    required: ["title", "severity", "category"],
  },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(input, ctx) {
    // reporter_id is injected from the verified identity — the model cannot
    // choose it, and RLS additionally requires reporter_id = auth.uid().
    const rows = await ctx.supabase.insert<BugRow>(
      "bugs",
      {
        title: input.title,
        description: input.description ?? "",
        severity: input.severity,
        category: input.category,
        steps_to_reproduce: input.stepsToReproduce ?? null,
        expected_behavior: input.expectedBehavior ?? null,
        actual_behavior: input.actualBehavior ?? null,
        environment: input.environment ?? null,
        reporter_id: ctx.identity.userId,
      },
      { signal: ctx.signal },
    );
    const bug = rows[0];
    if (!bug) {
      throw new Error("Insert returned no representation");
    }
    return { created: true as const, trackingId: bug.tracking_id, title: bug.title, status: bug.status };
  },
};
