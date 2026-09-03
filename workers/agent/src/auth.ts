import { AgentError } from "./errors";

/**
 * Authentication: verifies the caller's Supabase session JWT by asking
 * Supabase Auth itself (`GET /auth/v1/user`), the same convention Splat's
 * existing edge functions use (`supabase.auth.getUser()`).
 *
 * The verified token is then reused for all downstream PostgREST calls so
 * Postgres RLS — Splat's existing authorization layer — governs every read
 * and write the agent performs on behalf of the user.
 */
export interface AgentIdentity {
  userId: string;
  email: string | null;
}

export interface AuthConfig {
  supabaseUrl: string;
  publishableKey: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export interface AuthenticatedCaller {
  identity: AgentIdentity;
  /** The raw Supabase JWT, held by the runtime only — never given to the model. */
  accessToken: string;
}

export function extractBearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || match[1].length === 0) {
    throw new AgentError("unauthorized", "Missing or malformed Authorization header");
  }
  return match[1];
}

export async function authenticateRequest(
  request: Request,
  config: AuthConfig,
): Promise<AuthenticatedCaller> {
  const accessToken = extractBearerToken(request);
  const fetchFn = config.fetchFn ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(`${config.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
  } catch (cause) {
    throw new AgentError("upstream_error", "Authentication service is unavailable", { cause });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AgentError("unauthorized", "Invalid or expired session");
  }
  if (!response.ok) {
    throw new AgentError("upstream_error", "Authentication service returned an error", {
      details: { status: response.status },
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new AgentError("upstream_error", "Authentication service returned malformed data", { cause });
  }

  const user = body as { id?: unknown; email?: unknown };
  if (typeof user.id !== "string" || user.id.length === 0) {
    throw new AgentError("upstream_error", "Authentication service returned malformed data");
  }

  return {
    identity: {
      userId: user.id,
      email: typeof user.email === "string" ? user.email : null,
    },
    accessToken,
  };
}
