import { z } from "zod";

/**
 * The strict contract the model MUST return at each reasoning step. Model output
 * is untrusted: it is parsed and validated against this schema before use. Any
 * deviation is a {@link MalformedModelOutputError}, never a silent fallback.
 *
 * - action="tool": request execution of a named tool with arguments.
 * - action="final": produce the final answer and end the Run.
 */
export const modelDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tool"),
    /** Short natural-language reasoning (MODEL_GENERATED, recorded as evidence). */
    reasoning: z.string().max(2000).optional().default(""),
    tool: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    action: z.literal("final"),
    reasoning: z.string().max(2000).optional().default(""),
    content: z.string().max(20000),
  }),
]);

export type ModelDecision = z.infer<typeof modelDecisionSchema>;

/** Intent/task classification returned before the reasoning loop. */
export const intentSchema = z.object({
  intent: z.string().min(1).max(128),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type Intent = z.infer<typeof intentSchema>;

/**
 * Parse raw model text into a validated decision. Accepts either a raw JSON
 * object or JSON wrapped in a ```json fenced block (common LLM behaviour).
 */
export function parseModelDecision(raw: string): ModelDecision {
  const json = extractJson(raw);
  return modelDecisionSchema.parse(json);
}

export function parseIntent(raw: string): Intent {
  const json = extractJson(raw);
  return intentSchema.parse(json);
}

/** Extract a JSON value from model text. Throws SyntaxError if none is found. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip a fenced code block if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}
