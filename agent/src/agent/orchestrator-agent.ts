import { Agent, type Connection } from "agents";
import type { Env } from "../env";
import { EvidenceRecorder } from "../evidence/recorder";
import { PolicyEngine, policyFromEnv } from "../governance/policy";
import { createModelProvider } from "../model/providers";
import { Logger } from "../observability/logger";
import { RunStore } from "../state/run-store";
import { createDefaultRegistry } from "../tools/builtins";
import { defaultDeps, type RuntimeDeps } from "../runtime/deps";
import { runLifecycle, type RunOutcome } from "../runtime/lifecycle";
import type { ConversationMessage, RunInput } from "../types";

/** Durable, per-session agent state (kept intentionally small). */
export interface SessionState {
  sessionId: string;
  runCount: number;
  lastRunId: string | null;
  lastStatus: string | null;
  updatedAt: number;
}

const HISTORY_LIMIT = 40;

/**
 * The OrchestratorAgent is a Durable Object (via the Agents SDK) addressed by
 * session id. It owns:
 *  - durable session state (this.state / setState)
 *  - the session conversation transcript (DO SQLite via this.sql)
 * and drives one governed {@link runLifecycle} per user message.
 *
 * Concurrency is safe because a Durable Object serializes calls to a single
 * instance; the Run ledger additionally uses optimistic concurrency in D1.
 */
export class OrchestratorAgent extends Agent<Env, SessionState> {
  initialState: SessionState = {
    sessionId: "",
    runCount: 0,
    lastRunId: null,
    lastStatus: null,
    updatedAt: 0,
  };

  private readonly deps: RuntimeDeps = defaultDeps;
  /**
   * Last persisted runCount, tracked in a plain field. `validateStateChange`
   * must NOT read the reactive `this.state` getter, because the getter can
   * re-enter `_setStateInternal` -> `validateStateChange` and recurse.
   */
  private lastRunCount = 0;

  onStart(): void {
    this.ensureSchema();
  }

  /** Idempotently ensure the transcript table exists (safe to call repeatedly). */
  private ensureSchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS session_messages (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT NOT NULL,
        tool_name   TEXT,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `;
  }

  /**
   * Reject illegal state transitions. Runs monotonically increase; a decrease
   * indicates a stale or malicious update. Runs BEFORE persistence/broadcast.
   * Compares against `lastRunCount` (a plain field), never `this.state`.
   */
  validateStateChange(next: SessionState, _source: Connection | "server"): void {
    if (next.runCount < this.lastRunCount) {
      throw new Error("Illegal state transition: runCount must not decrease");
    }
  }

  /** Track the last persisted runCount after each successful state change. */
  onStateChanged(state: SessionState, _source: Connection | "server"): void {
    this.lastRunCount = state.runCount;
  }

  /** Execute one governed Run for a user message. Primary entry point (RPC). */
  async startRun(input: RunInput): Promise<RunOutcome> {
    this.ensureSchema();
    const runId = this.deps.uuid();
    const logger = new Logger({
      runId,
      sessionId: input.sessionId,
      agentId: this.env.AGENT_ID,
    });

    const history = this.loadHistory();
    const store = new RunStore(this.env.DB);
    const recorder = new EvidenceRecorder(store, this.env, runId, this.deps);
    const registry = createDefaultRegistry();
    const policy = new PolicyEngine(policyFromEnv(this.env));
    const provider = createModelProvider(this.env, {
      modelScript: input.modelScript,
    });

    // Approvals originate only from the trusted, authenticated caller.
    const approvals = input.approvals ?? [];

    const defaultToolTimeoutMs = Number.parseInt(
      this.env.TOOL_DEFAULT_TIMEOUT_MS ?? "10000",
      10,
    );

    logger.info("Run starting", { intentPreview: input.message.slice(0, 80) });

    const outcome = await runLifecycle({
      env: this.env,
      deps: this.deps,
      logger,
      runId,
      input,
      approvals,
      history,
      provider,
      registry,
      policy,
      store,
      recorder,
      defaultToolTimeoutMs,
    });

    // Persist the transcript produced by this Run.
    this.persistMessages(outcome.newMessages);

    // Update durable session state (monotonic runCount).
    this.setState({
      sessionId: input.sessionId,
      runCount: this.state.runCount + 1,
      lastRunId: runId,
      lastStatus: outcome.status,
      updatedAt: this.deps.now(),
    });

    // Enqueue idempotent background archival of the Run's evidence to R2.
    try {
      await this.env.BACKGROUND_QUEUE.send({
        type: "archive_run",
        runId,
        idempotencyKey: `archive:${runId}`,
      });
    } catch (err) {
      // Archival is best-effort; never fail the Run because the queue is down.
      logger.warn("Failed to enqueue archival", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info("Run finished", {
      status: outcome.status,
      toolCallCount: outcome.toolCallCount,
    });
    return outcome;
  }

  /** Read-only session summary. */
  getSessionSummary(): SessionState {
    return this.state;
  }

  /** Read-only transcript access. */
  getHistory(limit = HISTORY_LIMIT): ConversationMessage[] {
    return this.loadHistory(limit);
  }

  private loadHistory(limit = HISTORY_LIMIT): ConversationMessage[] {
    const rows = this.sql<{
      role: string;
      tool_name: string | null;
      content: string;
      created_at: number;
    }>`
      SELECT role, tool_name, content, created_at
      FROM session_messages
      ORDER BY seq DESC
      LIMIT ${limit}
    `;
    return rows
      .reverse()
      .map((r) => ({
        role: r.role as ConversationMessage["role"],
        toolName: r.tool_name ?? undefined,
        content: r.content,
        createdAt: r.created_at,
      }));
  }

  private persistMessages(messages: ConversationMessage[]): void {
    for (const m of messages) {
      this.sql`
        INSERT INTO session_messages (role, tool_name, content, created_at)
        VALUES (${m.role}, ${m.toolName ?? null}, ${m.content}, ${m.createdAt})
      `;
    }
  }
}
