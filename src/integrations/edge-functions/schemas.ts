/**
 * Runtime Zod schemas for Splat Edge Function payloads.
 *
 * These mirror the OpenAPI spec in README.md and the static types in
 * `./types.ts`. Use them in the typed client wrapper so every edge
 * function call validates both the outgoing request and the incoming
 * response before the UI consumes the data.
 */
import { z } from "zod";

// ---------- Shared primitives ----------

export const paddleEnvironmentSchema = z.enum(["sandbox", "live"]);

export const errorResponseSchema = z.object({
  error: z.string(),
});

// ---------- /get-paddle-price ----------

export const getPaddlePriceRequestSchema = z.object({
  priceId: z.string().trim().min(1).max(128),
  environment: paddleEnvironmentSchema,
});

export const getPaddlePriceResponseSchema = z.object({
  paddleId: z.string().trim().min(1),
});

// ---------- /update-subscription ----------

const baseUpdateFields = {
  environment: paddleEnvironmentSchema,
};

export const cancelSubscriptionRequestSchema = z.object({
  ...baseUpdateFields,
  action: z.literal("cancel"),
});

export const resumeSubscriptionRequestSchema = z.object({
  ...baseUpdateFields,
  action: z.literal("resume"),
});

export const changePlanRequestSchema = z.object({
  ...baseUpdateFields,
  action: z.literal("change_plan"),
  newPriceId: z.string().trim().min(1).max(128),
});

export const updateSubscriptionRequestSchema = z.discriminatedUnion("action", [
  cancelSubscriptionRequestSchema,
  resumeSubscriptionRequestSchema,
  changePlanRequestSchema,
]);

export const updateSubscriptionResponseSchema = z.object({
  ok: z.literal(true),
  scheduledChange: z
    .object({
      action: z.enum(["switch", "cancel", "pause", "resume"]),
      effectiveAt: z.string().datetime({ offset: true }),
    })
    .optional(),
});

// ---------- Registry ----------

export const edgeFunctionSchemas = {
  "get-paddle-price": {
    request: getPaddlePriceRequestSchema,
    response: getPaddlePriceResponseSchema,
  },
  "update-subscription": {
    request: updateSubscriptionRequestSchema,
    response: updateSubscriptionResponseSchema,
  },
} as const;

export type EdgeFunctionSchemaName = keyof typeof edgeFunctionSchemas;
