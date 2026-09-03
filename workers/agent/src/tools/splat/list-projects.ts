import { z } from "zod";
import { DEFAULT_LIMITS } from "../../constants";
import type { ToolDefinition } from "../types";

const inputSchema = z.object({}).strict();

const outputSchema = z.object({
  projects: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
    }),
  ),
});

interface ProjectRow {
  name: string;
  description: string | null;
}

export const listProjectsTool: ToolDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "list_projects",
  description: "List the projects configured in this Splat workspace.",
  access: "read",
  permission: "authenticated",
  inputSchema,
  outputSchema,
  parameters: { type: "object", properties: {} },
  timeoutMs: DEFAULT_LIMITS.defaultToolTimeoutMs,
  async execute(_input, ctx) {
    const rows = await ctx.supabase.select<ProjectRow>(
      "projects",
      { select: "name,description", order: "name.asc", limit: "50" },
      { signal: ctx.signal },
    );
    return { projects: rows.map((r) => ({ name: r.name, description: r.description })) };
  },
};
