/**
 * Type-safe wrapper around `supabase.functions.invoke` for Splat edge functions.
 *
 * Validates both request and response payloads against Zod schemas derived
 * from the OpenAPI spec in README.md before returning to the caller, so the
 * UI never updates state from a malformed edge function response.
 */
import { supabase } from "@/integrations/supabase/client";
import { z } from "zod";
import type { EdgeFunctionContract, EdgeFunctionName } from "./types";
import { edgeFunctionSchemas, errorResponseSchema } from "./schemas";

export class EdgeFunctionError extends Error {
  constructor(
    public readonly functionName: EdgeFunctionName,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EdgeFunctionError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export async function invokeEdgeFunction<K extends EdgeFunctionName>(
  name: K,
  body: EdgeFunctionContract[K]["request"],
): Promise<EdgeFunctionContract[K]["response"]> {
  const { request: requestSchema, response: responseSchema } = edgeFunctionSchemas[name];

  // 1. Validate the outgoing payload so we never send malformed data.
  const parsedBody = requestSchema.safeParse(body);
  if (!parsedBody.success) {
    throw new EdgeFunctionError(
      name,
      `Invalid request payload: ${formatZodError(parsedBody.error)}`,
      parsedBody.error,
    );
  }

  const { data, error } = await supabase.functions.invoke(name, { body: parsedBody.data });
  if (error) {
    throw new EdgeFunctionError(name, error.message ?? "Edge function call failed", error);
  }

  // 2. If the function returned an error envelope, surface it.
  const errorEnvelope = errorResponseSchema.safeParse(data);
  if (errorEnvelope.success) {
    throw new EdgeFunctionError(name, errorEnvelope.data.error);
  }

  // 3. Validate the response shape before returning to the UI.
  const parsedResponse = responseSchema.safeParse(data);
  if (!parsedResponse.success) {
    throw new EdgeFunctionError(
      name,
      `Invalid response payload: ${formatZodError(parsedResponse.error)}`,
      parsedResponse.error,
    );
  }

  return parsedResponse.data as EdgeFunctionContract[K]["response"];
}
