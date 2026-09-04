/**
 * The closed set of capabilities the runtime understands. Tools declare exactly
 * one required capability; policy grants a subset. Adding a capability is a
 * deliberate, reviewable act.
 */
export const CAPABILITIES = {
  UTIL_ECHO: "util:echo",
  COMPUTE_ARITHMETIC: "compute:arithmetic",
  CONFIG_READ: "config:read",
  MEMORY_READ: "memory:read",
  MEMORY_WRITE: "memory:write",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const ALL_CAPABILITIES: Capability[] = Object.values(CAPABILITIES);
