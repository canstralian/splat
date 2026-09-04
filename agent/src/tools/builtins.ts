import { z } from "zod";
import { CAPABILITIES } from "../governance/capabilities";
import { ToolExecutionError } from "../errors";
import { ToolRegistry } from "./registry";
import { splatBugSearchTool } from "./splat-bugs";
import type { Tool, ToolContext } from "./types";

/** echo — the simplest read-only tool; useful for connectivity and tests. */
export const echoTool: Tool<{ text: string }, { echoed: string }> = {
  name: "echo",
  description: "Return the provided text unchanged.",
  inputSchema: z.object({ text: z.string().max(4000) }),
  outputSchema: z.object({ echoed: z.string() }),
  requiredCapability: CAPABILITIES.UTIL_ECHO,
  effect: "read_only",
  failureBehavior: "report_and_continue",
  evidenceDescription: "Records the echoed text.",
  async execute(input) {
    return { echoed: input.text };
  },
};

/** calculator — deterministic arithmetic with no code evaluation. */
export const calculatorTool: Tool<
  { operation: "add" | "subtract" | "multiply" | "divide"; operands: number[] },
  { result: number }
> = {
  name: "calculator",
  description:
    "Perform deterministic arithmetic (add, subtract, multiply, divide) over a list of numbers.",
  inputSchema: z.object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    operands: z.array(z.number()).min(1).max(64),
  }),
  outputSchema: z.object({ result: z.number() }),
  requiredCapability: CAPABILITIES.COMPUTE_ARITHMETIC,
  effect: "read_only",
  failureBehavior: "fail_run",
  evidenceDescription: "Records the operation, operands and computed result.",
  async execute(input) {
    const [head, ...rest] = input.operands;
    let acc = head;
    for (const n of rest) {
      switch (input.operation) {
        case "add":
          acc += n;
          break;
        case "subtract":
          acc -= n;
          break;
        case "multiply":
          acc *= n;
          break;
        case "divide":
          if (n === 0) {
            throw new ToolExecutionError("calculator", "division by zero");
          }
          acc /= n;
          break;
      }
    }
    return { result: acc };
  },
};

/** config_read — read a value from the KV configuration namespace. */
export const configReadTool: Tool<
  { key: string },
  { key: string; value: string | null }
> = {
  name: "config_read",
  description: "Read a configuration value from the agent's KV config store.",
  inputSchema: z.object({
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, "invalid config key"),
  }),
  outputSchema: z.object({ key: z.string(), value: z.string().nullable() }),
  requiredCapability: CAPABILITIES.CONFIG_READ,
  effect: "read_only",
  failureBehavior: "report_and_continue",
  evidenceDescription: "Records the requested config key and whether it existed.",
  async execute(input, ctx: ToolContext) {
    const value = await ctx.env.CONFIG_KV.get(input.key);
    return { key: input.key, value };
  },
};

/** memory_read — read derived session memory from D1. */
export const memoryReadTool: Tool<
  { key: string },
  { key: string; value: string | null }
> = {
  name: "memory_read",
  description: "Read a value from the agent's durable per-session memory.",
  inputSchema: z.object({
    key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  }),
  outputSchema: z.object({ key: z.string(), value: z.string().nullable() }),
  requiredCapability: CAPABILITIES.MEMORY_READ,
  effect: "read_only",
  failureBehavior: "report_and_continue",
  evidenceDescription: "Records the memory key read.",
  async execute(input, ctx: ToolContext) {
    const row = await ctx.env.DB.prepare(
      "SELECT value FROM agent_memory WHERE session_id = ? AND key = ?",
    )
      .bind(ctx.sessionId, input.key)
      .first<{ value: string }>();
    return { key: input.key, value: row?.value ?? null };
  },
};

/**
 * memory_write — a mutating tool. Requires the memory:write capability, which is
 * gated behind human approval by the default policy. Application is idempotent:
 * re-running with the same idempotency key does not double-apply.
 */
export const memoryWriteTool: Tool<
  { key: string; value: string },
  { key: string; applied: boolean; idempotencyKey: string }
> = {
  name: "memory_write",
  description: "Write a value to the agent's durable per-session memory.",
  inputSchema: z.object({
    key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    value: z.string().max(8000),
  }),
  outputSchema: z.object({
    key: z.string(),
    applied: z.boolean(),
    idempotencyKey: z.string(),
  }),
  requiredCapability: CAPABILITIES.MEMORY_WRITE,
  effect: "mutating",
  failureBehavior: "fail_run",
  evidenceDescription:
    "Records the memory key written and the idempotency key used.",
  async execute(input, ctx: ToolContext) {
    // Idempotency guard: skip if this exact write was already applied.
    const existing = await ctx.env.DB.prepare(
      "SELECT last_idempotency_key FROM agent_memory WHERE session_id = ? AND key = ?",
    )
      .bind(ctx.sessionId, input.key)
      .first<{ last_idempotency_key: string }>();

    if (existing?.last_idempotency_key === ctx.idempotencyKey) {
      return { key: input.key, applied: false, idempotencyKey: ctx.idempotencyKey };
    }

    await ctx.env.DB.prepare(
      `INSERT INTO agent_memory (session_id, key, value, last_idempotency_key, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, key) DO UPDATE SET
         value = excluded.value,
         last_idempotency_key = excluded.last_idempotency_key,
         updated_at = excluded.updated_at`,
    )
      .bind(ctx.sessionId, input.key, input.value, ctx.idempotencyKey, ctx.now())
      .run();

    return { key: input.key, applied: true, idempotencyKey: ctx.idempotencyKey };
  },
};

/** Build the default registry of built-in tools. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(echoTool as Tool)
    .register(calculatorTool as Tool)
    .register(configReadTool as Tool)
    .register(memoryReadTool as Tool)
    .register(memoryWriteTool as Tool)
    .register(splatBugSearchTool as Tool);
}
