import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentTurn, type TurnContext } from "../src/agent/pipeline";
import { DEFAULT_LIMITS } from "../src/constants";
import { AgentError } from "../src/errors";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { fakeSupabase, ScriptedModel, silentLog, testIdentity } from "./helpers";

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

const writeTool: ToolDefinition = {
  ...echoTool,
  name: "mutate",
  access: "write",
} as ToolDefinition;

function makeDeps(model: ScriptedModel, limits = DEFAULT_LIMITS) {
  return {
    model,
    registry: new ToolRegistry([echoTool, writeTool]),
    toolContext: { identity: testIdentity, supabase: fakeSupabase({}).client },
    limits,
    now: () => Date.now(),
    log: silentLog,
  };
}

function makeTurn(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    executionId: "exec-1",
    message: "hello",
    intent: "general_chat",
    exposure: "read",
    history: [],
    allowWrites: false,
    ...overrides,
  };
}

describe("runAgentTurn", () => {
  it("returns a plain text reply without tool calls", async () => {
    const model = new ScriptedModel([{ kind: "text", text: "Hi there" }]);
    const result = await runAgentTurn(makeTurn(), makeDeps(model));
    expect(result).toEqual({ reply: "Hi there", toolCalls: [] });
  });

  it("executes a tool call and feeds the result back to the model", async () => {
    const model = new ScriptedModel([
      { kind: "tool_calls", calls: [{ name: "echo", arguments: { value: "ping" } }] },
      { kind: "text", text: "The echo said ping" },
    ]);
    const result = await runAgentTurn(makeTurn(), makeDeps(model));

    expect(result.reply).toBe("The echo said ping");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "echo", status: "ok" });

    const secondTranscript = model.transcripts[1];
    const toolMessage = secondTranscript.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe(JSON.stringify({ echoed: "ping" }));
  });

  it("only advertises read tools when writes are not granted", async () => {
    const model = new ScriptedModel([{ kind: "text", text: "ok" }]);
    await runAgentTurn(makeTurn({ exposure: "read" }), makeDeps(model));
    expect(model.toolSpecs[0].map((t) => t.name)).toEqual(["echo"]);
  });

  it("feeds forbidden write attempts back so the model can explain, and records the denial", async () => {
    const model = new ScriptedModel([
      { kind: "tool_calls", calls: [{ name: "mutate", arguments: { value: "x" } }] },
      { kind: "text", text: "I cannot make changes in read-only mode." },
    ]);
    const result = await runAgentTurn(makeTurn({ exposure: "read" }), makeDeps(model));

    expect(result.toolCalls[0]).toMatchObject({ name: "mutate", status: "error", errorCode: "tool_forbidden" });
    expect(result.reply).toContain("read-only");
  });

  it("aborts with model_malformed after repeated invalid tool calls", async () => {
    const bad = { kind: "tool_calls" as const, calls: [{ name: "does_not_exist", arguments: {} }] };
    const model = new ScriptedModel([bad, bad, bad, bad]);
    const limits = { ...DEFAULT_LIMITS, maxModelRecoveries: 2 };

    let caught: AgentError | null = null;
    try {
      await runAgentTurn(makeTurn(), makeDeps(model, limits));
    } catch (e) {
      caught = e as AgentError;
    }
    expect(caught?.code).toBe("model_malformed");
    // Partial execution is preserved for the execution record.
    expect((caught?.details.toolCalls as unknown[]).length).toBe(3);
  });

  it("propagates model failures with the partial tool trace attached", async () => {
    const model = new ScriptedModel([
      { kind: "tool_calls", calls: [{ name: "echo", arguments: { value: "ping" } }] },
      new AgentError("model_error", "Model call failed"),
    ]);
    let caught: AgentError | null = null;
    try {
      await runAgentTurn(makeTurn(), makeDeps(model));
    } catch (e) {
      caught = e as AgentError;
    }
    expect(caught?.code).toBe("model_error");
    expect((caught?.details.toolCalls as unknown[]).length).toBe(1);
  });

  it("rejects empty model replies as malformed", async () => {
    const model = new ScriptedModel([{ kind: "text", text: "   " }]);
    await expect(runAgentTurn(makeTurn(), makeDeps(model))).rejects.toMatchObject({ code: "model_malformed" });
  });

  it("stops after the tool-iteration limit", async () => {
    const call = { kind: "tool_calls" as const, calls: [{ name: "echo", arguments: { value: "x" } }] };
    const model = new ScriptedModel(Array(10).fill(call));
    const limits = { ...DEFAULT_LIMITS, maxToolIterations: 2 };
    await expect(runAgentTurn(makeTurn(), makeDeps(model, limits))).rejects.toMatchObject({ code: "model_error" });
  });

  it("truncates history to the configured context window", async () => {
    const model = new ScriptedModel([{ kind: "text", text: "ok" }]);
    const limits = { ...DEFAULT_LIMITS, historyContextMessages: 2 };
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
      createdAt: i,
    }));
    await runAgentTurn(makeTurn({ history }), makeDeps(model, limits));

    const transcript = model.transcripts[0];
    const nonSystem = transcript.filter((m) => m.role !== "system");
    // 2 history messages + the current user message
    expect(nonSystem.map((m) => m.content)).toEqual(["m4", "m5", "hello"]);
  });

  it("caps oversized replies", async () => {
    const limits = { ...DEFAULT_LIMITS, maxReplyChars: 10 };
    const model = new ScriptedModel([{ kind: "text", text: "x".repeat(100) }]);
    const result = await runAgentTurn(makeTurn(), makeDeps(model, limits));
    expect(result.reply).toHaveLength(10);
  });
});
