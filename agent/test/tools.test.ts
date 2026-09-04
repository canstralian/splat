import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { z } from "zod";
import {
  calculatorTool,
  echoTool,
  memoryReadTool,
  memoryWriteTool,
} from "../src/tools/builtins";
import { invokeTool, type Tool } from "../src/tools/types";
import {
  ToolExecutionError,
  ToolTimeoutError,
  ToolValidationError,
} from "../src/errors";
import { Logger } from "../src/observability/logger";

function baseCtx(overrides: Partial<{ sessionId: string; idempotencyKey: string }> = {}) {
  return {
    runId: "run-test",
    sessionId: overrides.sessionId ?? "sess-tools",
    env,
    logger: new Logger(),
    now: () => Date.now(),
    idempotencyKey: overrides.idempotencyKey ?? "idem-1",
  };
}

describe("Tool schema validation (req 4)", () => {
  it("rejects arguments that violate the input schema", async () => {
    await expect(
      // missing `operands`
      invokeTool(calculatorTool as Tool, { operation: "add" }, baseCtx(), 1000),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("rejects an unknown operation", async () => {
    await expect(
      invokeTool(
        calculatorTool as Tool,
        { operation: "modulo", operands: [1, 2] },
        baseCtx(),
        1000,
      ),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("accepts valid arguments", async () => {
    const res = await invokeTool(
      calculatorTool as Tool,
      { operation: "add", operands: [2, 3, 5] },
      baseCtx(),
      1000,
    );
    expect(res.output).toEqual({ result: 10 });
  });
});

describe("Successful tool execution (req 6)", () => {
  it("executes echo and validates output", async () => {
    const res = await invokeTool(
      echoTool as Tool,
      { text: "hello" },
      baseCtx(),
      1000,
    );
    expect(res.output).toEqual({ echoed: "hello" });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("mutating memory_write then memory_read round-trips, and is idempotent", async () => {
    const w1 = await invokeTool(
      memoryWriteTool as Tool,
      { key: "color", value: "magenta" },
      baseCtx({ sessionId: "sess-mem", idempotencyKey: "w-1" }),
      1000,
    );
    expect(w1.output).toMatchObject({ applied: true });

    // Same idempotency key -> not re-applied.
    const w2 = await invokeTool(
      memoryWriteTool as Tool,
      { key: "color", value: "magenta" },
      baseCtx({ sessionId: "sess-mem", idempotencyKey: "w-1" }),
      1000,
    );
    expect(w2.output).toMatchObject({ applied: false });

    const r = await invokeTool(
      memoryReadTool as Tool,
      { key: "color" },
      baseCtx({ sessionId: "sess-mem" }),
      1000,
    );
    expect(r.output).toEqual({ key: "color", value: "magenta" });
  });
});

describe("Tool failure (req 7)", () => {
  it("surfaces a ToolExecutionError on division by zero", async () => {
    await expect(
      invokeTool(
        calculatorTool as Tool,
        { operation: "divide", operands: [1, 0] },
        baseCtx(),
        1000,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("Timeout handling (req 9)", () => {
  const slowTool: Tool<{ ms: number }, { done: boolean }> = {
    name: "slow",
    description: "sleeps",
    inputSchema: z.object({ ms: z.number() }),
    outputSchema: z.object({ done: z.boolean() }),
    requiredCapability: "util:echo",
    effect: "read_only",
    failureBehavior: "fail_run",
    evidenceDescription: "n/a",
    async execute(input) {
      await new Promise((r) => setTimeout(r, input.ms));
      return { done: true };
    },
  };

  it("aborts a tool that exceeds its timeout budget", async () => {
    await expect(
      invokeTool(slowTool as Tool, { ms: 5000 }, baseCtx(), 50),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("completes when under the timeout budget", async () => {
    const res = await invokeTool(slowTool as Tool, { ms: 1 }, baseCtx(), 1000);
    expect(res.output).toEqual({ done: true });
  });
});
