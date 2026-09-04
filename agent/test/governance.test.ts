import { describe, expect, it } from "vitest";
import { PolicyEngine, type Policy } from "../src/governance/policy";
import { calculatorTool, memoryWriteTool } from "../src/tools/builtins";
import { BudgetExceededError } from "../src/errors";
import type { Tool } from "../src/tools/types";

function policy(overrides: Partial<Policy>): Policy {
  return {
    allowedCapabilities: ["compute:arithmetic"],
    prohibitedCapabilities: [],
    approvalRequiredCapabilities: [],
    maxToolCalls: 8,
    maxWallClockMs: 60_000,
    allowMutations: true,
    ...overrides,
  };
}

describe("Governance rejection (req 5)", () => {
  it("denies a prohibited capability", () => {
    const engine = new PolicyEngine(
      policy({ prohibitedCapabilities: ["compute:arithmetic"] }),
    );
    const decision = engine.authorizeTool(calculatorTool as Tool, {
      toolCallCount: 0,
      elapsedMs: 0,
      approvalsGranted: [],
    });
    expect(decision.decision).toBe("deny");
    expect(() => PolicyEngine.enforce(decision)).toThrowError(/prohibited/);
  });

  it("denies mutations when mutations are disabled", () => {
    const engine = new PolicyEngine(
      policy({
        allowedCapabilities: ["memory:write"],
        allowMutations: false,
      }),
    );
    const decision = engine.authorizeTool(memoryWriteTool as Tool, {
      toolCallCount: 0,
      elapsedMs: 0,
      approvalsGranted: [],
    });
    expect(decision.decision).toBe("deny");
  });

  it("escalates a capability that requires human approval", () => {
    const engine = new PolicyEngine(
      policy({
        allowedCapabilities: ["memory:write"],
        approvalRequiredCapabilities: ["memory:write"],
      }),
    );
    const decision = engine.authorizeTool(memoryWriteTool as Tool, {
      toolCallCount: 0,
      elapsedMs: 0,
      approvalsGranted: [],
    });
    expect(decision.decision).toBe("escalate");

    // With the approval granted, it is allowed.
    const approved = engine.authorizeTool(memoryWriteTool as Tool, {
      toolCallCount: 0,
      elapsedMs: 0,
      approvalsGranted: ["memory:write"],
    });
    expect(approved.decision).toBe("allow");
  });
});

describe("Unauthorized capability requests (req 11)", () => {
  it("denies a capability that is not in the allow-list", () => {
    const engine = new PolicyEngine(policy({ allowedCapabilities: ["util:echo"] }));
    const decision = engine.authorizeTool(calculatorTool as Tool, {
      toolCallCount: 0,
      elapsedMs: 0,
      approvalsGranted: [],
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/not in the allow-list/);
  });
});

describe("Budget enforcement", () => {
  it("throws when max tool calls are reached", () => {
    const engine = new PolicyEngine(policy({ maxToolCalls: 2 }));
    expect(() =>
      engine.checkBudget({ toolCallCount: 2, elapsedMs: 0, approvalsGranted: [] }),
    ).toThrowError(BudgetExceededError);
  });

  it("throws when wall-clock budget is exceeded", () => {
    const engine = new PolicyEngine(policy({ maxWallClockMs: 1000 }));
    expect(() =>
      engine.checkBudget({ toolCallCount: 0, elapsedMs: 2000, approvalsGranted: [] }),
    ).toThrowError(BudgetExceededError);
  });
});
