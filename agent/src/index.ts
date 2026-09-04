import { getAgentByName } from "agents";
import type { BackgroundMessage, Env } from "./env";
import { AgentError, UnauthenticatedError } from "./errors";
import { authenticate, type AuthContext } from "./auth/authenticate";
import { Logger } from "./observability/logger";
import { RunStore } from "./state/run-store";
import { replayRun } from "./replay/replay";
import {
  messageRequestSchema,
  runIdSchema,
  sessionIdSchema,
} from "./api/schema";
import type { RunInput } from "./types";

export { OrchestratorAgent } from "./agent/orchestrator-agent";

/**
 * Worker entry point. Owns HTTP routing, authentication (Splatt Supabase JWT)
 * and input validation at the trust boundary, then delegates governed execution
 * to a per-user, per-session Durable Object. Also consumes the background queue
 * for evidence archival.
 *
 * Sessions are namespaced by authenticated user id, so a user physically cannot
 * address another user's session (tenant/user isolation).
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const logger = new Logger({ path: url.pathname });

    try {
      // Health check is unauthenticated.
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", agent: env.AGENT_ID, version: env.AGENT_VERSION });
      }

      // Authenticate all other routes (throws UnauthenticatedError on failure).
      const auth = await authenticate(request, env);

      const messageRoute = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/messages$/,
      );
      if (messageRoute && request.method === "POST") {
        return await handleMessage(request, env, messageRoute[1], auth);
      }

      const sessionRoute = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionRoute && request.method === "GET") {
        return await handleGetSession(env, sessionRoute[1], auth);
      }

      const runRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (runRoute && request.method === "GET") {
        return await handleGetRun(env, runRoute[1], auth);
      }

      const evidenceRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)\/evidence$/);
      if (evidenceRoute && request.method === "GET") {
        return await handleGetEvidence(env, evidenceRoute[1], auth);
      }

      const replayRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)\/replay$/);
      if (replayRoute && request.method === "GET") {
        return await handleReplay(env, replayRoute[1], auth);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      return errorResponse(err, logger);
    }
  },

  /** Background queue consumer: idempotent archival of a Run's evidence to R2. */
  async queue(
    batch: MessageBatch<BackgroundMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const logger = new Logger({ component: "queue-consumer" });
    for (const message of batch.messages) {
      try {
        await handleBackgroundMessage(message.body, env, logger);
        message.ack();
      } catch (err) {
        logger.error("Background message failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry();
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleMessage(
  request: Request,
  env: Env,
  rawSessionId: string,
  auth: AuthContext,
): Promise<Response> {
  const sessionId = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionId.success) {
    return json({ error: "invalid_session_id" }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const parsed = messageRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  const modelScript =
    env.ALLOW_SCRIPTED_PROVIDER === "true" ? parsed.data.modelScript : undefined;

  const input: RunInput = {
    sessionId: sessionId.data,
    ownerUserId: auth.userId,
    userToken: auth.userToken,
    message: parsed.data.message,
    idempotencyKey: parsed.data.idempotencyKey,
    approvals: parsed.data.approvals,
    modelScript,
  };

  const stub = await getAgentByName(env.ORCHESTRATOR, sessionKey(auth.userId, sessionId.data));
  const outcome = await stub.startRun(input);

  const httpStatus =
    outcome.status === "completed"
      ? 200
      : outcome.status === "awaiting_approval"
        ? 202
        : outcome.status === "denied"
          ? 403
          : 422;

  return json({ run: outcome }, httpStatus);
}

async function handleGetSession(
  env: Env,
  rawSessionId: string,
  auth: AuthContext,
): Promise<Response> {
  const sessionId = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionId.success) return json({ error: "invalid_session_id" }, 400);

  const stub = await getAgentByName(env.ORCHESTRATOR, sessionKey(auth.userId, sessionId.data));
  const summary = await stub.getSessionSummary();
  const history = await stub.getHistory();
  return json({ session: summary, history });
}

async function handleGetRun(env: Env, rawRunId: string, auth: AuthContext): Promise<Response> {
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return json({ error: "invalid_run_id" }, 400);

  const store = new RunStore(env.DB);
  const run = await store.getRun(runId.data);
  // Not found and not-owned are indistinguishable to avoid leaking existence.
  if (!run || run.ownerUserId !== auth.userId) return json({ error: "not_found" }, 404);
  return json({ run });
}

async function handleGetEvidence(env: Env, rawRunId: string, auth: AuthContext): Promise<Response> {
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return json({ error: "invalid_run_id" }, 400);

  const store = new RunStore(env.DB);
  const run = await store.getRun(runId.data);
  if (!run || run.ownerUserId !== auth.userId) return json({ error: "not_found" }, 404);

  const evidence = await store.listEvidence(runId.data);
  return json({ runId: runId.data, evidence });
}

async function handleReplay(env: Env, rawRunId: string, auth: AuthContext): Promise<Response> {
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return json({ error: "invalid_run_id" }, 400);

  const store = new RunStore(env.DB);
  const run = await store.getRun(runId.data);
  if (!run || run.ownerUserId !== auth.userId) return json({ error: "not_found" }, 404);

  const report = await replayRun(store, runId.data);
  return json({ replay: report });
}

async function handleBackgroundMessage(
  message: BackgroundMessage,
  env: Env,
  logger: Logger,
): Promise<void> {
  if (message.type !== "archive_run") {
    logger.warn("Unknown background message", { type: message.type });
    return;
  }
  const store = new RunStore(env.DB);
  const run = await store.getRun(message.runId);
  if (!run) {
    logger.warn("Archival skipped: run not found", { runId: message.runId });
    return;
  }
  const evidence = await store.listEvidence(message.runId);
  const bundle = JSON.stringify({ run, evidence, archivedAt: Date.now() });

  await env.EVIDENCE_BUCKET.put(`runs/${message.runId}/audit.json`, bundle, {
    httpMetadata: { contentType: "application/json" },
  });
  logger.info("Archived run evidence", {
    runId: message.runId,
    events: evidence.length,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Durable Object name: namespaced by user so sessions cannot collide across users. */
function sessionKey(userId: string, sessionId: string): string {
  return `${userId}::${sessionId}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: unknown, logger: Logger): Response {
  if (err instanceof UnauthenticatedError) {
    logger.warn("Unauthenticated request", { message: err.message });
    return json({ error: "unauthenticated" }, 401);
  }
  if (err instanceof AgentError) {
    logger.warn("Request failed", { code: err.code, message: err.message });
    const status =
      err.code === "NOT_FOUND"
        ? 404
        : err.code === "UNAUTHENTICATED"
          ? 401
          : err.code === "INVALID_INPUT"
            ? 400
            : 422;
    return json({ error: err.code.toLowerCase() }, status);
  }
  logger.error("Unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  return json({ error: "internal_error" }, 500);
}
