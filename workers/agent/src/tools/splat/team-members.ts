import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";

const inputSchema = z.object({}).strict();

const outputSchema = z.object({
  members: z.array(
    z.object({
      fullName: z.string(),
      jobTitle: z.string().nullable(),
      role: z.string(),
    }),
  ),
});

interface TeamMemberRow {
  user_id: string;
  full_name: string | null;
  job_title: string | null;
  role: string | null;
}

export const listTeamMembersTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "list_team_members",
  description: "List team members (name, job title, role) via Splat's get_team_members RPC.",
  access: "read",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: { type: "object", properties: {} },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(_input, ctx) {
    const rows = await ctx.supabase.rpc<TeamMemberRow[] | null>("get_team_members", {}, { signal: ctx.signal });
    return {
      members: (rows ?? []).map((r) => ({
        fullName: r.full_name ?? "Unknown",
        jobTitle: r.job_title,
        role: r.role ?? "user",
      })),
    };
  },
};
