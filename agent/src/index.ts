import { getAgentByName } from "agents";
import type { BackgroundMessage, Env } from "./env";
import { AgentError } from "./errors";
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
 * Worker entry point. Owns HTTP routing, authentication and input validation at
 * the trust boundary, then delegates governed execution to the per-session
 * Durable Object. Also consumes the background queue for evidence archival.
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

      // All other routes require authentication.
      const authError = authenticate(request, env);
      if (authError) return authError;

      // POST /v1/sessions/:sessionId/messages  -> run the agent
      const messageRoute = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/messages$/,
      );
      if (messageRoute && request.method === "POST") {
        return await handleMessage(request, env, messageRoute[1]);
      }

      // GET /v1/sessions/:sessionId  -> session summary + history
      const sessionRoute = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionRoute && request.method === "GET") {
        return await handleGetSession(env, sessionRoute[1]);
      }

      // GET /v1/runs/:runId  -> run ledger row
      const runRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (runRoute && request.method === "GET") {
        return await handleGetRun(env, runRoute[1]);
      }

      // GET /v1/runs/:runId/evidence  -> full evidence ledger
      const evidenceRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)\/evidence$/);
      if (evidenceRoute && request.method === "GET") {
        return await handleGetEvidence(env, evidenceRoute[1]);
      }

      // GET /v1/runs/:runId/replay  -> reconstructed, invariant-checked run
      const replayRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)\/replay$/);
      if (replayRoute && request.method === "GET") {
        return await handleReplay(env, replayRoute[1]);
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
        // Let the platform retry (respecting max_retries / DLQ).
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

  // Only honor a scripted model if the environment explicitly allows it.
  const modelScript =
    env.ALLOW_SCRIPTED_PROVIDER === "true" ? parsed.data.modelScript : undefined;

  const input: RunInput = {
    sessionId: sessionId.data,
    message: parsed.data.message,
    idempotencyKey: parsed.data.idempotencyKey,
    approvals: parsed.data.approvals,
    modelScript,
  };

  const stub = await getAgentByName(env.ORCHESTRATOR, sessionId.data);
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

async function handleGetSession(env: Env, rawSessionId: string): Promise<Response> {
  const sessionId = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionId.success) return json({ error: "invalid_session_id" }, 400);

  const stub = await getAgentByName(env.ORCHESTRATOR, sessionId.data);
  const summary = await stub.getSessionSummary();
  const history = await stub.getHistory();
  return json({ session: summary, history });
}

async function handleGetRun(env: Env, rawRunId: string): Promise<Response> {
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return json({ error: "invalid_run_id" }, 400);

  const store = new RunStore(env.DB);
  const run = await store.getRun(runId.data);
  if (!run) return json({ error: "not_found" }, 404);
  return json({ run });
}

async function handleGetEvidence(env: Env, rawRunId: string): Promise<Response> {
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return json({ error: "invalid_run_id" }, 400);

  const store = new RunStore(env.DB);
  const evidence = await store.listEvidence(runId.data);
  return json({ runId: runId.data, evidence });
}

async function handleReplay(env: Env, rawRunId: string): Promise<Response> {
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return json({ error: "invalid_run_id" }, 400);

  const store = new RunStore(env.DB);
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

  // Idempotent: writing to the same key overwrites the same audit bundle.
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

/** Constant-time-ish bearer token check against the API_AUTH_TOKEN secret. */
function authenticate(request: Request, env: Env): Response | null {
  if (!env.API_AUTH_TOKEN) {
    // Fail closed: if no token is configured, reject all authenticated routes.
    return json({ error: "server_misconfigured" }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !timingSafeEqual(token, env.API_AUTH_TOKEN)) {
    return json({ error: "unauthenticated" }, 401);
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: unknown, logger: Logger): Response {
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
    // Generic client-facing error; details go to logs, not the response body.
    return json({ error: err.code.toLowerCase() }, status);
  }
  logger.error("Unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  return json({ error: "internal_error" }, 500);
}
