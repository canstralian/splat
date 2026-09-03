import { AgentError } from "../errors";
import type { LogFn } from "../observability/log";
import type { ToolCallRecord, ToolContext, ToolDefinition, ToolParametersSchema } from "./types";

export type ToolExposure = "read" | "read_write";

export interface ToolModelSpec {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

/**
 * Outcome of one tool call.
 *
 * - `ok`: validated output, fed to the model as a tool result.
 * - `recoverable`: the *model* made a mistake (unknown tool, invalid input,
 *   or an action the user is not permitted/allowed to take). The feedback is
 *   returned to the model so it can correct itself or explain to the user.
 *
 * Infrastructure failures (timeouts, upstream/data errors, output-contract
 * violations) are thrown as `AgentError` and abort the turn — they are never
 * silently converted into model feedback.
 */
export type ToolOutcome =
  | { status: "ok"; record: ToolCallRecord; output: unknown }
  | { status: "recoverable"; record: ToolCallRecord; feedback: string };

export interface ExecuteOptions {
  exposure: ToolExposure;
  executionId: string;
  now: () => number;
  log: LogFn;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new AgentError("config_error", `Duplicate tool registered: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /** Tools visible for the given exposure. Write tools require the runtime grant. */
  exposed(exposure: ToolExposure): ToolDefinition[] {
    return [...this.tools.values()].filter(
      (tool) => tool.access === "read" || exposure === "read_write",
    );
  }

  modelSpecs(exposure: ToolExposure): ToolModelSpec[] {
    return this.exposed(exposure).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(
    name: string,
    rawInput: unknown,
    ctx: Omit<ToolContext, "signal">,
    options: ExecuteOptions,
  ): Promise<ToolOutcome> {
    const { executionId, now, log } = options;
    const startedAt = now();
    const finish = (partial: Omit<ToolCallRecord, "durationMs">): ToolCallRecord => ({
      ...partial,
      durationMs: now() - startedAt,
    });

    const tool = this.tools.get(name);
    if (!tool) {
      const record = finish({ name, access: null, status: "error", errorCode: "tool_not_found" });
      log("tool_call", { executionId, tool: name, status: "error", errorCode: "tool_not_found" });
      return {
        status: "recoverable",
        record,
        feedback: `Tool "${name}" does not exist. Available tools: ${[...this.tools.keys()].join(", ")}.`,
      };
    }

    if (tool.access === "write" && options.exposure !== "read_write") {
      const record = finish({
        name,
        access: tool.access,
        status: "error",
        errorCode: "tool_forbidden",
      });
      log("tool_call", { executionId, tool: name, status: "error", errorCode: "tool_forbidden" });
      return {
        status: "recoverable",
        record,
        feedback:
          `Tool "${name}" makes changes and is disabled for this conversation. ` +
          "Tell the user to enable 'Allow changes' in the assistant settings if they want you to do this.",
      };
    }

    const parsedInput = tool.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      const issues = parsedInput.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      const record = finish({
        name,
        access: tool.access,
        status: "error",
        errorCode: "tool_invalid_input",
        errorMessage: issues,
      });
      log("tool_call", {
        executionId,
        tool: name,
        status: "error",
        errorCode: "tool_invalid_input",
        issues,
      });
      return {
        status: "recoverable",
        record,
        feedback: `Invalid arguments for tool "${name}": ${issues}. Fix the arguments and try again.`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tool.timeoutMs);
    let rawOutput: unknown;
    try {
      rawOutput = await Promise.race([
        tool.execute(parsedInput.data, { ...ctx, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new AgentError("tool_timeout", `Tool "${name}" timed out`)),
          );
        }),
      ]);
    } catch (error) {
      const agentError =
        error instanceof AgentError
          ? error
          : error instanceof Error && error.name === "AbortError"
            ? new AgentError("tool_timeout", `Tool "${name}" timed out`)
            : new AgentError("tool_failed", `Tool "${name}" failed`, { cause: error });

      const record = finish({
        name,
        access: tool.access,
        status: "error",
        errorCode: agentError.code,
        errorMessage: agentError.message,
      });
      log("tool_call", {
        executionId,
        tool: name,
        status: "error",
        errorCode: agentError.code,
        message: agentError.message,
      });

      // RLS denials are the user's permission boundary, not an infra failure:
      // let the model explain them instead of aborting the whole turn.
      if (agentError.code === "forbidden") {
        return {
          status: "recoverable",
          record,
          feedback: `Not permitted: ${agentError.message}. Explain this to the user; do not retry.`,
        };
      }

      agentError.details.record = record;
      throw agentError;
    } finally {
      clearTimeout(timer);
    }

    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      const record = finish({
        name,
        access: tool.access,
        status: "error",
        errorCode: "tool_invalid_output",
      });
      log("tool_call", {
        executionId,
        tool: name,
        status: "error",
        errorCode: "tool_invalid_output",
        issues: parsedOutput.error.issues.map((i) => i.path.join(".")).join(","),
      });
      const error = new AgentError("tool_invalid_output", `Tool "${name}" returned malformed data`);
      error.details.record = record;
      throw error;
    }

    const record = finish({ name, access: tool.access, status: "ok" });
    log("tool_call", { executionId, tool: name, status: "ok", durationMs: record.durationMs });
    return { status: "ok", record, output: parsedOutput.data };
  }
}
