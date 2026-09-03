import { AgentError } from "./errors";

/**
 * Worker environment. All values are plain vars — this worker intentionally
 * holds no secrets. `SUPABASE_PUBLISHABLE_KEY` is the public anon key; data
 * access is authorized exclusively by the calling user's Supabase JWT + RLS.
 */
export interface Env {
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
  AGENT_VERSION: string;
  MODEL_PROVIDER?: string;
  MODEL_ID: string;
  MODEL_TIMEOUT_MS?: string;
  AI_GATEWAY_ID?: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  ALLOWED_ORIGINS?: string;
}

/** Fails fast with `config_error` when the deployment is missing required vars. */
export function assertConfigured(env: Env): void {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!env.SUPABASE_PUBLISHABLE_KEY) missing.push("SUPABASE_PUBLISHABLE_KEY");
  if (!env.MODEL_ID) missing.push("MODEL_ID");
  if (missing.length > 0) {
    throw new AgentError("config_error", "Agent service is not configured", {
      details: { missing },
    });
  }
}
