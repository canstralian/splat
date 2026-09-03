import type { z } from "zod";
import type { AgentIdentity } from "../auth";
import type { AgentErrorCode } from "../errors";
import type { SupabaseRestClient } from "../supabase/rest";

export type ToolAccess = "read" | "write";

/**
 * Runtime context handed to a tool. The Supabase client is scoped to the
 * calling user's JWT — identity and authorization come from the runtime,
 * never from model output.
 */
export interface ToolContext {
  identity: AgentIdentity;
  supabase: SupabaseRestClient;
  /** Aborted by the registry when the tool's timeout elapses. */
  signal: AbortSignal;
}

/** JSON Schema advertised to the model. Kept in sync with `inputSchema` (verified by tests). */
export interface ToolParametersSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition<TIn = unknown, TOut = unknown> {
  name: string;
  description: string;
  /** `read` tools are always exposed; `write` tools require an explicit runtime grant. */
  access: ToolAccess;
  /** Minimum caller requirement. Fine-grained authorization is enforced by Supabase RLS. */
  permission: "authenticated";
  inputSchema: z.ZodType<TIn>;
  outputSchema: z.ZodType<TOut>;
  parameters: ToolParametersSchema;
  timeoutMs: number;
  execute(input: TIn, ctx: ToolContext): Promise<TOut>;
}

export interface ToolCallRecord {
  name: string;
  access: ToolAccess | null;
  status: "ok" | "error";
  errorCode?: AgentErrorCode;
  errorMessage?: string;
  durationMs: number;
}
