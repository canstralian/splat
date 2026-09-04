import type { z } from "zod";
import type { Env } from "../env";
import type { Logger } from "../observability/logger";
import type { ToolEffect } from "../types";
import {
  ToolTimeoutError,
  ToolValidationError,
  ToolExecutionError,
} from "../errors";

/** Runtime context handed to a tool at execution time. */
export interface ToolContext {
  runId: string;
  sessionId: string;
  env: Env;
  logger: Logger;
  /** Aborted when the tool exceeds its timeout budget. */
  signal: AbortSignal;
  now: () => number;
  /**
   * Idempotency key for the current tool invocation. Mutating tools MUST use
   * this to guard against duplicate application on retry.
   */
  idempotencyKey: string;
}

/**
 * Formal tool definition. Every capability the agent can exercise is expressed
 * as a Tool with an explicit schema, capability requirement, effect and failure
 * behaviour. Arbitrary invocation is impossible: a tool must be registered and
 * its capability must be granted by policy.
 */
export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  /** Capability string that policy must grant for this tool to run. */
  readonly requiredCapability: string;
  /** Whether the tool reads only, or mutates persistent/external state. */
  readonly effect: ToolEffect;
  /** Per-tool timeout; falls back to the runtime default when omitted. */
  readonly timeoutMs?: number;
  /** Whether a tool error should fail the Run or be reported and continue. */
  readonly failureBehavior: "fail_run" | "report_and_continue";
  /** Human-readable description of the evidence this tool produces. */
  readonly evidenceDescription: string;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolInvocationResult<O = unknown> {
  output: O;
  durationMs: number;
}

/**
 * Validate arguments, enforce the timeout, execute, and validate output. This
 * function performs NO capability check — that gate is owned by the governance
 * layer and must be evaluated before calling this.
 */
export async function invokeTool<I, O>(
  tool: Tool<I, O>,
  rawArgs: unknown,
  ctx: Omit<ToolContext, "signal">,
  defaultTimeoutMs: number,
): Promise<ToolInvocationResult<O>> {
  // 1. Validate input BEFORE execution.
  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolValidationError(tool.name, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  const start = ctx.now();

  const timeout = new Promise<never>((_resolve, reject) => {
    const handle = setTimeout(() => {
      controller.abort();
      reject(new ToolTimeoutError(tool.name, timeoutMs));
    }, timeoutMs);
    // Prevent the timer from keeping the isolate alive unnecessarily.
    if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
      (handle as unknown as { unref: () => void }).unref();
    }
  });

  const run = (async () => {
    try {
      return await tool.execute(parsed.data, { ...ctx, signal: controller.signal });
    } catch (err) {
      if (err instanceof ToolTimeoutError || err instanceof ToolValidationError) {
        throw err;
      }
      throw new ToolExecutionError(
        tool.name,
        err instanceof Error ? err.message : String(err),
      );
    }
  })();

  const output = await Promise.race([run, timeout]);

  // 2. Validate output AFTER execution (defence against tool bugs).
  const validatedOut = tool.outputSchema.safeParse(output);
  if (!validatedOut.success) {
    throw new ToolExecutionError(tool.name, "tool produced invalid output", {
      issues: validatedOut.error.issues.map((i) => i.message),
    });
  }

  return { output: validatedOut.data, durationMs: ctx.now() - start };
}
