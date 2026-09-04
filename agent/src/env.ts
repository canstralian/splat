import type { AgentNamespace } from "agents";
import type { OrchestratorAgent } from "./agent/orchestrator-agent";

/**
 * Worker environment bindings.
 *
 * Secrets (API_AUTH_TOKEN, MODEL_API_KEY) are injected by Cloudflare from the
 * secret store and are NEVER committed to source or exposed to the model.
 */
export interface Env {
  // --- Durable Objects ---
  ORCHESTRATOR: AgentNamespace<OrchestratorAgent>;

  // --- Storage / data ---
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  EVIDENCE_BUCKET: R2Bucket;
  BACKGROUND_QUEUE: Queue<BackgroundMessage>;

  // --- Inference ---
  AI: Ai;

  // --- Non-secret configuration (wrangler [vars]) ---
  AGENT_ID: string;
  AGENT_VERSION: string;
  MODEL_PROVIDER: string; // "workers-ai" | "openai" | "scripted"
  MODEL_ID?: string;
  MODEL_BASE_URL?: string;
  ALLOW_SCRIPTED_PROVIDER?: string; // "true" enables the deterministic test provider
  MAX_TOOL_CALLS?: string;
  MAX_WALL_CLOCK_MS?: string;
  TOOL_DEFAULT_TIMEOUT_MS?: string;

  // --- Secrets (never logged, never sent to the model) ---
  API_AUTH_TOKEN?: string;
  MODEL_API_KEY?: string;
}

/** Messages placed on the background queue for asynchronous, idempotent work. */
export type BackgroundMessage = {
  type: "archive_run";
  runId: string;
  /** Idempotency key; re-processing with the same key is a no-op. */
  idempotencyKey: string;
};
