import type { AgentLimits } from "../constants";
import { AgentError } from "../errors";
import type { ToolExposure } from "../tools/registry";

/**
 * Policy check: runs after authentication and classification, before any
 * model call. Decides which capabilities this turn gets and rejects turns
 * that violate limits. Tool exposure derives exclusively from the runtime
 * `allowWrites` grant — nothing in the message text can widen it.
 */
export interface PolicyInput {
  message: string;
  allowWrites: boolean;
  /** Turns started within the rate-limit window, including this one. */
  recentTurnCount: number;
  limits: AgentLimits;
}

export interface PolicyDecision {
  exposure: ToolExposure;
}

export function checkTurnPolicy(input: PolicyInput): PolicyDecision {
  const message = input.message.trim();
  if (message.length === 0) {
    throw new AgentError("invalid_request", "Message must not be empty");
  }
  if (message.length > input.limits.maxMessageChars) {
    throw new AgentError(
      "invalid_request",
      `Message exceeds the ${input.limits.maxMessageChars} character limit`,
    );
  }
  if (input.recentTurnCount > input.limits.rateLimitMaxTurns) {
    throw new AgentError("rate_limited", "Too many requests — please slow down", {
      details: { windowMs: input.limits.rateLimitWindowMs },
    });
  }
  return { exposure: input.allowWrites ? "read_write" : "read" };
}
