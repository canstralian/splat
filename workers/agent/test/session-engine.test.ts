import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentError } from "../src/errors";
import { SessionEngine } from "../src/agent/session-core";
import type { ModelResult } from "../src/agent/model";
import { DEFAULT_LIMITS } from "../src/constants";
import { SupabaseRestClient } from "../src/supabase/rest";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { MemorySessionStore, ScriptedModel, silentLog, testIdentity } from "./helpers";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes input",
  access: "read",
  permission: "authenticated",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  timeoutMs: 1000,
  execute: async (input) => ({ echoed: (input as { value: string }).value }),
} as ToolDefinition;

function makeEngine(
  script: Array<ModelResult | AgentError>,
  overrides: Partial<typeof DEFAULT_LIMITS> = {},
) {
  const store = new MemorySessionStore();
  const model = new ScriptedModel(script);
  let idCounter = 0;
  const engine = new SessionEngine({
    store,
    model,
    registry: new ToolRegistry([echoTool]),
    supabaseFactory: (accessToken) =>
      new SupabaseRestClient({
        url: "https://supabase.test",
        publishableKey: "anon",
        accessToken,
        fetchFn: (async () => new Response("[]", { status: 200 })) as typeof fetch,
      }),
    limits: { ...DEFAULT_LIMITS, ...overrides },
    now: () => Date.now(),
    log: silentLog,
    generateId: () => `exec-${++idCounter}`,
  });
  return { engine, store, model };
}

const turnInput = (message: string, overrides: Partial<Parameters<SessionEngine["runTurn"]>[0]> = {}) => ({
  identity: testIdentity,
  accessToken: "user-jwt",
  message,
  allowWrites: false,
  ...overrides,
});

describe("SessionEngine.runTurn", () => {
  it("completes a turn, persists the conversation and records the execution", async () => {
    const { engine, store } = makeEngine([{ kind: "text", text: "Hello back" }]);
    const out = await engine.runTurn(turnInput("Hello"));

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.reply).toBe("Hello back");
      expect(out.executionId).toBe("exec-1");
      expect(out.intent).toBe("general_chat");
    }

    const messages = store.listMessages(10);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hello back"],
    ]);
    const executions = store.listExecutions(10);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ id: "exec-1", status: "completed", modelId: "scripted-model" });
  });

  it("records failed executions but keeps the conversation clean for retry", async () => {
    const { engine, store } = makeEngine([new AgentError("model_error", "Model call failed")]);
    const out = await engine.runTurn(turnInput("Hello"));

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("model_error");
      expect(out.error.status).toBe(502);
      expect(out.error.executionId).toBe("exec-1");
    }
    expect(store.countMessages()).toBe(0);
    expect(store.listExecutions(10)[0]).toMatchObject({ status: "failed", errorCode: "model_error" });
  });

  it("rejects policy violations without recording an execution", async () => {
    const { engine, store } = makeEngine([]);
    const out = await engine.runTurn(turnInput("   "));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("invalid_request");
    expect(store.countExecutions()).toBe(0);
  });

  it("rate limits once the window is exhausted", async () => {
    const script = Array.from({ length: 5 }, (): ModelResult => ({ kind: "text", text: "ok" }));
    const { engine } = makeEngine(script, { rateLimitMaxTurns: 2 });

    expect((await engine.runTurn(turnInput("one"))).ok).toBe(true);
    expect((await engine.runTurn(turnInput("two"))).ok).toBe(true);
    const third = await engine.runTurn(turnInput("three"));
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.code).toBe("rate_limited");
      expect(third.error.status).toBe(429);
    }
    // Rejected turns are not recorded, so the window does not extend itself.
    const fourth = await engine.runTurn(turnInput("four"));
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.error.code).toBe("rate_limited");
  });

  it("prunes stored messages beyond the retention cap", async () => {
    const script = Array.from({ length: 4 }, (): ModelResult => ({ kind: "text", text: "ok" }));
    const { engine, store } = makeEngine(script, { maxStoredMessages: 4 });
    await engine.runTurn(turnInput("one"));
    await engine.runTurn(turnInput("two"));
    await engine.runTurn(turnInput("three"));
    expect(store.countMessages()).toBe(4);
    expect(store.listMessages(10)[0].content).toBe("two");
  });

  it("isolates sessions per user even if another user reaches the same instance", async () => {
    const { engine } = makeEngine([{ kind: "text", text: "hi" }, { kind: "text", text: "hi" }]);
    await engine.runTurn(turnInput("bind me"));

    const intruder = await engine.runTurn(
      turnInput("steal the session", { identity: { userId: "user-2", email: null } }),
    );
    expect(intruder.ok).toBe(false);
    if (!intruder.ok) {
      expect(intruder.error.code).toBe("forbidden");
      expect(intruder.error.status).toBe(403);
    }

    const stateForIntruder = engine.getState("user-2");
    expect(stateForIntruder.ok).toBe(false);
    const resetForIntruder = engine.reset("user-2");
    expect(resetForIntruder.ok).toBe(false);
  });
});

describe("SessionEngine state accessors", () => {
  it("returns conversation state and execution history to the owner", async () => {
    const { engine } = makeEngine([{ kind: "text", text: "reply" }]);
    await engine.runTurn(turnInput("hello"));

    const state = engine.getState(testIdentity.userId);
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.messages).toHaveLength(2);
      expect(state.executionCount).toBe(1);
    }

    const executions = engine.getExecutions(testIdentity.userId);
    expect(executions.ok).toBe(true);
    if (executions.ok) expect(executions.executions[0].status).toBe("completed");
  });

  it("reset clears conversation and history", async () => {
    const { engine, store } = makeEngine([{ kind: "text", text: "reply" }]);
    await engine.runTurn(turnInput("hello"));
    expect(engine.reset(testIdentity.userId)).toEqual({ ok: true });
    expect(store.countMessages()).toBe(0);
    expect(store.countExecutions()).toBe(0);
  });
});
