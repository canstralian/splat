import { AgentError } from "../src/errors";
import type { LogFn } from "../src/observability/log";
import type { ModelChatMessage, ModelClient, ModelResult } from "../src/agent/model";
import type { SessionStore } from "../src/agent/session-core";
import type { ChatMessage, ExecutionRecord } from "../src/agent/types";
import { SupabaseRestClient } from "../src/supabase/rest";
import type { ToolModelSpec } from "../src/tools/registry";

export const silentLog: LogFn = () => {};

export const testIdentity = { userId: "user-1", email: "user1@example.com" };

/** Model that replays a fixed script and records every transcript it saw. */
export class ScriptedModel implements ModelClient {
  readonly modelId = "scripted-model";
  readonly transcripts: ModelChatMessage[][] = [];
  readonly toolSpecs: ToolModelSpec[][] = [];

  constructor(private readonly script: Array<ModelResult | AgentError>) {}

  async complete(messages: ModelChatMessage[], tools: ToolModelSpec[]): Promise<ModelResult> {
    this.transcripts.push([...messages]);
    this.toolSpecs.push([...tools]);
    const next = this.script.shift();
    if (!next) throw new AgentError("model_error", "Scripted model exhausted");
    if (next instanceof AgentError) throw next;
    return next;
  }
}

/** In-memory SessionStore mirroring SqlSessionStore semantics. */
export class MemorySessionStore implements SessionStore {
  private userId: string | null = null;
  private messages: ChatMessage[] = [];
  private executions: ExecutionRecord[] = [];

  getUserId(): string | null {
    return this.userId;
  }
  setUserId(userId: string): void {
    this.userId = userId;
  }
  appendMessage(message: ChatMessage): void {
    this.messages.push(message);
  }
  listMessages(limit: number): ChatMessage[] {
    return this.messages.slice(-limit);
  }
  countMessages(): number {
    return this.messages.length;
  }
  pruneMessages(keep: number): void {
    this.messages = this.messages.slice(-keep);
  }
  appendExecution(record: ExecutionRecord): void {
    this.executions.push(record);
  }
  listExecutions(limit: number): ExecutionRecord[] {
    return [...this.executions].reverse().slice(0, limit);
  }
  countExecutions(): number {
    return this.executions.length;
  }
  countExecutionsSince(timestampMs: number): number {
    return this.executions.filter((e) => e.createdAt >= timestampMs).length;
  }
  clear(): void {
    this.messages = [];
    this.executions = [];
  }
}

export interface CapturedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeRoute = (req: CapturedRequest) => { status?: number; body?: unknown };

/**
 * Builds a SupabaseRestClient backed by a fake fetch. The handler is keyed by
 * `"METHOD /rest/v1/<table>"`; unmatched requests return 404.
 */
export function fakeSupabase(routes: Record<string, FakeRoute>): {
  client: SupabaseRestClient;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const req: CapturedRequest = {
      method,
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    captured.push(req);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    const result = route(req);
    return new Response(JSON.stringify(result.body ?? null), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const client = new SupabaseRestClient({
    url: "https://supabase.test",
    publishableKey: "anon-key",
    accessToken: "user-jwt",
    fetchFn,
  });
  return { client, captured };
}

export function neverAbort(): AbortSignal {
  return new AbortController().signal;
}
