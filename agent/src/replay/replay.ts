import { NotFoundError } from "../errors";
import type { RunStore } from "../state/run-store";
import type { EvidenceRecord, LifecycleStage, RunRecord } from "../types";

export interface ReplayStep {
  seq: number;
  stage: LifecycleStage;
  verification: EvidenceRecord["verification"];
  summary: string;
}

export interface ReplayReport {
  run: RunRecord;
  steps: ReplayStep[];
  /** Provider/model identities observed, for reproducibility. */
  modelInvocations: Array<{
    seq: number;
    provider: unknown;
    model: unknown;
    promptFingerprint: unknown;
  }>;
  toolExecutions: Array<{ seq: number; tool: unknown; idempotencyKey: unknown }>;
  /** Invariant checks that must hold for a well-formed, auditable Run. */
  invariants: {
    sequentialSeq: boolean;
    everyToolExecutionHadPriorAllow: boolean;
    toolExecutionCountMatchesRun: boolean;
    terminalStagePresent: boolean;
  };
  consistent: boolean;
}

/**
 * Reconstruct a Run from its recorded evidence and verify structural invariants.
 * The goal is reproducible, auditable execution — not bit-identical LLM output.
 */
export async function replayRun(
  store: RunStore,
  runId: string,
): Promise<ReplayReport> {
  const run = await store.getRun(runId);
  if (!run) throw new NotFoundError(`Run not found: ${runId}`, { runId });

  const evidence = await store.listEvidence(runId);

  const steps: ReplayStep[] = evidence.map((e) => ({
    seq: e.seq,
    stage: e.stage,
    verification: e.verification,
    summary: e.summary,
  }));

  const modelInvocations = evidence
    .filter((e) => e.stage === "model_reasoning")
    .map((e) => ({
      seq: e.seq,
      provider: e.detail.provider,
      model: e.detail.model,
      promptFingerprint: e.detail.promptFingerprint,
    }));

  const toolExecutions = evidence
    .filter((e) => e.stage === "tool_execution")
    .map((e) => ({
      seq: e.seq,
      tool: e.detail.tool,
      idempotencyKey: e.detail.idempotencyKey,
    }));

  // Invariant 1: seq is a dense, ascending sequence starting at 0.
  const sequentialSeq = evidence.every((e, i) => e.seq === i);

  // Invariant 2: every tool_execution is immediately preceded by an "allow"
  // capability-gate policy_check.
  let everyToolExecutionHadPriorAllow = true;
  for (let i = 0; i < evidence.length; i++) {
    if (evidence[i].stage === "tool_execution") {
      const prior = evidence[i - 1];
      const isAllowGate =
        prior?.stage === "policy_check" && prior.detail.decision === "allow";
      if (!isAllowGate) {
        everyToolExecutionHadPriorAllow = false;
        break;
      }
    }
  }

  // Invariant 3: the count of tool_execution events matches the Run's counter.
  const toolExecutionCountMatchesRun = toolExecutions.length === run.toolCallCount;

  // Invariant 4: a terminal "response" stage exists.
  const terminalStagePresent = evidence.some((e) => e.stage === "response");

  const invariants = {
    sequentialSeq,
    everyToolExecutionHadPriorAllow,
    toolExecutionCountMatchesRun,
    terminalStagePresent,
  };
  const consistent = Object.values(invariants).every(Boolean);

  return {
    run,
    steps,
    modelInvocations,
    toolExecutions,
    invariants,
    consistent,
  };
}
