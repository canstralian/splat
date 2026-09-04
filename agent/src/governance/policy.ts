import {
  ApprovalRequiredError,
  BudgetExceededError,
  PolicyDeniedError,
} from "../errors";
import type { Tool } from "../tools/types";

/**
 * Declarative governance policy. The model NEVER enforces governance; this
 * engine does, deterministically, before any consequential action.
 */
export interface Policy {
  /** Capabilities the agent is permitted to use. */
  readonly allowedCapabilities: readonly string[];
  /** Capabilities explicitly forbidden. Takes precedence over allow. */
  readonly prohibitedCapabilities: readonly string[];
  /** Capabilities whose (mutating) use requires human approval. */
  readonly approvalRequiredCapabilities: readonly string[];
  /** Maximum number of tool calls per Run. */
  readonly maxToolCalls: number;
  /** Maximum wall-clock time for a Run, in milliseconds. */
  readonly maxWallClockMs: number;
  /** Whether mutating tools are allowed at all. */
  readonly allowMutations: boolean;
}

export const DEFAULT_POLICY: Policy = {
  allowedCapabilities: [
    "util:echo",
    "compute:arithmetic",
    "config:read",
    "memory:read",
    "memory:write",
    "splat:bugs:read",
  ],
  prohibitedCapabilities: [],
  approvalRequiredCapabilities: ["memory:write"],
  maxToolCalls: 8,
  maxWallClockMs: 60_000,
  allowMutations: true,
};

export type PolicyDecisionType = "allow" | "deny" | "escalate";

export interface PolicyDecision {
  decision: PolicyDecisionType;
  reason: string;
  capability: string;
  detail?: Record<string, unknown>;
}

export interface RunBudgetSnapshot {
  toolCallCount: number;
  elapsedMs: number;
  approvalsGranted: readonly string[];
}

/**
 * Pure, deterministic policy engine. Every method returns a decision or throws a
 * typed governance error; nothing here performs side effects.
 */
export class PolicyEngine {
  constructor(private readonly policy: Policy) {}

  get snapshot(): Policy {
    return this.policy;
  }

  /**
   * Pre-flight budget check performed at the POLICY/GOVERNANCE CHECK stage,
   * before model reasoning and before every tool call.
   */
  checkBudget(budget: RunBudgetSnapshot): void {
    if (budget.toolCallCount >= this.policy.maxToolCalls) {
      throw new BudgetExceededError("Maximum tool calls exceeded", {
        maxToolCalls: this.policy.maxToolCalls,
        toolCallCount: budget.toolCallCount,
      });
    }
    if (budget.elapsedMs >= this.policy.maxWallClockMs) {
      throw new BudgetExceededError("Maximum wall-clock time exceeded", {
        maxWallClockMs: this.policy.maxWallClockMs,
        elapsedMs: budget.elapsedMs,
      });
    }
  }

  /**
   * The capability gate. Evaluated immediately before TOOL EXECUTION. Returns an
   * allow/deny/escalate decision. This is the single choke point that can stop
   * execution before a tool runs.
   */
  authorizeTool(tool: Tool, budget: RunBudgetSnapshot): PolicyDecision {
    const cap = tool.requiredCapability;

    if (this.policy.prohibitedCapabilities.includes(cap)) {
      return {
        decision: "deny",
        reason: `Capability '${cap}' is prohibited by policy`,
        capability: cap,
      };
    }

    if (!this.policy.allowedCapabilities.includes(cap)) {
      return {
        decision: "deny",
        reason: `Capability '${cap}' is not in the allow-list`,
        capability: cap,
      };
    }

    if (tool.effect === "mutating" && !this.policy.allowMutations) {
      return {
        decision: "deny",
        reason: "Mutating tools are disabled by policy",
        capability: cap,
      };
    }

    if (
      tool.effect === "mutating" &&
      this.policy.approvalRequiredCapabilities.includes(cap) &&
      !budget.approvalsGranted.includes(cap)
    ) {
      return {
        decision: "escalate",
        reason: `Capability '${cap}' requires human approval`,
        capability: cap,
      };
    }

    return { decision: "allow", reason: "Permitted by policy", capability: cap };
  }

  /**
   * Enforce a decision, throwing the appropriate typed error for non-allow
   * outcomes so callers cannot accidentally proceed.
   */
  static enforce(decision: PolicyDecision): void {
    if (decision.decision === "deny") {
      throw new PolicyDeniedError(decision.reason, {
        capability: decision.capability,
      });
    }
    if (decision.decision === "escalate") {
      throw new ApprovalRequiredError(decision.reason, {
        capability: decision.capability,
      });
    }
  }
}

/** Build a policy from environment configuration, falling back to defaults. */
export function policyFromEnv(env: {
  MAX_TOOL_CALLS?: string;
  MAX_WALL_CLOCK_MS?: string;
}): Policy {
  return {
    ...DEFAULT_POLICY,
    maxToolCalls: parseIntOr(env.MAX_TOOL_CALLS, DEFAULT_POLICY.maxToolCalls),
    maxWallClockMs: parseIntOr(
      env.MAX_WALL_CLOCK_MS,
      DEFAULT_POLICY.maxWallClockMs,
    ),
  };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
