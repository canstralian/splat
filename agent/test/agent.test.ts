import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";

const FINAL = [{ action: "final", content: "done" }];
const AUTH = { authorization: "Bearer test-token" };

describe("Agent initialization (req 1)", () => {
  it("starts with empty durable session state", async () => {
    const stub = await getAgentByName(env.ORCHESTRATOR, "sess-init");
    const summary = await stub.getSessionSummary();
    expect(summary.runCount).toBe(0);
    expect(summary.lastRunId).toBeNull();
  });
});

describe("State persistence across calls (req 2)", () => {
  it("increments and persists runCount and transcript", async () => {
    const stub = await getAgentByName(env.ORCHESTRATOR, "sess-persist");
    await stub.startRun({ sessionId: "sess-persist", message: "one", modelScript: FINAL });
    await stub.startRun({ sessionId: "sess-persist", message: "two", modelScript: FINAL });

    const summary = await stub.getSessionSummary();
    expect(summary.runCount).toBe(2);
    expect(summary.lastStatus).toBe("completed");

    const history = await stub.getHistory();
    // 2 runs x (user + assistant) = 4 messages.
    expect(history.length).toBe(4);
  });
});

describe("Concurrent state updates (req 3)", () => {
  it("serializes concurrent runs on the same session without lost updates", async () => {
    const stub = await getAgentByName(env.ORCHESTRATOR, "sess-concurrent");
    await Promise.all([
      stub.startRun({ sessionId: "sess-concurrent", message: "a", modelScript: FINAL }),
      stub.startRun({ sessionId: "sess-concurrent", message: "b", modelScript: FINAL }),
      stub.startRun({ sessionId: "sess-concurrent", message: "c", modelScript: FINAL }),
    ]);
    const summary = await stub.getSessionSummary();
    expect(summary.runCount).toBe(3);
  });
});

describe("HTTP integration (auth, run, evidence, replay)", () => {
  it("serves health without auth", async () => {
    const res = await SELF.fetch("http://agent.test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("rejects unauthenticated message posts (req: security)", async () => {
    const res = await SELF.fetch("http://agent.test/v1/sessions/s-int/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("runs a governed task end-to-end over HTTP and exposes evidence + replay", async () => {
    const post = await SELF.fetch("http://agent.test/v1/sessions/s-int/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({
        message: "add 2 and 3",
        modelScript: [
          { action: "tool", tool: "calculator", arguments: { operation: "add", operands: [2, 3] } },
          { action: "final", content: "5" },
        ],
      }),
    });
    expect(post.status).toBe(200);
    const posted = (await post.json()) as { run: { runId: string; status: string; toolCallCount: number } };
    expect(posted.run.status).toBe("completed");
    expect(posted.run.toolCallCount).toBe(1);
    const runId = posted.run.runId;

    const runRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}`, { headers: AUTH });
    expect(runRes.status).toBe(200);

    const evRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}/evidence`, { headers: AUTH });
    const ev = (await evRes.json()) as { evidence: unknown[] };
    expect(ev.evidence.length).toBeGreaterThan(0);

    const replayRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}/replay`, { headers: AUTH });
    const replay = (await replayRes.json()) as { replay: { consistent: boolean } };
    expect(replay.replay.consistent).toBe(true);
  });

  it("rejects invalid request bodies with 400", async () => {
    const res = await SELF.fetch("http://agent.test/v1/sessions/s-int/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });
});
