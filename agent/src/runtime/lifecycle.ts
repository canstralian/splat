import {
  AgentError,
  ApprovalRequiredError,
  BudgetExceededError,
  MalformedModelOutputError,
  PolicyDeniedError,
  ToolNotFoundError,
} from "../errors";
import type { Env } from "../env";
import { parseModelDecision } from "../model/decision";
import {
  toProviderMessages,
  type ModelProvider,
} from "../model/provider";
import { PolicyEngine, type RunBudgetSnapshot } from "../governance/policy";
import type { EvidenceRecorder } from "../evidence/recorder";
import type { RunStore } from "../state/run-store";
import type { ToolRegistry } from "../tools/registry";
import { invokeTool } from "../tools/types";
import type { RuntimeDeps } from "./deps";
import type { Logger } from "../observability/logger";
import { classifyIntent } from "./intent";
import type {
  ConversationMessage,
  RunInput,
  RunRecord,
  RunStatus,
} from "../types";

export interface LifecycleParams {
  env: Env;
  deps: RuntimeDeps;
  logger: Logger;
  runId: string;
  input: RunInput;
  approvals: readonly string[];
  history: ConversationMessage[];
  provider: ModelProvider;
  registry: ToolRegistry;
  policy: PolicyEngine;
  store: RunStore;
  recorder: EvidenceRecorder;
  defaultToolTimeoutMs: number;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  outcome: string | null;
  error: string | null;
  toolCallCount: number;
  /** Messages produced during this Run, to be appended to session history. */
  newMessages: ConversationMessage[];
  /** Capability awaiting approval, when status === "awaiting_approval". */
  pendingApproval?: string;
}

/**
 * Execute one full agent lifecycle for a single user message. Each transition is
 * recorded as evidence and is independently observable/testable.
 */
export async function runLifecycle(params: LifecycleParams): Promise<RunOutcome> {
  const {
    env,
    deps,
    logger,
    runId,
    input,
    approvals,
    provider,
    registry,
    policy,
    store,
    recorder,
    defaultToolTimeoutMs,
  } = params;

  const startedAt = deps.now();
  const agentId = env.AGENT_ID ?? "agent";
  const agentVersion = env.AGENT_VERSION ?? "0.0.0";

  const userMessage: ConversationMessage = {
    role: "user",
    content: input.message,
    createdAt: deps.now(),
  };
  const messages: ConversationMessage[] = [...params.history, userMessage];
  const newMessages: ConversationMessage[] = [userMessage];

  // Create the Run aggregate (status running, version 0).
  const runRecord: RunRecord = {
    id: runId,
    sessionId: input.sessionId,
    agentId,
    agentVersion,
    status: "running",
    input: input.message,
    intent: null,
    outcome: null,
    error: null,
    toolCallCount: 0,
    version: 0,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  await store.createRun(runRecord);
  let version = 0;
  let toolCallCount = 0;

  // === Stage: INPUT ===
  await recorder.record("input", "UNVERIFIED", "Received user input", {
    sessionId: input.sessionId,
    messageLength: input.message.length,
  });

  try {
    // === Stage: INTENT / TASK CLASSIFICATION (deterministic, INFERRED) ===
    const intent = classifyIntent(input.message);
    await recorder.record("intent_classification", "INFERRED", "Classified intent", {
      intent: intent.intent,
      confidence: intent.confidence,
      method: "rule_based",
    });
    version = await store.updateRun(runId, version, { intent: intent.intent }, deps.now());

    const systemPrompt = buildSystemPrompt(registry);

    // Bounded reasoning loop. Governance caps iterations independently of the model.
    let finalContent: string | null = null;
    for (let step = 0; ; step++) {
      // === Stage: CONTEXT ASSEMBLY (INFERRED) ===
      const providerMessages = toProviderMessages(systemPrompt, messages);
      await recorder.record("context_assembly", "INFERRED", "Assembled model context", {
        step,
        messageCount: providerMessages.length,
      });

      // === Stage: POLICY / GOVERNANCE CHECK (pre-flight budget) ===
      const budget: RunBudgetSnapshot = {
        toolCallCount,
        elapsedMs: deps.now() - startedAt,
        approvalsGranted: approvals,
      };
      try {
        policy.checkBudget(budget);
        await recorder.record("policy_check", "INFERRED", "Budget check passed", {
          step,
          toolCallCount,
          maxToolCalls: policy.snapshot.maxToolCalls,
        });
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          await recorder.record("policy_check", "INFERRED", "Budget exceeded", {
            step,
            reason: err.message,
            detail: err.detail,
          });
          throw err;
        }
        throw err;
      }

      // === Stage: MODEL REASONING (MODEL_GENERATED, untrusted) ===
      const completion = await provider.complete(providerMessages);
      await recorder.record(
        "model_reasoning",
        "MODEL_GENERATED",
        "Model produced a decision",
        {
          step,
          provider: completion.provider,
          model: completion.model,
          promptFingerprint: completion.promptFingerprint,
          rawText: completion.text,
          usage: completion.usage ?? null,
        },
        // Offload potentially large raw model text to R2.
        { forceArtifact: completion.text.length > 2048 },
      );

      // === Stage: TOOL SELECTION (validate untrusted model output, INFERRED) ===
      let decision;
      try {
        decision = parseModelDecision(completion.text);
      } catch (err) {
        const malformed = new MalformedModelOutputError(
          "Model output failed schema validation",
          { cause: err instanceof Error ? err.message : String(err) },
        );
        await recorder.record("tool_selection", "INFERRED", "Rejected malformed model output", {
          step,
          error: malformed.message,
          detail: malformed.detail,
        });
        throw malformed;
      }

      if (decision.action === "final") {
        await recorder.record("tool_selection", "INFERRED", "Model chose to finalize", {
          step,
          reasoning: decision.reasoning,
        });
        finalContent = decision.content;
        break;
      }

      // action === "tool"
      if (!registry.has(decision.tool)) {
        const notFound = new ToolNotFoundError(decision.tool);
        await recorder.record("tool_selection", "INFERRED", "Model selected unknown tool", {
          step,
          tool: decision.tool,
        });
        throw notFound;
      }
      const tool = registry.get(decision.tool);
      await recorder.record("tool_selection", "INFERRED", "Model selected a tool", {
        step,
        tool: tool.name,
        capability: tool.requiredCapability,
        effect: tool.effect,
        reasoning: decision.reasoning,
      });

      // === Stage: POLICY capability gate (can STOP before tool execution) ===
      const gateBudget: RunBudgetSnapshot = {
        toolCallCount,
        elapsedMs: deps.now() - startedAt,
        approvalsGranted: approvals,
      };
      const gate = policy.authorizeTool(tool, gateBudget);
      await recorder.record("policy_check", "INFERRED", `Capability gate: ${gate.decision}`, {
        step,
        tool: tool.name,
        capability: gate.capability,
        decision: gate.decision,
        reason: gate.reason,
      });
      // Throws PolicyDeniedError / ApprovalRequiredError on non-allow; these are
      // terminal for the Run and handled by handleFailure.
      PolicyEngine.enforce(gate);

      // === Stage: TOOL EXECUTION (VERIFIED in-system operation) ===
      const idempotencyKey = `${runId}:${toolCallCount}:${tool.name}`;
      const invocation = await invokeTool(
        tool,
        decision.arguments,
        {
          runId,
          sessionId: input.sessionId,
          env,
          logger,
          now: deps.now,
          idempotencyKey,
        },
        defaultToolTimeoutMs,
      );
      await recorder.record("tool_execution", "VERIFIED", `Executed tool ${tool.name}`, {
        step,
        tool: tool.name,
        arguments: decision.arguments,
        output: invocation.output,
        durationMs: invocation.durationMs,
        idempotencyKey,
      });

      // === Stage: RESULT VALIDATION (output already schema-checked; INFERRED) ===
      await recorder.record("result_validation", "INFERRED", "Tool output validated", {
        step,
        tool: tool.name,
        valid: true,
      });

      // Append tool result to context and to the persisted transcript.
      const toolMessage: ConversationMessage = {
        role: "tool",
        toolName: tool.name,
        content: JSON.stringify(invocation.output),
        createdAt: deps.now(),
      };
      messages.push(toolMessage);
      newMessages.push(toolMessage);

      // === Stage: STATE UPDATE (CAS on the Run aggregate) ===
      toolCallCount += 1;
      version = await store.updateRun(runId, version, { toolCallCount }, deps.now());
      await recorder.record("state_update", "VERIFIED", "Run state updated", {
        step,
        toolCallCount,
        version,
      });
    }

    // === Stage: RESPONSE ===
    const assistantMessage: ConversationMessage = {
      role: "assistant",
      content: finalContent ?? "",
      createdAt: deps.now(),
    };
    messages.push(assistantMessage);
    newMessages.push(assistantMessage);

    version = await store.updateRun(
      runId,
      version,
      { status: "completed", outcome: finalContent },
      deps.now(),
    );
    // The final answer is MODEL_GENERATED — recorded as such, never as VERIFIED.
    await recorder.record("response", "MODEL_GENERATED", "Produced final response", {
      contentLength: (finalContent ?? "").length,
    });

    return {
      runId,
      status: "completed",
      outcome: finalContent,
      error: null,
      toolCallCount,
      newMessages,
    };
  } catch (err) {
    return await handleFailure({
      err,
      runId,
      version,
      toolCallCount,
      newMessages,
      store,
      recorder,
      deps,
    });
  }
}

async function handleFailure(args: {
  err: unknown;
  runId: string;
  version: number;
  toolCallCount: number;
  newMessages: ConversationMessage[];
  store: RunStore;
  recorder: EvidenceRecorder;
  deps: RuntimeDeps;
}): Promise<RunOutcome> {
  const { err, runId, version, toolCallCount, newMessages, store, recorder, deps } = args;

  // Approval escalation is not a failure: it is a governed pause.
  if (err instanceof ApprovalRequiredError) {
    await store.updateRun(
      runId,
      version,
      { status: "awaiting_approval", error: err.message },
      deps.now(),
    );
    await recorder.record("response", "INFERRED", "Run paused awaiting human approval", {
      code: err.code,
      capability: err.detail.capability,
    });
    return {
      runId,
      status: "awaiting_approval",
      outcome: null,
      error: err.message,
      toolCallCount,
      newMessages,
      pendingApproval: String(err.detail.capability ?? ""),
    };
  }

  const isDenied = err instanceof PolicyDeniedError;
  const status: RunStatus = isDenied ? "denied" : "failed";
  const code = err instanceof AgentError ? err.code : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);

  await store.updateRun(runId, version, { status, error: message }, deps.now());
  await recorder.record("response", "INFERRED", `Run ${status}`, {
    code,
    message,
  });

  return {
    runId,
    status,
    outcome: null,
    error: message,
    toolCallCount,
    newMessages,
  };
}

function buildSystemPrompt(registry: ToolRegistry): string {
  const catalogue = registry
    .describe()
    .map((t) => `- ${t.name} (${t.effect}, capability=${t.capability}): ${t.description}`)
    .join("\n");

  return [
    "You are a governed task agent. You must respond with a SINGLE JSON object and nothing else.",
    "",
    "To call a tool, respond:",
    '{"action":"tool","reasoning":"<why>","tool":"<tool_name>","arguments":{...}}',
    "",
    "To finish, respond:",
    '{"action":"final","reasoning":"<why>","content":"<final answer>"}',
    "",
    "Available tools:",
    catalogue,
    "",
    "Rules: choose only listed tools; provide arguments that match the tool; do not fabricate tool results; finalize when the task is complete.",
  ].join("\n");
}
