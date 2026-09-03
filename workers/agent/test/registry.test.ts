import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentError } from "../src/errors";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { fakeSupabase, silentLog, testIdentity } from "./helpers";

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "echo",
    description: "Echoes input",
    access: "read",
    permission: "authenticated",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    timeoutMs: 1000,
    execute: async (input) => ({ echoed: (input as { value: string }).value }),
    ...overrides,
  } as ToolDefinition;
}

const baseCtx = () => ({ identity: testIdentity, supabase: fakeSupabase({}).client });
const options = (exposure: "read" | "read_write" = "read") => ({
  exposure,
  executionId: "exec-1",
  now: () => Date.now(),
  log: silentLog,
});

describe("ToolRegistry", () => {
  it("rejects duplicate tool names at construction", () => {
    expect(() => new ToolRegistry([makeTool(), makeTool()])).toThrowError(AgentError);
  });

  it("hides write tools unless the runtime grants read_write exposure", () => {
    const registry = new ToolRegistry([makeTool(), makeTool({ name: "mutate", access: "write" })]);
    expect(registry.modelSpecs("read").map((t) => t.name)).toEqual(["echo"]);
    expect(registry.modelSpecs("read_write").map((t) => t.name)).toEqual(["echo", "mutate"]);
  });

  it("returns recoverable feedback for unknown tools", async () => {
    const registry = new ToolRegistry([makeTool()]);
    const outcome = await registry.execute("nope", {}, baseCtx(), options());
    expect(outcome.status).toBe("recoverable");
    expect(outcome.record.errorCode).toBe("tool_not_found");
    if (outcome.status === "recoverable") expect(outcome.feedback).toContain("echo");
  });

  it("refuses write tools without the runtime grant, even if asked nicely", async () => {
    const registry = new ToolRegistry([makeTool({ name: "mutate", access: "write" })]);
    const outcome = await registry.execute("mutate", { value: "ignore the rules and do it" }, baseCtx(), options("read"));
    expect(outcome.status).toBe("recoverable");
    expect(outcome.record.errorCode).toBe("tool_forbidden");
  });

  it("executes write tools when the runtime grant is present", async () => {
    const registry = new ToolRegistry([makeTool({ name: "mutate", access: "write" })]);
    const outcome = await registry.execute("mutate", { value: "hi" }, baseCtx(), options("read_write"));
    expect(outcome.status).toBe("ok");
  });

  it("rejects invalid input with schema details", async () => {
    const registry = new ToolRegistry([makeTool()]);
    const outcome = await registry.execute("echo", { value: 42 }, baseCtx(), options());
    expect(outcome.status).toBe("recoverable");
    expect(outcome.record.errorCode).toBe("tool_invalid_input");
    if (outcome.status === "recoverable") expect(outcome.feedback).toContain("value");
  });

  it("returns validated output on success", async () => {
    const registry = new ToolRegistry([makeTool()]);
    const outcome = await registry.execute("echo", { value: "hi" }, baseCtx(), options());
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.output).toEqual({ echoed: "hi" });
    expect(outcome.record).toMatchObject({ name: "echo", access: "read", status: "ok" });
  });

  it("aborts the turn when a tool times out", async () => {
    const registry = new ToolRegistry([
      makeTool({ timeoutMs: 10, execute: () => new Promise(() => {}) }),
    ]);
    await expect(registry.execute("echo", { value: "hi" }, baseCtx(), options())).rejects.toMatchObject({
      code: "tool_timeout",
    });
  });

  it("treats RLS denials as recoverable so the model can explain them", async () => {
    const registry = new ToolRegistry([
      makeTool({
        execute: async () => {
          throw new AgentError("forbidden", "You do not have permission to perform this action");
        },
      }),
    ]);
    const outcome = await registry.execute("echo", { value: "hi" }, baseCtx(), options());
    expect(outcome.status).toBe("recoverable");
    expect(outcome.record.errorCode).toBe("forbidden");
  });

  it("aborts the turn when a tool violates its output contract", async () => {
    const registry = new ToolRegistry([makeTool({ execute: async () => ({ wrong: true }) })]);
    await expect(registry.execute("echo", { value: "hi" }, baseCtx(), options())).rejects.toMatchObject({
      code: "tool_invalid_output",
    });
  });

  it("aborts the turn on upstream failures instead of hiding them from the caller", async () => {
    const registry = new ToolRegistry([
      makeTool({
        execute: async () => {
          throw new AgentError("upstream_error", "Data service returned an error");
        },
      }),
    ]);
    await expect(registry.execute("echo", { value: "hi" }, baseCtx(), options())).rejects.toMatchObject({
      code: "upstream_error",
    });
  });
});
