import { AgentError } from "./errors";

/**
 * Runtime checks against the generated `Env` (see `worker-configuration.d.ts`,
 * produced by `npm run cf-typegen`). Never hand-write binding types — they
 * drift from wrangler.jsonc.
 *
 * This worker holds no secrets. `SUPABASE_PUBLISHABLE_KEY` is the public anon
 * key; data access is authorized exclusively by the calling user's JWT + RLS.
 */
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
