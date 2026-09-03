/**
 * Structured logging for Workers Logs.
 *
 * Every event is a single JSON line. Free-form strings are truncated so logs
 * stay useful without recording entire conversations, and access tokens are
 * never passed in (enforced by convention: callers log ids and metadata only).
 *
 * Error-severity events go through `console.error` so they appear at the
 * correct level in the Workers Observability dashboard.
 */
const MAX_STRING_LENGTH = 256;

const ERROR_EVENTS = new Set([
  "turn_failed",
  "request_failed",
  "tool_call_error",
  "model_retry",
]);

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export function truncateForLog(value: string, max = MAX_STRING_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max}]`;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return truncateForLog(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

export const logEvent: LogFn = (event, fields = {}) => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...(sanitize(fields) as Record<string, unknown>),
  });
  if (ERROR_EVENTS.has(event) || fields.status === "error" || typeof fields.errorCode === "string") {
    console.error(line);
    return;
  }
  console.log(line);
};
