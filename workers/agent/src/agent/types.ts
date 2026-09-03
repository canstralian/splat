import type { AgentIdentity } from "../auth";
import type { AgentErrorCode } from "../errors";
import type { ToolCallRecord } from "../tools/types";
import type { Intent } from "./classify";

/** A persisted conversation message (durable, per user+session). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/** A persisted record of one agent execution (success or failure). */
export interface ExecutionRecord {
  id: string;
  status: "completed" | "failed";
  intent: Intent;
  modelId: string;
  errorCode?: AgentErrorCode;
  errorMessage?: string;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  createdAt: number;
}

/** RPC input for one turn, assembled by the router from the verified request. */
export interface TurnInput {
  identity: AgentIdentity;
  /** User's Supabase JWT — used only to build the per-turn data client. */
  accessToken: string;
  message: string;
  allowWrites: boolean;
}

export interface TurnSuccess {
  ok: true;
  executionId: string;
  reply: string;
  intent: Intent;
  toolCalls: ToolCallRecord[];
  modelId: string;
  durationMs: number;
}

export interface EnvelopeError {
  ok: false;
  error: {
    code: AgentErrorCode;
    message: string;
    status: number;
    executionId?: string;
  };
}

/**
 * Results cross the Durable Object RPC boundary as plain envelopes rather
 * than thrown errors, because custom error classes do not survive RPC
 * serialization intact.
 */
export type TurnOutput = TurnSuccess | EnvelopeError;

export interface SessionStateSuccess {
  ok: true;
  messages: ChatMessage[];
  executionCount: number;
}
export type SessionStateOutput = SessionStateSuccess | EnvelopeError;

export interface ExecutionsSuccess {
  ok: true;
  executions: ExecutionRecord[];
}
export type ExecutionsOutput = ExecutionsSuccess | EnvelopeError;

export type ResetOutput = { ok: true } | EnvelopeError;

/** Typed surface of the AgentSession Durable Object as seen through its stub. */
export interface AgentSessionStub {
  runTurn(input: TurnInput): Promise<TurnOutput>;
  getState(input: { userId: string }): Promise<SessionStateOutput>;
  getExecutions(input: { userId: string }): Promise<ExecutionsOutput>;
  reset(input: { userId: string }): Promise<ResetOutput>;
}
