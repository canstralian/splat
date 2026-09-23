import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { authHeader } from "./helpers/jwt";

const FINAL = [{ action: "final", content: "done" }];

function startInput(userId: string, sessionId: string, message: string, modelScript: unknown[]) {
  return { sessionId, ownerUserId: userId, message, modelScript };
}

describe("Agent initialization (req: agent initialization)", () => {
  it("starts with empty durable session state", async () => {
    const stub = await getAgentByName(env.ORCHESTRATOR, "user-init::sess-init");
    const summary = await stub.getSessionSummary();
    expect(summary.runCount).toBe(0);
    expect(summary.lastRunId).toBeNull();
  });
});

describe("State persistence across calls (req: state persistence)", () => {
  it("increments and persists runCount and transcript", async () => {
    const stub = await getAgentByName(env.ORCHESTRATOR, "user-p::sess-persist");
    await stub.startRun(startInput("user-p", "sess-persist", "one", FINAL));
    await stub.startRun(startInput("user-p", "sess-persist", "two", FINAL));

    const summary = await stub.getSessionSummary();
    expect(summary.runCount).toBe(2);
    expect(summary.lastStatus).toBe("completed");

    const history = await stub.getHistory();
    expect(history.length).toBe(4);
  });
});

describe("Concurrent state updates (req: concurrent state)", () => {
  it("serializes concurrent runs on the same session without lost updates", async () => {
    const stub = await getAgentByName(env.ORCHESTRATOR, "user-c::sess-concurrent");
    await Promise.all([
      stub.startRun(startInput("user-c", "sess-concurrent", "a", FINAL)),
      stub.startRun(startInput("user-c", "sess-concurrent", "b", FINAL)),
      stub.startRun(startInput("user-c", "sess-concurrent", "c", FINAL)),
    ]);
    const summary = await stub.getSessionSummary();
    expect(summary.runCount).toBe(3);
  });
});

describe("HTTP integration with Supabase auth", () => {
  it("serves health without auth", async () => {
    const res = await SELF.fetch("http://agent.test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("rejects unauthenticated message posts", async () => {
    const res = await SELF.fetch("http://agent.test/v1/sessions/s-int/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("runs a governed task end-to-end and exposes evidence + replay", async () => {
    const headers = { "content-type": "application/json", ...(await authHeader("user-e2e")) };
    const post = await SELF.fetch("http://agent.test/v1/sessions/s-int/messages", {
      method: "POST",
      headers,
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

    const auth = await authHeader("user-e2e");
    const runRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}`, { headers: auth });
    expect(runRes.status).toBe(200);

    const evRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}/evidence`, { headers: auth });
    const ev = (await evRes.json()) as { evidence: unknown[] };
    expect(ev.evidence.length).toBeGreaterThan(0);

    const replayRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}/replay`, { headers: auth });
    const replay = (await replayRes.json()) as { replay: { consistent: boolean } };
    expect(replay.replay.consistent).toBe(true);
  });

  it("rejects invalid request bodies with 400", async () => {
    const res = await SELF.fetch("http://agent.test/v1/sessions/s-int/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader("user-e2e")) },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });
});
