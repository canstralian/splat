/**
 * Injectable runtime dependencies. Isolating the sources of nondeterminism
 * (wall clock, id generation) behind an interface makes executions reproducible
 * and lets tests pin deterministic values.
 */
export interface RuntimeDeps {
  now: () => number;
  uuid: () => string;
}

export const defaultDeps: RuntimeDeps = {
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
};

/** Deterministic deps for tests/replay: monotonic clock and counter-based ids. */
export function deterministicDeps(seed = 0, startMs = 1_700_000_000_000): RuntimeDeps {
  let counter = seed;
  let clock = startMs;
  return {
    now: () => (clock += 1),
    uuid: () => `det-${(counter++).toString(16).padStart(8, "0")}`,
  };
}
