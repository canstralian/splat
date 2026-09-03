import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";
import { findBugByTrackingId, trackingIdSchema } from "./shared";

const inputSchema = z.object({
  trackingId: trackingIdSchema,
  content: z.string().trim().min(1).max(2000),
});

const outputSchema = z.discriminatedUnion("added", [
  z.object({ added: z.literal(false), reason: z.literal("not_found"), trackingId: z.string() }),
  z.object({ added: z.literal(true), trackingId: z.string() }),
]);

interface CommentRow {
  id: string;
}

export const addCommentTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "add_comment",
  description: "Add a comment to a bug on behalf of the current user.",
  access: "write",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: {
    type: "object",
    properties: {
      trackingId: { type: "string", description: "Bug tracking id, e.g. SPL-00042" },
      content: { type: "string", maxLength: 2000 },
    },
    required: ["trackingId", "content"],
  },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(input, ctx) {
    const bug = await findBugByTrackingId(ctx.supabase, input.trackingId, ctx.signal);
    if (!bug) return { added: false as const, reason: "not_found" as const, trackingId: input.trackingId };

    // user_id comes from the verified identity, never from model output; RLS
    // additionally requires user_id = auth.uid() on insert.
    await ctx.supabase.insert<CommentRow>(
      "comments",
      { bug_id: bug.id, user_id: ctx.identity.userId, content: input.content },
      { signal: ctx.signal },
    );
    return { added: true as const, trackingId: bug.tracking_id };
  },
};
