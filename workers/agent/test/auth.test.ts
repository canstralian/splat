import { describe, expect, it } from "vitest";
import { authenticateRequest, extractBearerToken } from "../src/auth";
import { AgentError } from "../src/errors";

const config = {
  supabaseUrl: "https://supabase.test",
  publishableKey: "anon-key",
  timeoutMs: 1000,
};

function requestWithAuth(header?: string): Request {
  return new Request("https://agent.test/api/agent/sessions/s1", {
    headers: header ? { Authorization: header } : {},
  });
}

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

describe("extractBearerToken", () => {
  it("rejects a missing Authorization header", () => {
    expect(() => extractBearerToken(requestWithAuth())).toThrowError(AgentError);
    try {
      extractBearerToken(requestWithAuth());
    } catch (e) {
      expect((e as AgentError).code).toBe("unauthorized");
    }
  });

  it("rejects a malformed header", () => {
    expect(() => extractBearerToken(requestWithAuth("Token abc"))).toThrowError(AgentError);
  });

  it("extracts the bearer token", () => {
    expect(extractBearerToken(requestWithAuth("Bearer my-jwt"))).toBe("my-jwt");
  });
});

describe("authenticateRequest", () => {
  it("returns the verified identity and token for a valid session", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ id: "user-42", email: "a@b.c" }), { status: 200 });
    }) as typeof fetch;

    const caller = await authenticateRequest(requestWithAuth("Bearer my-jwt"), { ...config, fetchFn });

    expect(caller.identity).toEqual({ userId: "user-42", email: "a@b.c" });
    expect(caller.accessToken).toBe("my-jwt");
    expect(seenUrl).toBe("https://supabase.test/auth/v1/user");
    expect(seenHeaders.apikey).toBe("anon-key");
    expect(seenHeaders.Authorization).toBe("Bearer my-jwt");
  });

  it("maps a 401 from Supabase to unauthorized", async () => {
    await expect(
      authenticateRequest(requestWithAuth("Bearer expired"), { ...config, fetchFn: fetchReturning(401, {}) }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("maps a 5xx from Supabase to upstream_error, not unauthorized", async () => {
    await expect(
      authenticateRequest(requestWithAuth("Bearer ok"), { ...config, fetchFn: fetchReturning(503, {}) }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("rejects malformed identity payloads", async () => {
    await expect(
      authenticateRequest(requestWithAuth("Bearer ok"), { ...config, fetchFn: fetchReturning(200, { nope: true }) }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("maps network failures to upstream_error", async () => {
    const fetchFn = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    await expect(authenticateRequest(requestWithAuth("Bearer ok"), { ...config, fetchFn })).rejects.toMatchObject({
      code: "upstream_error",
    });
  });
});
