/**
 * Splatt → Agent runtime client.
 *
 * A small, framework-agnostic client the Splatt SPA uses to call the Cloudflare
 * Workers agent. It sends the user's Supabase access token as a bearer token so
 * the agent authenticates and authorizes the request as that user (the agent
 * reuses Splatt's existing Supabase auth). It never handles Cloudflare or model
 * secrets.
 */

export type AgentRunStatus =
  | "completed"
  | "awaiting_approval"
  | "denied"
  | "failed"
  | "pending"
  | "running";

export interface AgentRunResult {
  runId: string;
  status: AgentRunStatus;
  outcome: string | null;
  error: string | null;
  toolCallCount: number;
  pendingApproval?: string;
}

export interface RunAgentOptions {
  /** Base URL of the deployed agent Worker, e.g. https://splat-agent-runtime.workers.dev */
  baseUrl: string;
  /** The user's Supabase access token (from `supabase.auth.getSession()`). */
  accessToken: string;
  /** Stable conversation/session id (scoped to the user by the agent). */
  sessionId: string;
  message: string;
  /** Capabilities the user has explicitly approved for this run, if any. */
  approvals?: string[];
  signal?: AbortSignal;
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class AgentClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

/** Send a message to the agent and return the run outcome. */
export async function runAgentTask(options: RunAgentOptions): Promise<AgentRunResult> {
  const { baseUrl, accessToken, sessionId, message } = options;
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!accessToken) throw new Error("accessToken is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!message || !message.trim()) throw new Error("message is required");

  const doFetch = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/messages`;

  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      message,
      ...(options.approvals ? { approvals: options.approvals } : {}),
    }),
    signal: options.signal,
  });

  if (res.status === 401) {
    throw new AgentClientError(401, "Not authenticated (expired or invalid session)");
  }
  if (!res.ok && res.status !== 202 && res.status !== 403 && res.status !== 422) {
    throw new AgentClientError(res.status, `Agent request failed with HTTP ${res.status}`);
  }

  const data = (await res.json()) as { run?: AgentRunResult; error?: string };
  if (!data.run) {
    throw new AgentClientError(res.status, data.error ?? "Malformed agent response");
  }
  return data.run;
}

/** Health check for the agent Worker. */
export async function checkAgentHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
