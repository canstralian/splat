import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";
import {
  bugCategorySchema,
  bugSeveritySchema,
  bugStatusSchema,
  findBugByTrackingId,
  trackingIdSchema,
} from "./shared";

const inputSchema = z.object({
  trackingId: trackingIdSchema,
});

const outputSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false), trackingId: z.string() }),
  z.object({
    found: z.literal(true),
    bug: z.object({
      trackingId: z.string(),
      title: z.string(),
      description: z.string(),
      status: bugStatusSchema,
      severity: bugSeveritySchema,
      category: bugCategorySchema,
      stepsToReproduce: z.string().nullable(),
      expectedBehavior: z.string().nullable(),
      actualBehavior: z.string().nullable(),
      environment: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    comments: z.array(
      z.object({
        author: z.string(),
        content: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
]);

interface CommentRow {
  content: string;
  created_at: string;
  user_id: string;
}

interface ProfileRow {
  user_id: string;
  full_name: string;
}

export const getBugTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "get_bug",
  description: "Fetch full details of one bug by tracking id (e.g. SPL-00042), including its most recent comments.",
  access: "read",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: {
    type: "object",
    properties: {
      trackingId: { type: "string", description: "Bug tracking id, e.g. SPL-00042" },
    },
    required: ["trackingId"],
  },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(input, ctx) {
    const bug = await findBugByTrackingId(ctx.supabase, input.trackingId, ctx.signal);
    if (!bug) return { found: false as const, trackingId: input.trackingId };

    const commentRows = await ctx.supabase.select<CommentRow>(
      "comments",
      {
        select: "content,created_at,user_id",
        bug_id: `eq.${bug.id}`,
        order: "created_at.desc",
        limit: "10",
      },
      { signal: ctx.signal },
    );

    const authorIds = [...new Set(commentRows.map((c) => c.user_id))];
    const profiles =
      authorIds.length > 0
        ? await ctx.supabase.select<ProfileRow>(
            "profiles",
            { select: "user_id,full_name", user_id: `in.(${authorIds.join(",")})` },
            { signal: ctx.signal },
          )
        : [];
    const nameByUser = new Map(profiles.map((p) => [p.user_id, p.full_name]));

    return {
      found: true as const,
      bug: {
        trackingId: bug.tracking_id,
        title: bug.title,
        description: bug.description,
        status: bug.status,
        severity: bug.severity,
        category: bug.category,
        stepsToReproduce: bug.steps_to_reproduce,
        expectedBehavior: bug.expected_behavior,
        actualBehavior: bug.actual_behavior,
        environment: bug.environment,
        createdAt: bug.created_at,
        updatedAt: bug.updated_at,
      },
      comments: commentRows.map((c) => ({
        author: nameByUser.get(c.user_id) ?? "Unknown",
        content: c.content,
        createdAt: c.created_at,
      })),
    };
  },
};
