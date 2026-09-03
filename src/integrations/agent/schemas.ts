/**
 * Runtime Zod schemas for the Splat AI assistant API.
 *
 * Mirrors `./types.ts`, following the same convention as
 * `src/integrations/edge-functions/schemas.ts`: every response is validated
 * before the UI consumes it.
 */
import { z } from "zod";

export const agentToolCallSchema = z.object({
  name: z.string(),
  access: z.enum(["read", "write"]).nullable(),
  status: z.enum(["ok", "error"]),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  durationMs: z.number(),
});

export const agentMessageResponseSchema = z.object({
  executionId: z.string(),
  reply: z.string(),
  intent: z.enum(["read_query", "write_request", "general_chat"]),
  toolCalls: z.array(agentToolCallSchema),
  modelId: z.string(),
  durationMs: z.number(),
});

export const agentChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.number(),
});

export const agentSessionStateSchema = z.object({
  messages: z.array(agentChatMessageSchema),
  executionCount: z.number(),
});

export const agentResetResponseSchema = z.object({}).passthrough();

export const agentErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    executionId: z.string().optional(),
  }),
});
