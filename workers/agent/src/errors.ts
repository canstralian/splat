/**
 * Error taxonomy for the agent runtime.
 *
 * Every failure path maps to a stable code so callers (and tests) can assert
 * behaviour, and so the HTTP layer can translate errors without leaking
 * internals. `message` must always be safe to show to the end user; anything
 * sensitive belongs in `details`, which is only ever logged server-side.
 */
export type AgentErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "rate_limited"
  | "model_error"
  | "model_timeout"
  | "model_malformed"
  | "tool_not_found"
  | "tool_forbidden"
  | "tool_invalid_input"
  | "tool_invalid_output"
  | "tool_timeout"
  | "tool_failed"
  | "upstream_error"
  | "config_error"
  | "internal_error";

const HTTP_STATUS: Record<AgentErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  rate_limited: 429,
  model_error: 502,
  model_timeout: 504,
  model_malformed: 502,
  tool_not_found: 502,
  tool_forbidden: 403,
  tool_invalid_input: 502,
  tool_invalid_output: 502,
  tool_timeout: 504,
  tool_failed: 502,
  upstream_error: 502,
  config_error: 503,
  internal_error: 500,
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: AgentErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgentError";
    this.code = code;
    this.details = options?.details ?? {};
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  /** Shape safe to return to the client. */
  toPublicJSON(): { code: AgentErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** Wraps unknown thrown values so nothing escapes the taxonomy. */
export function toAgentError(error: unknown, fallbackMessage = "An internal error occurred"): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError("internal_error", fallbackMessage, { cause: error });
}
