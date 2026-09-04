import { PersistenceError, StaleWriteError } from "../errors";
import type { EvidenceRecord, RunRecord } from "../types";

/**
 * Durable persistence for the Run aggregate and its evidence children in D1.
 *
 * State separation:
 *  - ephemeral execution state   -> in-memory during a Run (never persisted here)
 *  - durable agent/session state -> Durable Object state + DO SQL (see OrchestratorAgent)
 *  - user/application data       -> `runs` (the Run ledger)
 *  - derived memory              -> `agent_memory` (see memory tools)
 *  - evidence/audit records      -> `run_events`
 *
 * Writes to a Run use optimistic concurrency (compare-and-set on `version`) so
 * stale writes are detected rather than silently lost.
 */
export class RunStore {
  constructor(private readonly db: D1Database) {}

  async createRun(record: RunRecord): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO runs (
             id, session_id, agent_id, agent_version, status, input, intent,
             outcome, error, tool_call_count, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.id,
          record.sessionId,
          record.agentId,
          record.agentVersion,
          record.status,
          record.input,
          record.intent,
          record.outcome,
          record.error,
          record.toolCallCount,
          record.version,
          record.createdAt,
          record.updatedAt,
        )
        .run();
    } catch (err) {
      throw new PersistenceError(`Failed to create run: ${asMessage(err)}`, {
        runId: record.id,
      });
    }
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .bind(id)
      .first<RunRow>();
    return row ? rowToRun(row) : null;
  }

  /**
   * Compare-and-set update. `expectedVersion` must match the persisted version;
   * on success the version is incremented. A mismatch throws {@link StaleWriteError}.
   */
  async updateRun(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        RunRecord,
        "status" | "intent" | "outcome" | "error" | "toolCallCount"
      >
    >,
    now: number,
  ): Promise<number> {
    const nextVersion = expectedVersion + 1;
    let result: D1Result;
    try {
      result = await this.db
        .prepare(
          `UPDATE runs SET
             status = COALESCE(?, status),
             intent = COALESCE(?, intent),
             outcome = COALESCE(?, outcome),
             error = COALESCE(?, error),
             tool_call_count = COALESCE(?, tool_call_count),
             version = ?,
             updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          patch.status ?? null,
          patch.intent ?? null,
          patch.outcome ?? null,
          patch.error ?? null,
          patch.toolCallCount ?? null,
          nextVersion,
          now,
          id,
          expectedVersion,
        )
        .run();
    } catch (err) {
      throw new PersistenceError(`Failed to update run: ${asMessage(err)}`, {
        runId: id,
      });
    }

    if ((result.meta?.changes ?? 0) === 0) {
      throw new StaleWriteError(
        "Run update rejected: version mismatch (concurrent modification)",
        { runId: id, expectedVersion },
      );
    }
    return nextVersion;
  }

  async appendEvidence(record: EvidenceRecord): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO run_events (
             id, run_id, seq, stage, verification, summary, detail, artifact_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.id,
          record.runId,
          record.seq,
          record.stage,
          record.verification,
          record.summary,
          JSON.stringify(record.detail),
          record.artifactKey,
          record.createdAt,
        )
        .run();
    } catch (err) {
      throw new PersistenceError(
        `Failed to append evidence: ${asMessage(err)}`,
        { runId: record.runId, seq: record.seq },
      );
    }
  }

  async listEvidence(runId: string): Promise<EvidenceRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC",
      )
      .bind(runId)
      .all<EvidenceRow>();
    return (rows.results ?? []).map(rowToEvidence);
  }
}

interface RunRow {
  id: string;
  session_id: string;
  agent_id: string;
  agent_version: string;
  status: string;
  input: string;
  intent: string | null;
  outcome: string | null;
  error: string | null;
  tool_call_count: number;
  version: number;
  created_at: number;
  updated_at: number;
}

interface EvidenceRow {
  id: string;
  run_id: string;
  seq: number;
  stage: string;
  verification: string;
  summary: string;
  detail: string;
  artifact_key: string | null;
  created_at: number;
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    status: row.status as RunRecord["status"],
    input: row.input,
    intent: row.intent,
    outcome: row.outcome,
    error: row.error,
    toolCallCount: row.tool_call_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    stage: row.stage as EvidenceRecord["stage"],
    verification: row.verification as EvidenceRecord["verification"],
    summary: row.summary,
    detail: safeParse(row.detail),
    artifactKey: row.artifact_key,
    createdAt: row.created_at,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { _unparseable: json };
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
