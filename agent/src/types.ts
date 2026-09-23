/**
 * Shared domain types for the agent runtime.
 *
 * The aggregate root of the domain is the {@link RunRecord}. Evidence, messages
 * and tool calls are children of a Run and are never independent aggregates.
 */

/** Lifecycle status of a single agent execution ("Run"). */
export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "denied";

/** The explicit, observable stages of a single agent execution. */
export type LifecycleStage =
  | "input"
  | "intent_classification"
  | "context_assembly"
  | "policy_check"
  | "model_reasoning"
  | "tool_selection"
  | "tool_execution"
  | "result_validation"
  | "state_update"
  | "evidence_recording"
  | "response";

/**
 * Epistemic classification of a piece of evidence. The runtime must never
 * present MODEL-GENERATED or INFERRED content as externally VERIFIED fact.
 */
export type Verification =
  | "VERIFIED" // Produced by a deterministic, in-system operation (e.g. a tool the runtime executed).
  | "INFERRED" // Derived by the runtime from verified inputs (e.g. classification, validation outcomes).
  | "MODEL_GENERATED" // Produced by the LLM. Untrusted until validated.
  | "UNVERIFIED"; // External input or otherwise unconfirmed.

/** Whether a tool only reads, or mutates external/persistent state. */
export type ToolEffect = "read_only" | "mutating";

/** A single message in a session conversation. */
export interface ConversationMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** Present for role="tool": the tool that produced this message. */
  toolName?: string;
  createdAt: number;
}

/** Validated input that starts a Run. */
export interface RunInput {
  sessionId: string;
  message: string;
  /** Authenticated owner (Supabase user id). Isolation principal. */
  ownerUserId: string;
  /**
   * The owner's Supabase access token, forwarded only to user-scoped tools.
   * Never sent to the model or written to evidence/logs.
   */
  userToken?: string;
  /** Optional caller-supplied idempotency key for the Run. */
  idempotencyKey?: string;
  /**
   * Capabilities pre-approved by an authenticated human/approval workflow. These
   * come from the trusted caller, NEVER from the model.
   */
  approvals?: string[];
  /**
   * Test-only: a scripted sequence of model decisions. Ignored unless
   * ALLOW_SCRIPTED_PROVIDER === "true".
   */
  modelScript?: unknown;
}

/** The durable ledger row for a Run (persisted in D1). */
export interface RunRecord {
  id: string;
  sessionId: string;
  ownerUserId: string;
  agentId: string;
  agentVersion: string;
  status: RunStatus;
  input: string;
  intent: string | null;
  outcome: string | null;
  error: string | null;
  toolCallCount: number;
  version: number; // optimistic-concurrency guard
  createdAt: number;
  updatedAt: number;
}

/** A structured evidence record. Children of a Run; append-only. */
export interface EvidenceRecord {
  id: string;
  runId: string;
  seq: number;
  stage: LifecycleStage;
  verification: Verification;
  summary: string;
  /** Structured, JSON-serializable detail. Secrets must never be placed here. */
  detail: Record<string, unknown>;
  /** Optional pointer to a large artifact stored in R2. */
  artifactKey: string | null;
  createdAt: number;
}
