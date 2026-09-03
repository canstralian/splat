import type { AgentLimits } from "../constants";
import { AgentError, toAgentError } from "../errors";
import type { LogFn } from "../observability/log";
import type { ToolRegistry } from "../tools/registry";
import type { ToolCallRecord } from "../tools/types";
import type { SupabaseClientFactory } from "../supabase/rest";
import { classifyIntent } from "./classify";
import type { ModelClient } from "./model";
import { runAgentTurn } from "./pipeline";
import { checkTurnPolicy } from "./policy";
import type {
  ChatMessage,
  ExecutionRecord,
  ExecutionsOutput,
  ResetOutput,
  SessionStateOutput,
  TurnInput,
  TurnOutput,
} from "./types";

/**
 * Durable session state, kept deliberately narrow:
 * - conversation messages (short-term context for the model)
 * - execution history (observability / audit)
 * - the owning user id (isolation defense-in-depth)
 *
 * Application data (bugs, comments, …) lives in Supabase and is never
 * duplicated here — the Durable Object is not a database.
 */
export interface SessionStore {
  getUserId(): string | null;
  setUserId(userId: string): void;
  appendMessage(message: ChatMessage): void;
  listMessages(limit: number): ChatMessage[];
  countMessages(): number;
  pruneMessages(keep: number): void;
  appendExecution(record: ExecutionRecord): void;
  listExecutions(limit: number): ExecutionRecord[];
  countExecutions(): number;
  countExecutionsSince(timestampMs: number): number;
  clear(): void;
}

/** SQLite-backed store used inside the Durable Object. */
export class SqlSessionStore implements SessionStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS messages (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         created_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS executions (
         id TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         intent TEXT NOT NULL,
         model_id TEXT NOT NULL,
         error_code TEXT,
         error_message TEXT,
         tool_calls TEXT NOT NULL,
         duration_ms INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       );`,
    );
  }

  getUserId(): string | null {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'user_id'").toArray();
    return rows[0]?.value ?? null;
  }

  setUserId(userId: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('user_id', ?)", userId);
  }

  appendMessage(message: ChatMessage): void {
    this.sql.exec(
      "INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
      message.role,
      message.content,
      message.createdAt,
    );
  }

  listMessages(limit: number): ChatMessage[] {
    const rows = this.sql
      .exec<{ role: string; content: string; created_at: number }>(
        "SELECT role, content, created_at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        limit,
      )
      .toArray();
    return rows.map((r) => ({
      role: r.role as ChatMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  countMessages(): number {
    return Number(this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM messages").one().c);
  }

  pruneMessages(keep: number): void {
    this.sql.exec(
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)",
      keep,
    );
  }

  appendExecution(record: ExecutionRecord): void {
    this.sql.exec(
      `INSERT INTO executions (id, status, intent, model_id, error_code, error_message, tool_calls, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.status,
      record.intent,
      record.modelId,
      record.errorCode ?? null,
      record.errorMessage ?? null,
      JSON.stringify(record.toolCalls),
      record.durationMs,
      record.createdAt,
    );
  }

  listExecutions(limit: number): ExecutionRecord[] {
    const rows = this.sql
      .exec<{
        id: string;
        status: string;
        intent: string;
        model_id: string;
        error_code: string | null;
        error_message: string | null;
        tool_calls: string;
        duration_ms: number;
        created_at: number;
      }>("SELECT * FROM executions ORDER BY created_at DESC LIMIT ?", limit)
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      status: r.status as ExecutionRecord["status"],
      intent: r.intent as ExecutionRecord["intent"],
      modelId: r.model_id,
      errorCode: (r.error_code ?? undefined) as ExecutionRecord["errorCode"],
      errorMessage: r.error_message ?? undefined,
      toolCalls: JSON.parse(r.tool_calls) as ToolCallRecord[],
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  }

  countExecutions(): number {
    return Number(this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM executions").one().c);
  }

  countExecutionsSince(timestampMs: number): number {
    return Number(
      this.sql
        .exec<{ c: number }>("SELECT COUNT(*) AS c FROM executions WHERE created_at >= ?", timestampMs)
        .one().c,
    );
  }

  clear(): void {
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM executions");
  }
}

export interface SessionEngineDeps {
  store: SessionStore;
  model: ModelClient;
  registry: ToolRegistry;
  supabaseFactory: SupabaseClientFactory;
  limits: AgentLimits;
  now: () => number;
  log: LogFn;
  generateId: () => string;
}

function errorEnvelope(error: AgentError, executionId?: string) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      message: error.message,
      status: error.httpStatus,
      ...(executionId ? { executionId } : {}),
    },
  };
}

/**
 * Orchestrates the full lifecycle for one session:
 *
 *   (authenticated request) → user binding → task classification →
 *   policy check → context assembly → model/tool pipeline →
 *   result validation → state update → response
 *
 * Kept free of Cloudflare imports so it is unit-testable; the Durable Object
 * is a thin adapter around this class.
 */
export class SessionEngine {
  constructor(private readonly deps: SessionEngineDeps) {}

  /** Isolation defense-in-depth: the DO name already embeds the verified user id. */
  private assertOwnership(userId: string): void {
    const bound = this.deps.store.getUserId();
    if (bound === null) {
      this.deps.store.setUserId(userId);
      return;
    }
    if (bound !== userId) {
      throw new AgentError("forbidden", "This session belongs to a different user");
    }
  }

  async runTurn(input: TurnInput): Promise<TurnOutput> {
    const { store, limits, now, log } = this.deps;
    const executionId = this.deps.generateId();
    const startedAt = now();

    try {
      this.assertOwnership(input.identity.userId);

      const intent = classifyIntent(input.message);
      // Rate limiting counts turns that passed policy; policy failures are
      // rejected before anything is recorded.
      const recentTurnCount = store.countExecutionsSince(now() - limits.rateLimitWindowMs) + 1;
      const { exposure } = checkTurnPolicy({
        message: input.message,
        allowWrites: input.allowWrites,
        recentTurnCount,
        limits,
      });

      log("turn_start", {
        executionId,
        userId: input.identity.userId,
        intent,
        exposure,
        model: this.deps.model.modelId,
      });

      const history = store.listMessages(limits.historyContextMessages);
      const message = input.message.trim();

      let result: { reply: string; toolCalls: ToolCallRecord[] };
      try {
        result = await runAgentTurn(
          { executionId, message, intent, exposure, history, allowWrites: input.allowWrites },
          {
            model: this.deps.model,
            registry: this.deps.registry,
            toolContext: {
              identity: input.identity,
              supabase: this.deps.supabaseFactory(input.accessToken),
            },
            limits,
            now,
            log,
          },
        );
      } catch (error) {
        const agentError = toAgentError(error);
        const partialCalls = Array.isArray(agentError.details.toolCalls)
          ? (agentError.details.toolCalls as ToolCallRecord[])
          : [];
        store.appendExecution({
          id: executionId,
          status: "failed",
          intent,
          modelId: this.deps.model.modelId,
          errorCode: agentError.code,
          errorMessage: agentError.message,
          toolCalls: partialCalls,
          durationMs: now() - startedAt,
          createdAt: startedAt,
        });
        log("turn_failed", {
          executionId,
          code: agentError.code,
          message: agentError.message,
          details: agentError.details,
          toolCallCount: partialCalls.length,
          durationMs: now() - startedAt,
        });
        return errorEnvelope(agentError, executionId);
      }

      // State update: history persists only for completed turns so a failed
      // turn can be retried without poisoning the context.
      store.appendMessage({ role: "user", content: message, createdAt: startedAt });
      store.appendMessage({ role: "assistant", content: result.reply, createdAt: now() });
      if (store.countMessages() > limits.maxStoredMessages) {
        store.pruneMessages(limits.maxStoredMessages);
      }

      const durationMs = now() - startedAt;
      store.appendExecution({
        id: executionId,
        status: "completed",
        intent,
        modelId: this.deps.model.modelId,
        toolCalls: result.toolCalls,
        durationMs,
        createdAt: startedAt,
      });
      log("turn_completed", {
        executionId,
        durationMs,
        toolCallCount: result.toolCalls.length,
        replyChars: result.reply.length,
      });

      return {
        ok: true,
        executionId,
        reply: result.reply,
        intent,
        toolCalls: result.toolCalls,
        modelId: this.deps.model.modelId,
        durationMs,
      };
    } catch (error) {
      const agentError = toAgentError(error);
      log("turn_rejected", { executionId, code: agentError.code, message: agentError.message });
      return errorEnvelope(agentError, executionId);
    }
  }

  getState(userId: string): SessionStateOutput {
    try {
      this.assertOwnership(userId);
      return {
        ok: true,
        messages: this.deps.store.listMessages(this.deps.limits.maxStoredMessages),
        executionCount: this.deps.store.countExecutions(),
      };
    } catch (error) {
      return errorEnvelope(toAgentError(error));
    }
  }

  getExecutions(userId: string): ExecutionsOutput {
    try {
      this.assertOwnership(userId);
      return { ok: true, executions: this.deps.store.listExecutions(this.deps.limits.maxExecutionsListed) };
    } catch (error) {
      return errorEnvelope(toAgentError(error));
    }
  }

  reset(userId: string): ResetOutput {
    try {
      this.assertOwnership(userId);
      this.deps.store.clear();
      this.deps.log("session_reset", { userId });
      return { ok: true };
    } catch (error) {
      return errorEnvelope(toAgentError(error));
    }
  }
}
