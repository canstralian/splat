import type { ConversationMessage } from "../types";

/**
 * Provider-agnostic inference interface. Implementations must NOT receive or
 * embed secrets in prompts; API keys stay inside the provider and are read from
 * bindings only.
 */
export interface ModelProvider {
  /** Stable identifier of the provider (recorded in evidence for replay). */
  readonly name: string;
  /** Model id/version (recorded in evidence for replay). */
  readonly model: string;

  /**
   * Produce a single completion for the given messages. Returns the raw text
   * plus provider/model identity used, so nondeterministic inference is
   * auditable and reconstructable.
   */
  complete(messages: ProviderMessage[]): Promise<ModelCompletion>;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ModelCompletion {
  /** Raw model text (MODEL_GENERATED, untrusted). */
  text: string;
  provider: string;
  model: string;
  /** Deterministic fingerprint of the prompt, for replay correlation. */
  promptFingerprint: string;
  /** Optional provider usage metadata. */
  usage?: Record<string, number>;
}

/** Convert internal conversation history into provider messages. */
export function toProviderMessages(
  system: string,
  history: ConversationMessage[],
): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "tool") {
      messages.push({
        role: "tool",
        content: `Tool ${m.toolName} result: ${m.content}`,
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

/** Stable, non-cryptographic fingerprint of a prompt (FNV-1a, hex). */
export function fingerprintPrompt(messages: ProviderMessage[]): string {
  const serialized = JSON.stringify(messages);
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
