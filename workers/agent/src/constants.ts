/** Runtime limits, centralised so policy checks and tests share one source. */
export interface AgentLimits {
  /** Maximum characters accepted in a single user message. */
  maxMessageChars: number;
  /** Maximum characters returned in a single assistant reply. */
  maxReplyChars: number;
  /** How many prior messages are assembled into model context. */
  historyContextMessages: number;
  /** Cap on stored conversation rows before pruning oldest. */
  maxStoredMessages: number;
  /** Maximum model↔tool round-trips within one turn. */
  maxToolIterations: number;
  /** Maximum tool calls honoured per model iteration. */
  maxToolCallsPerIteration: number;
  /** Recoverable model mistakes (bad tool name/args) tolerated per turn. */
  maxModelRecoveries: number;
  /** Sliding-window rate limit per session. */
  rateLimitMaxTurns: number;
  rateLimitWindowMs: number;
  /** Default per-tool execution timeout. */
  defaultToolTimeoutMs: number;
  /** Timeout for a single model completion call. */
  modelTimeoutMs: number;
  /** Timeout for the Supabase auth verification call. */
  authTimeoutMs: number;
  /** Maximum execution-history entries returned to the client. */
  maxExecutionsListed: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxMessageChars: 4000,
  maxReplyChars: 8000,
  historyContextMessages: 20,
  maxStoredMessages: 200,
  maxToolIterations: 5,
  maxToolCallsPerIteration: 3,
  maxModelRecoveries: 2,
  rateLimitMaxTurns: 20,
  rateLimitWindowMs: 5 * 60_000,
  defaultToolTimeoutMs: 10_000,
  modelTimeoutMs: 60_000,
  authTimeoutMs: 10_000,
  maxExecutionsListed: 50,
};

/** Session ids are client-chosen but constrained to a safe alphabet. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
