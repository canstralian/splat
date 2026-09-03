import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";
import { BUG_STATUSES, bugStatusSchema, findBugByTrackingId, trackingIdSchema, type BugRow } from "./shared";

const inputSchema = z.object({
  trackingId: trackingIdSchema,
  status: bugStatusSchema,
});

const outputSchema = z.discriminatedUnion("updated", [
  z.object({
    updated: z.literal(false),
    reason: z.enum(["not_found", "not_permitted", "already_set"]),
    trackingId: z.string(),
  }),
  z.object({
    updated: z.literal(true),
    trackingId: z.string(),
    previousStatus: bugStatusSchema,
    status: bugStatusSchema,
    activityLogged: z.boolean(),
  }),
]);

export const updateBugStatusTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "update_bug_status",
  description:
    "Change the workflow status of a bug. Only the reporter, the assignee, or an admin may update a bug; otherwise this reports not_permitted.",
  access: "write",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: {
    type: "object",
    properties: {
      trackingId: { type: "string", description: "Bug tracking id, e.g. SPL-00042" },
      status: { type: "string", enum: [...BUG_STATUSES] },
    },
    required: ["trackingId", "status"],
  },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(input, ctx) {
    const bug = await findBugByTrackingId(ctx.supabase, input.trackingId, ctx.signal);
    if (!bug) return { updated: false as const, reason: "not_found" as const, trackingId: input.trackingId };
    if (bug.status === input.status) {
      return { updated: false as const, reason: "already_set" as const, trackingId: input.trackingId };
    }

    const updatedRows = await ctx.supabase.update<BugRow>(
      "bugs",
      { id: `eq.${bug.id}` },
      { status: input.status },
      { signal: ctx.signal },
    );
    // RLS filters rows the user may not update; an empty representation means
    // the update was silently rejected by policy.
    if (updatedRows.length === 0) {
      return { updated: false as const, reason: "not_permitted" as const, trackingId: input.trackingId };
    }

    // Mirror the Splat UI convention (BugDetail.tsx): record the change in the
    // activity log. Failure to log must not report the update as failed, but
    // it is surfaced in the output rather than swallowed.
    let activityLogged = true;
    try {
      await ctx.supabase.insert(
        "activity_log",
        {
          bug_id: bug.id,
          user_id: ctx.identity.userId,
          action: "status_change",
          old_value: bug.status,
          new_value: input.status,
        },
        { signal: ctx.signal },
      );
    } catch {
      activityLogged = false;
    }

    return {
      updated: true as const,
      trackingId: bug.tracking_id,
      previousStatus: bug.status,
      status: input.status,
      activityLogged,
    };
  },
};
