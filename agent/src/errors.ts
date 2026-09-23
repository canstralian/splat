/**
 * Explicit failure taxonomy. Every recoverable failure mode in the runtime maps
 * to one of these classes so callers can branch on `code` rather than string
 * matching. Errors are never swallowed silently.
 */

export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "MODEL_ERROR"
  | "MALFORMED_MODEL_OUTPUT"
  | "TOOL_NOT_FOUND"
  | "TOOL_VALIDATION"
  | "TOOL_EXECUTION"
  | "TOOL_TIMEOUT"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "BUDGET_EXCEEDED"
  | "STALE_WRITE"
  | "PERSISTENCE"
  | "NOT_FOUND";

export class AgentError extends Error {
  readonly code: ErrorCode;
  /** True when the operation may be safely retried (respecting idempotency). */
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? {};
  }
}

export class InvalidInputError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("INVALID_INPUT", message, { detail });
  }
}

export class UnauthenticatedError extends AgentError {
  constructor(message = "Missing or invalid credentials") {
    super("UNAUTHENTICATED", message);
  }
}

export class ModelError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("MODEL_ERROR", message, { retryable: true, detail });
  }
}

export class MalformedModelOutputError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("MALFORMED_MODEL_OUTPUT", message, { detail });
  }
}

export class ToolNotFoundError extends AgentError {
  constructor(toolName: string) {
    super("TOOL_NOT_FOUND", `Tool not found: ${toolName}`, {
      detail: { toolName },
    });
  }
}

export class ToolValidationError extends AgentError {
  constructor(toolName: string, detail?: Record<string, unknown>) {
    super("TOOL_VALIDATION", `Invalid arguments for tool: ${toolName}`, {
      detail: { toolName, ...detail },
    });
  }
}

export class ToolExecutionError extends AgentError {
  constructor(toolName: string, message: string, detail?: Record<string, unknown>) {
    super("TOOL_EXECUTION", `Tool ${toolName} failed: ${message}`, {
      detail: { toolName, ...detail },
    });
  }
}

export class ToolTimeoutError extends AgentError {
  constructor(toolName: string, timeoutMs: number) {
    super("TOOL_TIMEOUT", `Tool ${toolName} timed out after ${timeoutMs}ms`, {
      detail: { toolName, timeoutMs },
    });
  }
}

export class PolicyDeniedError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("POLICY_DENIED", message, { detail });
  }
}

export class ApprovalRequiredError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("APPROVAL_REQUIRED", message, { detail });
  }
}

export class BudgetExceededError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("BUDGET_EXCEEDED", message, { detail });
  }
}

export class StaleWriteError extends AgentError {
  constructor(message = "Stale write detected (optimistic concurrency conflict)", detail?: Record<string, unknown>) {
    super("STALE_WRITE", message, { retryable: true, detail });
  }
}

export class PersistenceError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("PERSISTENCE", message, { retryable: true, detail });
  }
}

export class NotFoundError extends AgentError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("NOT_FOUND", message, { detail });
  }
}
