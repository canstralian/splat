import { AgentError } from "../errors";

/**
 * Minimal PostgREST client scoped to a single user's Supabase JWT.
 *
 * This is the only path through which agent tools touch Splat data. Because
 * every request carries the user's own token, Postgres RLS enforces exactly
 * the same permissions the user has in the Splat UI — the agent can never
 * read or write anything the user could not. No service-role key exists in
 * this worker.
 */
export interface SupabaseRestConfig {
  url: string;
  publishableKey: string;
  accessToken: string;
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export class SupabaseRestClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: SupabaseRestConfig) {
    // Wrap the global fetch: calling it via `this.fetchFn` would otherwise
    // rebind `this` and trigger workerd's illegal-invocation guard.
    this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.config.publishableKey,
      Authorization: `Bearer ${this.config.accessToken}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit, options?: RequestOptions): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.url}${path}`, {
        ...init,
        signal: options?.signal ?? null,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new AgentError("upstream_error", "Data service is unavailable", {
        cause,
        details: { cause: cause instanceof Error ? cause.message : String(cause) },
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new AgentError("unauthorized", "Session is no longer valid");
      }
      if (response.status === 403) {
        throw new AgentError("forbidden", "You do not have permission to perform this action", {
          details: { status: response.status, body: text.slice(0, 500) },
        });
      }
      throw new AgentError("upstream_error", "Data service returned an error", {
        details: { status: response.status, body: text.slice(0, 500) },
      });
    }
    return response;
  }

  async select<T>(table: string, params: Record<string, string>, options?: RequestOptions): Promise<T[]> {
    const qs = new URLSearchParams(params).toString();
    const response = await this.request(`/rest/v1/${table}?${qs}`, { method: "GET", headers: this.headers() }, options);
    return (await response.json()) as T[];
  }

  async insert<T>(table: string, row: Record<string, unknown>, options?: RequestOptions): Promise<T[]> {
    const response = await this.request(
      `/rest/v1/${table}`,
      {
        method: "POST",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify(row),
      },
      options,
    );
    return (await response.json()) as T[];
  }

  async update<T>(
    table: string,
    filters: Record<string, string>,
    patch: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T[]> {
    const qs = new URLSearchParams(filters).toString();
    const response = await this.request(
      `/rest/v1/${table}?${qs}`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify(patch),
      },
      options,
    );
    return (await response.json()) as T[];
  }

  async rpc<T>(name: string, args: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    const response = await this.request(
      `/rest/v1/rpc/${name}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(args) },
      options,
    );
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  }
}

export type SupabaseClientFactory = (accessToken: string) => SupabaseRestClient;
