import type { Intent } from "../model/decision";

/**
 * Deterministic, rule-based intent classifier. Runs BEFORE model reasoning so
 * the task category is derived in-system (INFERRED) rather than trusting the
 * model. This keeps the classification reproducible and auditable.
 */
export function classifyIntent(message: string): Intent {
  const text = message.toLowerCase();

  const rules: Array<{ intent: string; test: RegExp; confidence: number }> = [
    { intent: "memory_write", test: /\b(remember|save|store|note that)\b/, confidence: 0.8 },
    { intent: "memory_read", test: /\b(recall|what did|retrieve|remind me)\b/, confidence: 0.8 },
    { intent: "compute", test: /\b(add|sum|subtract|multiply|divide|calculate|times|plus|minus)\b|\d\s*[-+*/]\s*\d/, confidence: 0.75 },
    { intent: "config_lookup", test: /\b(config|setting|feature flag|configuration)\b/, confidence: 0.7 },
    { intent: "echo", test: /\b(echo|repeat|say)\b/, confidence: 0.6 },
  ];

  for (const rule of rules) {
    if (rule.test.test(text)) {
      return { intent: rule.intent, confidence: rule.confidence };
    }
  }
  return { intent: "general", confidence: 0.4 };
}
