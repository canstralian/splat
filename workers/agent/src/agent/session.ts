import { DurableObject } from "cloudflare:workers";
import { DEFAULT_LIMITS } from "../constants";
import type { Env } from "../env";
import { logEvent } from "../observability/log";
import { SupabaseRestClient } from "../supabase/rest";
import { createSplatToolRegistry } from "../tools/splat";
import { createModelClient } from "./model";
import { SessionEngine, SqlSessionStore } from "./session-core";
import type { ExecutionsOutput, ResetOutput, SessionStateOutput, TurnInput, TurnOutput } from "./types";

/**
 * One Durable Object instance per user+session (name: `${userId}:${sessionId}`,
 * derived by the router from the *verified* identity — never from client
 * input alone). The DO provides strongly consistent, serialized access to
 * the session's conversation and execution history; all behaviour lives in
 * the unit-testable SessionEngine.
 */
export class AgentSession extends DurableObject<Env> {
  private readonly engine: SessionEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new SessionEngine({
      store: new SqlSessionStore(ctx.storage.sql),
      model: createModelClient(env, logEvent, DEFAULT_LIMITS.modelTimeoutMs),
      registry: createSplatToolRegistry(),
      supabaseFactory: (accessToken) =>
        new SupabaseRestClient({
          url: env.SUPABASE_URL,
          publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
          accessToken,
        }),
      limits: DEFAULT_LIMITS,
      now: () => Date.now(),
      log: logEvent,
      generateId: () => crypto.randomUUID(),
    });
  }

  async runTurn(input: TurnInput): Promise<TurnOutput> {
    return this.engine.runTurn(input);
  }

  async getState(input: { userId: string }): Promise<SessionStateOutput> {
    return this.engine.getState(input.userId);
  }

  async getExecutions(input: { userId: string }): Promise<ExecutionsOutput> {
    return this.engine.getExecutions(input.userId);
  }

  async reset(input: { userId: string }): Promise<ResetOutput> {
    return this.engine.reset(input.userId);
  }
}
