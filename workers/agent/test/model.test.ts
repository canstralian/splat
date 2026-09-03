import { describe, expect, it } from "vitest";
import { normalizeToolCalls, StubModel, WorkersAiModel } from "../src/agent/model";
import { silentLog } from "./helpers";

function aiRunning(fn: (model: string, inputs: unknown, options?: unknown) => Promise<unknown>): Ai {
  return { run: fn } as unknown as Ai;
}

describe("normalizeToolCalls", () => {
  it("accepts Workers AI shape", () => {
    expect(normalizeToolCalls([{ name: "search_bugs", arguments: { limit: 5 } }])).toEqual([
      { name: "search_bugs", arguments: { limit: 5 } },
    ]);
  });

  it("accepts OpenAI-style function shape with JSON string arguments", () => {
    expect(normalizeToolCalls([{ function: { name: "get_bug", arguments: '{"trackingId":"SPL-1"}' } }])).toEqual([
      { name: "get_bug", arguments: { trackingId: "SPL-1" } },
    ]);
  });

  it("keeps unparseable string arguments raw so validation can reject them", () => {
    const calls = normalizeToolCalls([{ name: "get_bug", arguments: "not-json" }]);
    expect(calls).toEqual([{ name: "get_bug", arguments: "not-json" }]);
  });

  it("skips entries without a usable name", () => {
    expect(normalizeToolCalls([{ arguments: {} }, "junk", null])).toEqual([]);
  });
});

describe("WorkersAiModel", () => {
  const options = { timeoutMs: 50, log: silentLog };

  it("returns text responses", async () => {
    const model = new WorkersAiModel(aiRunning(async () => ({ response: "hello" })), "m", options);
    expect(await model.complete([], [])).toEqual({ kind: "text", text: "hello" });
  });

  it("returns normalized tool calls", async () => {
    const model = new WorkersAiModel(
      aiRunning(async () => ({ tool_calls: [{ name: "search_bugs", arguments: {} }] })),
      "m",
      options,
    );
    expect(await model.complete([], [])).toEqual({
      kind: "tool_calls",
      calls: [{ name: "search_bugs", arguments: {} }],
    });
  });

  it("throws model_malformed for unusable responses without retrying", async () => {
    let attempts = 0;
    const model = new WorkersAiModel(
      aiRunning(async () => {
        attempts += 1;
        return { response: "" };
      }),
      "m",
      options,
    );
    await expect(model.complete([], [])).rejects.toMatchObject({ code: "model_malformed" });
    expect(attempts).toBe(1);
  });

  it("retries transient failures once, then succeeds", async () => {
    let attempts = 0;
    const model = new WorkersAiModel(
      aiRunning(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return { response: "recovered" };
      }),
      "m",
      options,
    );
    expect(await model.complete([], [])).toEqual({ kind: "text", text: "recovered" });
    expect(attempts).toBe(2);
  });

  it("surfaces model_error after retries are exhausted", async () => {
    const model = new WorkersAiModel(
      aiRunning(async () => {
        throw new Error("always down");
      }),
      "m",
      options,
    );
    await expect(model.complete([], [])).rejects.toMatchObject({ code: "model_error" });
  });

  it("times out slow model calls", async () => {
    const model = new WorkersAiModel(
      aiRunning(() => new Promise(() => {})),
      "m",
      { timeoutMs: 10, log: silentLog },
    );
    await expect(model.complete([], [])).rejects.toMatchObject({ code: "model_timeout" });
  });

  it("routes through AI Gateway when configured", async () => {
    let seenOptions: unknown;
    const model = new WorkersAiModel(
      aiRunning(async (_m, _i, opts) => {
        seenOptions = opts;
        return { response: "ok" };
      }),
      "m",
      { ...options, gatewayId: "splat-gateway" },
    );
    await model.complete([], []);
    expect(seenOptions).toEqual({ gateway: { id: "splat-gateway" } });
  });
});

describe("StubModel", () => {
  it("summarizes after a tool result", async () => {
    const stub = new StubModel();
    const result = await stub.complete(
      [{ role: "tool", name: "search_bugs", content: '{"count":2}' }],
      [],
    );
    expect(result.kind).toBe("text");
  });

  it("proposes a search tool call for search-like messages", async () => {
    const stub = new StubModel();
    const result = await stub.complete(
      [{ role: "user", content: "search for login bugs" }],
      [{ name: "search_bugs", description: "", parameters: { type: "object", properties: {} } }],
    );
    expect(result).toEqual({ kind: "tool_calls", calls: [{ name: "search_bugs", arguments: { limit: 5 } }] });
  });
});
