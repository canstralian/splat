import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agent/session";
import type { AgentSessionStub, TurnInput } from "../src/agent/types";
import { AgentError } from "../src/errors";
import { handleAgentRequest, type RouterDeps } from "../src/router";
import { silentLog } from "./helpers";

interface FakeNamespace {
  namespace: DurableObjectNamespace<AgentSession>;
  names: string[];
  turnInputs: TurnInput[];
}

function fakeNamespace(stubOverrides: Partial<AgentSessionStub> = {}): FakeNamespace {
  const names: string[] = [];
  const turnInputs: TurnInput[] = [];
  const stub: AgentSessionStub = {
    async runTurn(input) {
      turnInputs.push(input);
      return {
        ok: true,
        executionId: "exec-1",
        reply: "hi",
        intent: "general_chat",
        toolCalls: [],
        modelId: "m",
        durationMs: 5,
      };
    },
    async getState() {
      return { ok: true, messages: [], executionCount: 0 };
    },
    async getExecutions() {
      return { ok: true, executions: [] };
    },
    async reset() {
      return { ok: true };
    },
    ...stubOverrides,
  };
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return stub;
    },
  } as DurableObjectNamespace<AgentSession>;
  return { namespace, names, turnInputs };
}

function makeEnv(overrides: Partial<Env> = {}, ns: FakeNamespace = fakeNamespace()): Env {
  return {
    AI: {} as Ai,
    AGENT_SESSION: ns.namespace,
    AGENT_VERSION: "test",
    MODEL_ID: "test-model",
    MODEL_PROVIDER: "stub",
    AI_GATEWAY_ID: "",
    MODEL_TIMEOUT_MS: "",
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_PUBLISHABLE_KEY: "anon-key",
    ALLOWED_ORIGINS: "http://localhost:8080",
    ...overrides,
  };
}

function authAs(userId: string): RouterDeps {
  return {
    authenticate: async (request) => {
      const header = request.headers.get("Authorization");
      if (!header) throw new AgentError("unauthorized", "Missing or malformed Authorization header");
      return { identity: { userId, email: null }, accessToken: header.replace(/^Bearer /, "") };
    },
    log: silentLog,
  };
}

const post = (path: string, body: unknown, origin?: string) =>
  new Request(`https://agent.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer jwt-1",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });

describe("handleAgentRequest", () => {
  it("serves health without authentication", async () => {
    const response = await handleAgentRequest(new Request("https://agent.test/api/agent/health"), makeEnv(), {
      log: silentLog,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, model: "test-model" });
  });

  it("answers preflight for allowed origins and withholds CORS for others", async () => {
    const preflight = (origin: string) =>
      new Request("https://agent.test/api/agent/sessions/s1/messages", {
        method: "OPTIONS",
        headers: { Origin: origin },
      });

    const allowed = await handleAgentRequest(preflight("http://localhost:8080"), makeEnv(), { log: silentLog });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8080");

    const denied = await handleAgentRequest(preflight("https://evil.example"), makeEnv(), { log: silentLog });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("fails fast with config_error when required vars are missing", async () => {
    const response = await handleAgentRequest(
      post("/api/agent/sessions/s1/messages", { message: "hi" }),
      makeEnv({ SUPABASE_PUBLISHABLE_KEY: "" }),
      authAs("user-1"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "config_error" } });
  });

  it("rejects unauthenticated session requests", async () => {
    const request = new Request("https://agent.test/api/agent/sessions/s1", { method: "GET" });
    const response = await handleAgentRequest(request, makeEnv(), authAs("user-1"));
    expect(response.status).toBe(401);
  });

  it("rejects malformed session ids", async () => {
    const response = await handleAgentRequest(
      post("/api/agent/sessions/bad%20id!/messages", { message: "hi" }),
      makeEnv(),
      authAs("user-1"),
    );
    expect(response.status).toBe(400);
  });

  it("routes a message to the DO named by the verified user id", async () => {
    const ns = fakeNamespace();
    const response = await handleAgentRequest(
      post("/api/agent/sessions/session-a/messages", { message: "hi", allowWrites: true }),
      makeEnv({}, ns),
      authAs("user-1"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ executionId: "exec-1", reply: "hi" });
    expect(ns.names).toEqual(["user-1:session-a"]);
    expect(ns.turnInputs[0]).toMatchObject({
      identity: { userId: "user-1" },
      accessToken: "jwt-1",
      message: "hi",
      allowWrites: true,
    });
  });

  it("gives different users different DOs for the same session id (isolation by construction)", async () => {
    const ns = fakeNamespace();
    await handleAgentRequest(post("/api/agent/sessions/shared/messages", { message: "a" }), makeEnv({}, ns), authAs("user-a"));
    await handleAgentRequest(post("/api/agent/sessions/shared/messages", { message: "b" }), makeEnv({}, ns), authAs("user-b"));
    expect(ns.names).toEqual(["user-a:shared", "user-b:shared"]);
  });

  it("rejects non-JSON bodies", async () => {
    const request = new Request("https://agent.test/api/agent/sessions/s1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer jwt-1" },
      body: "not json",
    });
    const response = await handleAgentRequest(request, makeEnv(), authAs("user-1"));
    expect(response.status).toBe(400);
  });

  it("rejects oversized JSON bodies before parsing", async () => {
    const request = new Request("https://agent.test/api/agent/sessions/s1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer jwt-1",
        "Content-Type": "application/json",
        "Content-Length": "20000",
      },
      body: "{}",
    });
    const response = await handleAgentRequest(request, makeEnv(), authAs("user-1"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("rejects bodies that fail schema validation", async () => {
    const response = await handleAgentRequest(
      post("/api/agent/sessions/s1/messages", { message: 42 }),
      makeEnv(),
      authAs("user-1"),
    );
    expect(response.status).toBe(400);
  });

  it("maps DO error envelopes onto HTTP statuses", async () => {
    const ns = fakeNamespace({
      runTurn: async () => ({
        ok: false,
        error: { code: "rate_limited", message: "Too many requests — please slow down", status: 429 },
      }),
    });
    const response = await handleAgentRequest(
      post("/api/agent/sessions/s1/messages", { message: "hi" }),
      makeEnv({}, ns),
      authAs("user-1"),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("returns 404 for unknown paths and 405 for wrong methods", async () => {
    const notFound = await handleAgentRequest(new Request("https://agent.test/api/other"), makeEnv(), authAs("u"));
    expect(notFound.status).toBe(404);

    const wrongMethod = await handleAgentRequest(
      new Request("https://agent.test/api/agent/sessions/s1/executions", {
        method: "POST",
        headers: { Authorization: "Bearer jwt-1" },
        body: "{}",
      }),
      makeEnv(),
      authAs("user-1"),
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("supports GET state, GET executions and DELETE reset", async () => {
    const env = makeEnv();
    const headers = { Authorization: "Bearer jwt-1" };
    const state = await handleAgentRequest(
      new Request("https://agent.test/api/agent/sessions/s1", { headers }),
      env,
      authAs("user-1"),
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ messages: [], executionCount: 0 });

    const executions = await handleAgentRequest(
      new Request("https://agent.test/api/agent/sessions/s1/executions", { headers }),
      env,
      authAs("user-1"),
    );
    expect(executions.status).toBe(200);

    const reset = await handleAgentRequest(
      new Request("https://agent.test/api/agent/sessions/s1", { method: "DELETE", headers }),
      env,
      authAs("user-1"),
    );
    expect(reset.status).toBe(200);
  });
});
