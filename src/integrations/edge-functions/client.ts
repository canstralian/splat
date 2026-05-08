/**
 * Type-safe wrapper around `supabase.functions.invoke` for Splat edge functions.
 *
 * The signatures are derived from the OpenAPI spec in README.md and the
 * shared types in `./types.ts`. Prefer this helper over calling
 * `supabase.functions.invoke` directly so requests stay in lockstep with
 * the documented contract.
 */
import { supabase } from "@/integrations/supabase/client";
import type {
  EdgeFunctionContract,
  EdgeFunctionName,
} from "./types";

export class EdgeFunctionError extends Error {
  constructor(public readonly functionName: EdgeFunctionName, message: string) {
    super(message);
    this.name = "EdgeFunctionError";
  }
}

export async function invokeEdgeFunction<K extends EdgeFunctionName>(
  name: K,
  body: EdgeFunctionContract[K]["request"],
): Promise<EdgeFunctionContract[K]["response"]> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    throw new EdgeFunctionError(name, error.message ?? "Edge function call failed");
  }
  if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
    throw new EdgeFunctionError(name, (data as { error: string }).error);
  }
  return data as EdgeFunctionContract[K]["response"];
}
