/**
 * TypeScript types for the Splat AI assistant API (Cloudflare Worker,
 * `workers/agent`). Keep in sync with `workers/agent/src/agent/types.ts`
 * and the Zod schemas in `./schemas.ts`.
 *
 * Types-only module — no runtime logic.
 */

export type AgentIntent = "read_query" | "write_request" | "general_chat";

export interface AgentToolCall {
  name: string;
  access: "read" | "write" | null;
  status: "ok" | "error";
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface AgentMessageRequest {
  message: string;
  /** Runtime capability grant for write tools — set by the UI toggle only. */
  allowWrites?: boolean;
}

export interface AgentMessageResponse {
  executionId: string;
  reply: string;
  intent: AgentIntent;
  toolCalls: AgentToolCall[];
  modelId: string;
  durationMs: number;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface AgentSessionState {
  messages: AgentChatMessage[];
  executionCount: number;
}

export interface AgentErrorEnvelope {
  error: {
    code: string;
    message: string;
    executionId?: string;
  };
}
