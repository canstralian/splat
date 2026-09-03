import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApiError, fetchAgentSession, sendAgentMessage } from "./client";

const getSessionMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_AGENT_URL", "https://agent.test");
  vi.stubGlobal("fetch", fetchMock);
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: "session-jwt" } },
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sendAgentMessage", () => {
  it("sends the session JWT and validates the response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        executionId: "exec-1",
        reply: "Found 2 bugs",
        intent: "read_query",
        toolCalls: [{ name: "search_bugs", access: "read", status: "ok", durationMs: 12 }],
        modelId: "test-model",
        durationMs: 400,
      }),
    );

    const result = await sendAgentMessage("session-1", "show bugs", false);

    expect(result.reply).toBe("Found 2 bugs");
    expect(result.toolCalls[0].name).toBe("search_bugs");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.test/api/agent/sessions/session-1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-jwt");
    expect(JSON.parse(init.body as string)).toEqual({ message: "show bugs", allowWrites: false });
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    await expect(sendAgentMessage("s", "hi", false)).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the worker error envelope with its code", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "rate_limited", message: "Too many requests — please slow down" } }, 429),
    );
    await expect(sendAgentMessage("s", "hi", false)).rejects.toMatchObject({
      code: "rate_limited",
      message: "Too many requests — please slow down",
    });
  });

  it("rejects malformed responses instead of passing them to the UI", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reply: 42 }));
    await expect(sendAgentMessage("s", "hi", false)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("fails cleanly when the assistant is not configured", async () => {
    vi.stubEnv("VITE_AGENT_URL", "");
    await expect(sendAgentMessage("s", "hi", false)).rejects.toBeInstanceOf(AgentApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps network failures to a network_error code", async () => {
    fetchMock.mockRejectedValue(new TypeError("failed to fetch"));
    await expect(sendAgentMessage("s", "hi", false)).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("fetchAgentSession", () => {
  it("returns validated session state", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        messages: [{ role: "user", content: "hi", createdAt: 1 }],
        executionCount: 1,
      }),
    );
    const state = await fetchAgentSession("session-1");
    expect(state.messages).toHaveLength(1);
    expect(state.executionCount).toBe(1);
  });
});
