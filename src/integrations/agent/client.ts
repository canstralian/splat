/**
 * Type-safe client for the Splat AI assistant (Cloudflare Worker at
 * `VITE_AGENT_URL`).
 *
 * Follows the same conventions as `src/integrations/edge-functions/client.ts`:
 * requests carry the caller's Supabase session JWT, and every response is
 * validated against a Zod schema before the UI consumes it.
 */
import { supabase } from "@/integrations/supabase/client";
import type { z } from "zod";
import {
  agentErrorEnvelopeSchema,
  agentMessageResponseSchema,
  agentResetResponseSchema,
  agentSessionStateSchema,
} from "./schemas";
import type { AgentMessageResponse, AgentSessionState } from "./types";

export class AgentApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export function getAgentBaseUrl(): string | null {
  const url = import.meta.env.VITE_AGENT_URL as string | undefined;
  if (!url || url.trim().length === 0) return null;
  return url.trim().replace(/\/$/, "");
}

export function isAgentConfigured(): boolean {
  return getAgentBaseUrl() !== null;
}

async function getAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    throw new AgentApiError("unauthorized", "You must be signed in to use the assistant", error);
  }
  return data.session.access_token;
}

async function agentFetch<T>(path: string, init: RequestInit, schema: z.ZodTypeAny): Promise<T> {
  const baseUrl = getAgentBaseUrl();
  if (!baseUrl) {
    throw new AgentApiError("not_configured", "The assistant service is not configured");
  }
  const token = await getAccessToken();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new AgentApiError("network_error", "Could not reach the assistant service", cause);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Handled below via status/schema checks.
  }

  const errorEnvelope = agentErrorEnvelopeSchema.safeParse(body);
  if (errorEnvelope.success) {
    throw new AgentApiError(errorEnvelope.data.error.code, errorEnvelope.data.error.message);
  }
  if (!response.ok) {
    throw new AgentApiError("http_error", `Assistant request failed (${response.status})`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AgentApiError("invalid_response", "The assistant returned malformed data", parsed.error);
  }
  // Cast after successful validation, mirroring the edge-functions client
  // (zod inference degrades under the app's non-strict tsconfig).
  return parsed.data as T;
}

export async function sendAgentMessage(
  sessionId: string,
  message: string,
  allowWrites: boolean,
): Promise<AgentMessageResponse> {
  return agentFetch<AgentMessageResponse>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
    { method: "POST", body: JSON.stringify({ message, allowWrites }) },
    agentMessageResponseSchema,
  );
}

export async function fetchAgentSession(sessionId: string): Promise<AgentSessionState> {
  return agentFetch<AgentSessionState>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    agentSessionStateSchema,
  );
}

export async function resetAgentSession(sessionId: string): Promise<void> {
  await agentFetch<Record<string, never>>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    agentResetResponseSchema,
  );
}
