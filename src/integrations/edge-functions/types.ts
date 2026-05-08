/**
 * Auto-derived TypeScript types for Splat Edge Functions.
 *
 * Source of truth: the OpenAPI 3.1 spec embedded in `README.md`
 * (section "OpenAPI specification"). Keep this file in sync whenever
 * the spec or edge function contracts change.
 *
 * Do NOT add runtime logic here — this module is types-only so it can
 * be imported by both the browser bundle and Deno edge functions.
 */

// ---------- Shared primitives ----------

export type PaddleEnvironment = "sandbox" | "live";

/** Generic error envelope returned by every edge function. */
export interface ErrorResponse {
  error: string;
}

// ---------- /get-paddle-price ----------

export interface GetPaddlePriceRequest {
  /** Human-readable Paddle `external_id`, e.g. `splat_pro_monthly`. */
  priceId: string;
  environment: PaddleEnvironment;
}

export interface GetPaddlePriceResponse {
  /** Internal Paddle price ID, e.g. `pri_01h1vjes1y163xfj1rh1tkfb65`. */
  paddleId: string;
}

// ---------- /update-subscription ----------

export type UpdateSubscriptionAction = "cancel" | "resume" | "change_plan";

export interface UpdateSubscriptionBaseRequest {
  action: UpdateSubscriptionAction;
  environment: PaddleEnvironment;
}

export interface CancelSubscriptionRequest extends UpdateSubscriptionBaseRequest {
  action: "cancel";
}

export interface ResumeSubscriptionRequest extends UpdateSubscriptionBaseRequest {
  action: "resume";
}

export interface ChangePlanRequest extends UpdateSubscriptionBaseRequest {
  action: "change_plan";
  /** Human-readable Paddle `external_id` of the new price. */
  newPriceId: string;
}

export type UpdateSubscriptionRequest =
  | CancelSubscriptionRequest
  | ResumeSubscriptionRequest
  | ChangePlanRequest;

export interface UpdateSubscriptionResponse {
  ok: true;
  scheduledChange?: {
    action: "switch" | "cancel" | "pause" | "resume";
    /** ISO 8601 timestamp the change becomes effective. */
    effectiveAt: string;
  };
}

// ---------- /payments-webhook ----------

export type PaddleWebhookEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.canceled"
  | "transaction.completed"
  | "transaction.updated";

export interface PaddleWebhookEvent {
  event_id: string;
  event_type: PaddleWebhookEventType;
  occurred_at: string;
  data: Record<string, unknown>;
}

// ---------- Edge function registry ----------

/** Maps function name → (request, response) pair for type-safe invocation. */
export interface EdgeFunctionContract {
  "get-paddle-price": {
    request: GetPaddlePriceRequest;
    response: GetPaddlePriceResponse;
  };
  "update-subscription": {
    request: UpdateSubscriptionRequest;
    response: UpdateSubscriptionResponse;
  };
}

export type EdgeFunctionName = keyof EdgeFunctionContract;
