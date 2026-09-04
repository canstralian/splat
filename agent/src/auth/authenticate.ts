import { UnauthenticatedError } from "../errors";
import type { Env } from "../env";
import { verifySupabaseJwt } from "./jwt";

/**
 * The authenticated principal for a request. `userId` is the isolation key: all
 * sessions and runs are scoped to it so users cannot reach each other's data.
 */
export interface AuthContext {
  userId: string;
  email?: string;
  mode: "supabase" | "service";
  /**
   * The raw Supabase access token, forwarded ONLY to tools that act on the
   * user's behalf against Supabase (RLS-enforced). Never sent to the model,
   * never written to evidence or logs.
   */
  userToken?: string;
}

/**
 * Authenticate a request. Reuses Splatt's Supabase auth by verifying the user's
 * access token. A separate service-token mode is available for trusted internal
 * callers but never impersonates a user.
 *
 * Authorization always derives from this runtime check — never from model or
 * request content.
 */
export async function authenticate(
  request: Request,
  env: Env,
  now: () => number = () => Date.now(),
): Promise<AuthContext> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    throw new UnauthenticatedError("Missing bearer token");
  }

  const mode = (env.AUTH_MODE ?? "supabase").toLowerCase();

  if (mode === "service") {
    if (!env.API_AUTH_TOKEN) {
      throw new UnauthenticatedError("Service auth not configured");
    }
    if (!timingSafeEqual(token, env.API_AUTH_TOKEN)) {
      throw new UnauthenticatedError("Invalid service token");
    }
    return { userId: "service", mode: "service" };
  }

  // Default: Supabase user JWT.
  if (!env.SUPABASE_JWT_SECRET) {
    throw new UnauthenticatedError("Supabase auth not configured");
  }
  const claims = await verifySupabaseJwt(token, env.SUPABASE_JWT_SECRET, now);
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    mode: "supabase",
    userToken: token,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
