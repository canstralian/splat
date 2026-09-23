import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { runLifecycle } from "../src/runtime/lifecycle";
import { EvidenceRecorder } from "../src/evidence/recorder";
import { RunStore } from "../src/state/run-store";
import { createDefaultRegistry } from "../src/tools/builtins";
import {
  DEFAULT_POLICY,
  PolicyEngine,
  type Policy,
} from "../src/governance/policy";
import { ScriptedProvider } from "../src/model/providers";
import { defaultDeps } from "../src/runtime/deps";
import { Logger } from "../src/observability/logger";
import { replayRun } from "../src/replay/replay";
import type { RunInput } from "../src/types";

async function runWith(
  script: unknown[],
  opts: {
    message?: string;
    approvals?: string[];
    policy?: Policy;
    sessionId?: string;
  } = {},
) {
  const deps = defaultDeps;
  const runId = deps.uuid();
  const store = new RunStore(env.DB);
  const recorder = new EvidenceRecorder(store, env, runId, deps);
  const input: RunInput = {
    sessionId: opts.sessionId ?? "sess-lifecycle",
    ownerUserId: "user-lifecycle",
    message: opts.message ?? "do the task",
    approvals: opts.approvals,
  };
  const outcome = await runLifecycle({
    env,
    deps,
    logger: new Logger(),
    runId,
    input,
    approvals: opts.approvals ?? [],
    history: [],
    provider: new ScriptedProvider(script),
    registry: createDefaultRegistry(),
    policy: new PolicyEngine(opts.policy ?? DEFAULT_POLICY),
    store,
    recorder,
    defaultToolTimeoutMs: 1000,
  });
  return { outcome, store, runId };
}

describe("Successful end-to-end run with a tool call", () => {
  it("executes a tool then finalizes", async () => {
    const { outcome } = await runWith([
      { action: "tool", tool: "calculator", arguments: { operation: "add", operands: [2, 3] } },
      { action: "final", content: "The sum is 5" },
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.outcome).toBe("The sum is 5");
    expect(outcome.toolCallCount).toBe(1);
  });
});

describe("Model failure (req 8)", () => {
  it("marks the run failed when the provider throws", async () => {
    const { outcome, store, runId } = await runWith(["__THROW__"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/Scripted model failure/);
    const run = await store.getRun(runId);
    expect(run?.status).toBe("failed");
  });
});

describe("Malformed model responses (req 12)", () => {
  it("rejects non-JSON model output", async () => {
    const { outcome } = await runWith(["this is not json"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/schema validation/i);
  });

  it("rejects JSON that violates the decision schema", async () => {
    const { outcome } = await runWith([{ action: "nonsense" }]);
    expect(outcome.status).toBe("failed");
  });

  it("fails when the model selects an unknown tool", async () => {
    const { outcome } = await runWith([
      { action: "tool", tool: "does_not_exist", arguments: {} },
    ]);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/Tool not found/);
  });
});

describe("Governance stops execution before the tool call", () => {
  it("denies a prohibited capability and never runs the tool", async () => {
    const denyPolicy: Policy = {
      ...DEFAULT_POLICY,
      prohibitedCapabilities: ["compute:arithmetic"],
    };
    const { outcome, store, runId } = await runWith(
      [{ action: "tool", tool: "calculator", arguments: { operation: "add", operands: [1, 1] } }],
      { policy: denyPolicy },
    );
    expect(outcome.status).toBe("denied");
    // No tool execution evidence should exist.
    const evidence = await store.listEvidence(runId);
    expect(evidence.some((e) => e.stage === "tool_execution")).toBe(false);
  });

  it("escalates a mutating tool that needs approval, without executing it", async () => {
    const { outcome, store, runId } = await runWith(
      [{ action: "tool", tool: "memory_write", arguments: { key: "k", value: "v" } }],
      { sessionId: "sess-escalate" },
    );
    expect(outcome.status).toBe("awaiting_approval");
    expect(outcome.pendingApproval).toBe("memory:write");
    const evidence = await store.listEvidence(runId);
    expect(evidence.some((e) => e.stage === "tool_execution")).toBe(false);
  });

  it("executes the mutating tool once approval is granted", async () => {
    const { outcome } = await runWith(
      [
        { action: "tool", tool: "memory_write", arguments: { key: "k", value: "v" } },
        { action: "final", content: "saved" },
      ],
      { approvals: ["memory:write"], sessionId: "sess-approved" },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.toolCallCount).toBe(1);
  });
});

describe("Replay / evidence reconstruction (req 10)", () => {
  it("reconstructs a run from evidence and validates invariants", async () => {
    const { store, runId } = await runWith([
      { action: "tool", tool: "calculator", arguments: { operation: "multiply", operands: [6, 7] } },
      { action: "final", content: "42" },
    ]);

    const report = await replayRun(store, runId);
    expect(report.consistent).toBe(true);
    expect(report.invariants.sequentialSeq).toBe(true);
    expect(report.invariants.everyToolExecutionHadPriorAllow).toBe(true);
    expect(report.invariants.toolExecutionCountMatchesRun).toBe(true);
    expect(report.invariants.terminalStagePresent).toBe(true);
    expect(report.toolExecutions).toHaveLength(1);
    expect(report.modelInvocations).toHaveLength(2);
    // Provider/model identity is captured for reproducibility.
    expect(report.modelInvocations[0].provider).toBe("scripted");
  });
});
