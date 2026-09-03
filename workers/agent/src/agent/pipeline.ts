import type { AgentLimits } from "../constants";
import { AgentError, toAgentError } from "../errors";
import type { LogFn } from "../observability/log";
import type { ToolExposure, ToolRegistry } from "../tools/registry";
import type { ToolCallRecord, ToolContext } from "../tools/types";
import type { Intent } from "./classify";
import type { ModelChatMessage, ModelClient } from "./model";
import { buildSystemPrompt } from "./prompts";
import type { ChatMessage } from "./types";

/**
 * The model-execution stage of the lifecycle:
 *
 *   CONTEXT ASSEMBLY → MODEL EXECUTION → TOOL SELECTION → TOOL EXECUTION
 *   → RESULT VALIDATION
 *
 * The model proposes tool calls; the runtime (ToolRegistry) validates and
 * executes them. Model mistakes (unknown tool, bad arguments, disallowed
 * writes) are fed back a bounded number of times so the model can recover;
 * infrastructure failures abort the turn with the partial tool-call trace
 * attached for the execution record.
 */
export interface TurnContext {
  executionId: string;
  message: string;
  intent: Intent;
  exposure: ToolExposure;
  history: ChatMessage[];
  allowWrites: boolean;
}

export interface PipelineDeps {
  model: ModelClient;
  registry: ToolRegistry;
  toolContext: Omit<ToolContext, "signal">;
  limits: AgentLimits;
  now: () => number;
  log: LogFn;
}

export interface PipelineResult {
  reply: string;
  toolCalls: ToolCallRecord[];
}

export async function runAgentTurn(turn: TurnContext, deps: PipelineDeps): Promise<PipelineResult> {
  const { model, registry, limits, log, now } = deps;
  const specs = registry.modelSpecs(turn.exposure);

  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        identity: deps.toolContext.identity,
        intent: turn.intent,
        allowWrites: turn.allowWrites,
        tools: specs,
      }),
    },
    ...turn.history.slice(-limits.historyContextMessages).map(
      (m): ModelChatMessage => ({ role: m.role, content: m.content }),
    ),
    { role: "user", content: turn.message },
  ];

  const records: ToolCallRecord[] = [];
  let recoveries = 0;

  try {
    for (let iteration = 0; iteration < limits.maxToolIterations; iteration++) {
      const modelStart = now();
      const result = await model.complete(messages, specs);
      log("model_call", {
        executionId: turn.executionId,
        model: model.modelId,
        iteration,
        kind: result.kind,
        durationMs: now() - modelStart,
      });

      if (result.kind === "text") {
        const reply = result.text.trim().slice(0, limits.maxReplyChars);
        if (reply.length === 0) {
          throw new AgentError("model_malformed", "The model returned an empty reply");
        }
        return { reply, toolCalls: records };
      }

      const calls = result.calls.slice(0, limits.maxToolCallsPerIteration);
      messages.push({
        role: "assistant",
        content: JSON.stringify({ tool_calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })) }),
      });

      for (const call of calls) {
        const outcome = await registry.execute(call.name, call.arguments, deps.toolContext, {
          exposure: turn.exposure,
          executionId: turn.executionId,
          now,
          log,
        });
        records.push(outcome.record);

        if (outcome.status === "ok") {
          messages.push({ role: "tool", name: call.name, content: JSON.stringify(outcome.output) });
        } else {
          recoveries += 1;
          if (recoveries > limits.maxModelRecoveries) {
            throw new AgentError("model_malformed", "The model repeatedly issued invalid tool calls");
          }
          messages.push({ role: "tool", name: call.name, content: JSON.stringify({ error: outcome.feedback }) });
        }
      }
    }

    throw new AgentError("model_error", "The request needed too many tool steps to complete");
  } catch (error) {
    const agentError = toAgentError(error);
    // Attach the partial execution trace so the session records exactly what
    // ran before the failure (partial execution is never silently dropped).
    if (!Array.isArray(agentError.details.toolCalls)) {
      agentError.details.toolCalls = records;
    }
    throw agentError;
  }
}
