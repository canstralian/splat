import { describe, it, expect, vi } from "vitest";
import { runAgentTask, checkAgentHealth, AgentClientError } from "./agentClient";

const BASE = "https://agent.example.workers.dev";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runAgentTask", () => {
  it("posts to the session messages endpoint with the bearer token", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/v1/sessions/sess-1/messages`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token-abc");
      expect(init?.method).toBe("POST");
      return jsonResponse({ run: { runId: "r1", status: "completed", outcome: "hi", error: null, toolCallCount: 0 } });
    }) as unknown as typeof fetch;

    const run = await runAgentTask({
      baseUrl: BASE,
      accessToken: "token-abc",
      sessionId: "sess-1",
      message: "hello",
      fetchImpl,
    });

    expect(run.runId).toBe("r1");
    expect(run.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws AgentClientError on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthenticated" }, 401)) as unknown as typeof fetch;
    await expect(
      runAgentTask({ baseUrl: BASE, accessToken: "t", sessionId: "s", message: "m", fetchImpl }),
    ).rejects.toBeInstanceOf(AgentClientError);
  });

  it("validates required inputs", async () => {
    await expect(
      runAgentTask({ baseUrl: BASE, accessToken: "t", sessionId: "s", message: "  ", fetchImpl: fetch }),
    ).rejects.toThrow(/message is required/);
    await expect(
      runAgentTask({ baseUrl: BASE, accessToken: "", sessionId: "s", message: "m", fetchImpl: fetch }),
    ).rejects.toThrow(/accessToken is required/);
  });

  it("returns a non-completed run outcome (e.g. awaiting_approval) without throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ run: { runId: "r2", status: "awaiting_approval", outcome: null, error: null, toolCallCount: 0, pendingApproval: "memory:write" } }, 202),
    ) as unknown as typeof fetch;
    const run = await runAgentTask({ baseUrl: BASE, accessToken: "t", sessionId: "s", message: "m", fetchImpl });
    expect(run.status).toBe("awaiting_approval");
    expect(run.pendingApproval).toBe("memory:write");
  });
});

describe("checkAgentHealth", () => {
  it("returns true when the worker is healthy", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "ok" })) as unknown as typeof fetch;
    expect(await checkAgentHealth(BASE, fetchImpl)).toBe(true);
  });

  it("returns false on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await checkAgentHealth(BASE, fetchImpl)).toBe(false);
  });
});
