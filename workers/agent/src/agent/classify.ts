/**
 * Deterministic intent classification.
 *
 * The intent is recorded for observability and steers the system prompt; it
 * never grants permissions. Tool exposure is decided solely by the runtime
 * `allowWrites` capability in the policy check.
 */
export type Intent = "read_query" | "write_request" | "general_chat";

const WRITE_PATTERNS: RegExp[] = [
  /\b(create|file|open|report|log)\b.{0,30}\b(bug|issue|ticket)\b/i,
  /\badd\b.{0,20}\bcomment\b/i,
  /\bcomment on\b/i,
  /\b(update|change|set|move)\b.{0,40}\bstatus\b/i,
  /\bmark\b.{0,30}\b(as|shipped|done|wont_fix|backlog|in.review|in.progress)\b/i,
  /\b(close|reopen|ship)\b.{0,30}\bSPL-\d+/i,
];

const READ_PATTERNS: RegExp[] = [
  /\b(what|which|who|when|how many|how)\b/i,
  /\b(show|list|find|search|look up|summari[sz]e|tell me about|details? (of|on|for))\b/i,
  /\bSPL-\d+/i,
  /\b(stats|statistics|overview|breakdown)\b/i,
  /\?\s*$/,
];

export function classifyIntent(message: string): Intent {
  if (WRITE_PATTERNS.some((p) => p.test(message))) return "write_request";
  if (READ_PATTERNS.some((p) => p.test(message))) return "read_query";
  return "general_chat";
}
