import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { RunStore } from "../src/state/run-store";
import { StaleWriteError } from "../src/errors";
import type { RunRecord } from "../src/types";

function newRun(id: string): RunRecord {
  const now = Date.now();
  return {
    id,
    sessionId: "sess-state",
    agentId: "a",
    agentVersion: "1",
    status: "running",
    input: "hi",
    intent: null,
    outcome: null,
    error: null,
    toolCallCount: 0,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("Run persistence and optimistic concurrency (req 3, stale writes)", () => {
  it("persists and reloads a run", async () => {
    const store = new RunStore(env.DB);
    const id = `run-persist-${crypto.randomUUID()}`;
    await store.createRun(newRun(id));
    const loaded = await store.getRun(id);
    expect(loaded?.id).toBe(id);
    expect(loaded?.status).toBe("running");
    expect(loaded?.version).toBe(0);
  });

  it("increments version on compare-and-set update", async () => {
    const store = new RunStore(env.DB);
    const id = `run-cas-${crypto.randomUUID()}`;
    await store.createRun(newRun(id));
    const v1 = await store.updateRun(id, 0, { status: "completed" }, Date.now());
    expect(v1).toBe(1);
    const reloaded = await store.getRun(id);
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.status).toBe("completed");
  });

  it("detects a stale write (version mismatch)", async () => {
    const store = new RunStore(env.DB);
    const id = `run-stale-${crypto.randomUUID()}`;
    await store.createRun(newRun(id));

    // First writer wins, advancing version 0 -> 1.
    await store.updateRun(id, 0, { toolCallCount: 1 }, Date.now());

    // Second writer still believes version is 0 -> rejected.
    await expect(
      store.updateRun(id, 0, { toolCallCount: 2 }, Date.now()),
    ).rejects.toBeInstanceOf(StaleWriteError);
  });

  it("appends and lists evidence in sequence order", async () => {
    const store = new RunStore(env.DB);
    const id = `run-ev-${crypto.randomUUID()}`;
    await store.createRun(newRun(id));
    for (let seq = 0; seq < 3; seq++) {
      await store.appendEvidence({
        id: `${id}-e${seq}`,
        runId: id,
        seq,
        stage: "input",
        verification: "VERIFIED",
        summary: `event ${seq}`,
        detail: { seq },
        artifactKey: null,
        createdAt: Date.now(),
      });
    }
    const evidence = await store.listEvidence(id);
    expect(evidence.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});
