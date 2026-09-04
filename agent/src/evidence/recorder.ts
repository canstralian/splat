import type { Env } from "../env";
import type { RunStore } from "../state/run-store";
import type { RuntimeDeps } from "../runtime/deps";
import type { EvidenceRecord, LifecycleStage, Verification } from "../types";

/** Detail payloads larger than this (serialized bytes) are offloaded to R2. */
const INLINE_DETAIL_LIMIT = 8 * 1024;

export interface RecordOptions {
  /** Force offload of the detail payload to R2 regardless of size. */
  forceArtifact?: boolean;
}

/**
 * Append-only evidence writer. Every meaningful lifecycle transition is recorded
 * with a monotonically increasing `seq`, an epistemic {@link Verification}
 * classification, and structured detail. Large payloads (e.g. raw model text)
 * are offloaded to R2 and referenced by key so the D1 ledger stays queryable.
 *
 * Secrets must never be passed into `detail`.
 */
export class EvidenceRecorder {
  private seq = 0;
  private readonly records: EvidenceRecord[] = [];

  constructor(
    private readonly store: RunStore,
    private readonly env: Env,
    private readonly runId: string,
    private readonly deps: RuntimeDeps,
  ) {}

  get count(): number {
    return this.seq;
  }

  /** All evidence recorded so far in this Run (in order). */
  get recorded(): readonly EvidenceRecord[] {
    return this.records;
  }

  async record(
    stage: LifecycleStage,
    verification: Verification,
    summary: string,
    detail: Record<string, unknown>,
    options: RecordOptions = {},
  ): Promise<EvidenceRecord> {
    const serialized = JSON.stringify(detail);
    let artifactKey: string | null = null;
    let storedDetail = detail;

    if (options.forceArtifact || serialized.length > INLINE_DETAIL_LIMIT) {
      artifactKey = `runs/${this.runId}/evidence/${this.seq}.json`;
      await this.env.EVIDENCE_BUCKET.put(artifactKey, serialized, {
        httpMetadata: { contentType: "application/json" },
      });
      storedDetail = {
        _offloaded: true,
        artifactKey,
        byteLength: serialized.length,
        preview: serialized.slice(0, 512),
      };
    }

    const record: EvidenceRecord = {
      id: this.deps.uuid(),
      runId: this.runId,
      seq: this.seq++,
      stage,
      verification,
      summary,
      detail: storedDetail,
      artifactKey,
      createdAt: this.deps.now(),
    };

    await this.store.appendEvidence(record);
    this.records.push(record);
    return record;
  }
}
