import { z } from "zod";
import { authenticateRequest, type AuthConfig, type AuthenticatedCaller } from "./auth";
import { DEFAULT_LIMITS, SESSION_ID_PATTERN } from "./constants";
import { corsHeadersFor, parseAllowedOrigins } from "./cors";
import { assertConfigured } from "./env";
import { AgentError, toAgentError } from "./errors";
import { logEvent, type LogFn } from "./observability/log";
import type { ExecutionsOutput, ResetOutput, SessionStateOutput, TurnOutput } from "./agent/types";

/**
 * HTTP surface of the agent:
 *
 *   GET    /api/agent/health
 *   GET    /api/agent/sessions/:sessionId              — conversation state
 *   GET    /api/agent/sessions/:sessionId/executions   — execution history
 *   POST   /api/agent/sessions/:sessionId/messages     — run one agent turn
 *   DELETE /api/agent/sessions/:sessionId              — clear the conversation
 *
 * Every session route authenticates the Supabase JWT first; the Durable
 * Object is addressed as `${verifiedUserId}:${sessionId}`, so one user can
 * never reach another user's session by construction.
 */
const messageBodySchema = z.object({
  message: z.string(),
  allowWrites: z.boolean().optional().default(false),
});

export interface RouterDeps {
  authenticate?: (request: Request, config: AuthConfig) => Promise<AuthenticatedCaller>;
  log?: LogFn;
  ctx?: ExecutionContext;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function errorResponse(error: AgentError, cors: Record<string, string>): Response {
  return json({ error: error.toPublicJSON() }, error.httpStatus, cors);
}

type SessionEnvelope = TurnOutput | SessionStateOutput | ExecutionsOutput | ResetOutput;

function successPayload(out: Extract<SessionEnvelope, { ok: true }>): Record<string, unknown> {
  if ("reply" in out) {
    return {
      executionId: out.executionId,
      reply: out.reply,
      intent: out.intent,
      toolCalls: out.toolCalls,
      modelId: out.modelId,
      durationMs: out.durationMs,
    };
  }
  if ("messages" in out) {
    return { messages: out.messages, executionCount: out.executionCount };
  }
  if ("executions" in out) {
    return { executions: out.executions };
  }
  return {};
}

function envelopeToResponse(out: SessionEnvelope, cors: Record<string, string>): Response {
  if (!out.ok) {
    const { status, executionId, ...publicError } = out.error;
    return json({ error: { ...publicError, ...(executionId ? { executionId } : {}) } }, status, cors);
  }
  return json(successPayload(out), 200, cors);
}

function assertJsonBodySize(request: Request): void {
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader === null) return;
  const length = Number.parseInt(lengthHeader, 10);
  if (!Number.isFinite(length) || length < 0 || length > DEFAULT_LIMITS.maxJsonBodyBytes) {
    throw new AgentError("invalid_request", "Request body is too large");
  }
}

export async function handleAgentRequest(
  request: Request,
  env: Env,
  deps: RouterDeps = {},
): Promise<Response> {
  const log = deps.log ?? logEvent;
  const authenticate = deps.authenticate ?? authenticateRequest;
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const cors = corsHeadersFor(request, allowedOrigins);
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (url.pathname === "/api/agent/health" && request.method === "GET") {
      return json(
        {
          ok: true,
          version: env.AGENT_VERSION || "unknown",
          model: env.MODEL_ID || "unknown",
          provider: env.MODEL_PROVIDER || "workers-ai",
        },
        200,
        cors,
      );
    }

    const match = /^\/api\/agent\/sessions\/([^/]+)(?:\/(messages|executions))?$/.exec(url.pathname);
    if (!match) {
      return json({ error: { code: "invalid_request", message: "Not found" } }, 404, cors);
    }

    assertConfigured(env);

    const sessionId = match[1];
    const subResource = match[2];
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new AgentError("invalid_request", "Invalid session id");
    }

    const { identity, accessToken } = await authenticate(request, {
      supabaseUrl: env.SUPABASE_URL,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      timeoutMs: DEFAULT_LIMITS.authTimeoutMs,
    });

    // User isolation by construction: the DO name embeds the verified user id.
    // getByName is the current DurableObjectNamespace API (replaces idFromName+get).
    const stub = env.AGENT_SESSION.getByName(`${identity.userId}:${sessionId}`);

    if (subResource === "messages" && request.method === "POST") {
      assertJsonBodySize(request);
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        throw new AgentError("invalid_request", "Request body must be JSON");
      }
      const parsed = messageBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new AgentError("invalid_request", "Body must be { message: string, allowWrites?: boolean }");
      }
      const out = await stub.runTurn({
        identity,
        accessToken,
        message: parsed.data.message,
        allowWrites: parsed.data.allowWrites,
      });
      return envelopeToResponse(out, cors);
    }

    if (subResource === "executions" && request.method === "GET") {
      return envelopeToResponse(await stub.getExecutions({ userId: identity.userId }), cors);
    }

    if (subResource === undefined && request.method === "GET") {
      return envelopeToResponse(await stub.getState({ userId: identity.userId }), cors);
    }

    if (subResource === undefined && request.method === "DELETE") {
      return envelopeToResponse(await stub.reset({ userId: identity.userId }), cors);
    }

    return json({ error: { code: "invalid_request", message: "Method not allowed" } }, 405, cors);
  } catch (error) {
    const agentError = toAgentError(error);
    if (agentError.code === "internal_error") {
      log("request_failed", {
        path: url.pathname,
        method: request.method,
        message: agentError.message,
        cause: agentError.cause instanceof Error ? agentError.cause.message : String(agentError.cause ?? ""),
      });
    } else {
      log("request_rejected", { path: url.pathname, method: request.method, code: agentError.code });
    }
    return errorResponse(agentError, cors);
  }
}
