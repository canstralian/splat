import { AgentError } from "../errors";
import type { LogFn } from "../observability/log";
import type { ToolModelSpec } from "../tools/registry";

/**
 * Model abstraction. The pipeline only ever sees this interface, so the
 * provider can be swapped (Workers AI, AI Gateway routing, deterministic
 * stub for offline development) without touching the lifecycle.
 */
export interface ModelChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool name, present on `tool` result messages. */
  name?: string;
}

export interface ModelToolCall {
  name: string;
  arguments: unknown;
}

export type ModelResult =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; calls: ModelToolCall[] };

export interface ModelClient {
  readonly modelId: string;
  complete(messages: ModelChatMessage[], tools: ToolModelSpec[]): Promise<ModelResult>;
}

interface WorkersAiOptions {
  gatewayId?: string;
  timeoutMs: number;
  log: LogFn;
}

interface RawToolCall {
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** Normalizes both `{name, arguments}` and OpenAI-style `{function:{...}}` call shapes. */
export function normalizeToolCalls(raw: unknown): ModelToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ModelToolCall[] = [];
  for (const item of raw as RawToolCall[]) {
    const name = typeof item?.name === "string" ? item.name : item?.function?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    let args = item?.arguments ?? item?.function?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // Leave as the raw string; input validation will reject it and the
        // model gets structured feedback to correct itself.
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

export class WorkersAiModel implements ModelClient {
  constructor(
    private readonly ai: Ai,
    readonly modelId: string,
    private readonly options: WorkersAiOptions,
  ) {}

  async complete(messages: ModelChatMessage[], tools: ToolModelSpec[]): Promise<ModelResult> {
    // Model calls are non-mutating, so one retry on transient failure is safe.
    let lastError: AgentError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.completeOnce(messages, tools);
      } catch (error) {
        if (error instanceof AgentError && error.code === "model_malformed") throw error;
        lastError = error instanceof AgentError ? error : new AgentError("model_error", "Model call failed", { cause: error });
        this.options.log("model_retry", { attempt, code: lastError.code });
      }
    }
    throw lastError ?? new AgentError("model_error", "Model call failed");
  }

  private async completeOnce(messages: ModelChatMessage[], tools: ToolModelSpec[]): Promise<ModelResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AgentError("model_timeout", "The model took too long to respond")),
        this.options.timeoutMs,
      );
    });

    let raw: unknown;
    try {
      const inputs: Record<string, unknown> = { messages };
      if (tools.length > 0) inputs.tools = tools;
      const gateway = this.options.gatewayId ? { gateway: { id: this.options.gatewayId } } : undefined;
      raw = await Promise.race([
        // Dynamic model ids hit the `run<Model extends string>` fallback on Ai
        // (workers-types 5.20260903.1+); known literals keep their typed overloads.
        this.ai.run(this.modelId, inputs, gateway),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("model_error", "Model call failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const result = raw as { response?: unknown; tool_calls?: unknown };
    const calls = normalizeToolCalls(result?.tool_calls);
    if (calls.length > 0) return { kind: "tool_calls", calls };
    if (typeof result?.response === "string" && result.response.trim().length > 0) {
      return { kind: "text", text: result.response };
    }
    throw new AgentError("model_malformed", "The model returned an unusable response");
  }
}

/**
 * Deterministic offline model for local development and end-to-end testing
 * (`MODEL_PROVIDER=stub`). Never enable in production configuration.
 */
export class StubModel implements ModelClient {
  readonly modelId = "stub";

  async complete(messages: ModelChatMessage[], tools: ToolModelSpec[]): Promise<ModelResult> {
    const last = messages[messages.length - 1];
    if (last?.role === "tool") {
      return { kind: "text", text: `Stub summary of ${last.name ?? "tool"} result: ${last.content.slice(0, 400)}` };
    }
    const text = (messages.filter((m) => m.role === "user").pop()?.content ?? "").trim();
    const available = new Set(tools.map((t) => t.name));

    const createMatch = /^create bug:\s*(.+)$/i.exec(text);
    if (createMatch && available.has("create_bug")) {
      return {
        kind: "tool_calls",
        calls: [{ name: "create_bug", arguments: { title: createMatch[1], severity: "minor", category: "ui" } }],
      };
    }
    const statusMatch = /^set status of (SPL-\d+) to (\w+)$/i.exec(text);
    if (statusMatch && available.has("update_bug_status")) {
      return {
        kind: "tool_calls",
        calls: [{ name: "update_bug_status", arguments: { trackingId: statusMatch[1], status: statusMatch[2] } }],
      };
    }
    // Exercises the forbidden/recoverable path when writes are disabled.
    if ((createMatch || statusMatch) && !available.has("create_bug")) {
      return { kind: "tool_calls", calls: [{ name: "create_bug", arguments: { title: text, severity: "minor", category: "ui" } }] };
    }
    if (/search|list|show|find/i.test(text)) {
      return { kind: "tool_calls", calls: [{ name: "search_bugs", arguments: { limit: 5 } }] };
    }
    return { kind: "text", text: `Stub reply: ${text.slice(0, 200)}` };
  }
}

export interface ModelEnvConfig {
  AI: Ai;
  MODEL_ID: string;
  MODEL_PROVIDER?: string;
  MODEL_TIMEOUT_MS?: string;
  AI_GATEWAY_ID?: string;
}

export function createModelClient(env: ModelEnvConfig, log: LogFn, defaultTimeoutMs: number): ModelClient {
  if (env.MODEL_PROVIDER === "stub") {
    log("model_stub_enabled", { warning: "Deterministic stub model in use — development only" });
    return new StubModel();
  }
  const timeoutMs = Number.parseInt(env.MODEL_TIMEOUT_MS ?? "", 10) || defaultTimeoutMs;
  return new WorkersAiModel(env.AI, env.MODEL_ID, {
    gatewayId: env.AI_GATEWAY_ID,
    timeoutMs,
    log,
  });
}
