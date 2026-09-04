import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { authHeader } from "./helpers/jwt";

const FINAL_BODY = JSON.stringify({
  message: "hello",
  modelScript: [{ action: "final", content: "ok" }],
});

async function startRunAs(userId: string, sessionId = "shared") {
  const res = await SELF.fetch(`http://agent.test/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader(userId)) },
    body: FINAL_BODY,
  });
  const body = (await res.json()) as { run: { runId: string } };
  return body.run.runId;
}

describe("User/session isolation (req: user/session isolation)", () => {
  it("prevents a user from reading another user's run", async () => {
    const runId = await startRunAs("user-A");

    // Owner can read it.
    const ownerRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}`, {
      headers: await authHeader("user-A"),
    });
    expect(ownerRes.status).toBe(200);

    // A different user gets 404 (existence not leaked).
    const otherRes = await SELF.fetch(`http://agent.test/v1/runs/${runId}`, {
      headers: await authHeader("user-B"),
    });
    expect(otherRes.status).toBe(404);

    // ...and cannot read its evidence either.
    const otherEvidence = await SELF.fetch(`http://agent.test/v1/runs/${runId}/evidence`, {
      headers: await authHeader("user-B"),
    });
    expect(otherEvidence.status).toBe(404);
  });

  it("namespaces sessions per user so the same sessionId does not collide", async () => {
    // Both users use sessionId "shared" but get independent Durable Objects.
    await startRunAs("user-X", "shared");
    await startRunAs("user-X", "shared");
    await startRunAs("user-Y", "shared");

    const xSummary = await SELF.fetch("http://agent.test/v1/sessions/shared", {
      headers: await authHeader("user-X"),
    });
    const x = (await xSummary.json()) as { session: { runCount: number } };

    const ySummary = await SELF.fetch("http://agent.test/v1/sessions/shared", {
      headers: await authHeader("user-Y"),
    });
    const y = (await ySummary.json()) as { session: { runCount: number } };

    expect(x.session.runCount).toBe(2);
    expect(y.session.runCount).toBe(1);
  });
});
