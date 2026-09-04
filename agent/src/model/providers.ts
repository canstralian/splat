import { ModelError } from "../errors";
import type { Env } from "../env";
import {
  fingerprintPrompt,
  type ModelCompletion,
  type ModelProvider,
  type ProviderMessage,
} from "./provider";

/** Workers AI provider. Reads the model binding; no secrets in prompts. */
export class WorkersAiProvider implements ModelProvider {
  readonly name = "workers-ai";
  readonly model: string;
  constructor(
    private readonly ai: Ai,
    model: string,
  ) {
    this.model = model;
  }

  async complete(messages: ProviderMessage[]): Promise<ModelCompletion> {
    try {
      // The Workers AI text-generation contract accepts { messages }.
      const result = (await this.ai.run(this.model as keyof AiModels, {
        messages,
      } as never)) as { response?: string };
      const text = typeof result?.response === "string" ? result.response : "";
      if (!text) {
        throw new ModelError("Workers AI returned an empty response", {
          model: this.model,
        });
      }
      return {
        text,
        provider: this.name,
        model: this.model,
        promptFingerprint: fingerprintPrompt(messages),
      };
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw new ModelError(`Workers AI call failed: ${asMessage(err)}`, {
        model: this.model,
      });
    }
  }
}

/** OpenAI-compatible chat completions provider. API key stays in this class. */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = "openai";
  readonly model: string;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async complete(messages: ProviderMessage[]): Promise<ModelCompletion> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });
    } catch (err) {
      throw new ModelError(`Inference request failed: ${asMessage(err)}`, {
        model: this.model,
      });
    }
    if (!res.ok) {
      throw new ModelError(`Inference returned HTTP ${res.status}`, {
        model: this.model,
        status: res.status,
      });
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new ModelError("Inference returned an empty completion", {
        model: this.model,
      });
    }
    return {
      text,
      provider: this.name,
      model: this.model,
      promptFingerprint: fingerprintPrompt(messages),
      usage: data.usage,
    };
  }
}

/**
 * Deterministic provider for tests and replay. Returns a pre-baked sequence of
 * completions. Enabled ONLY when ALLOW_SCRIPTED_PROVIDER === "true".
 *
 * Special sentinel: a response equal to "__THROW__" simulates a provider error.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly model = "scripted-deterministic";
  private index = 0;
  private readonly responses: string[];

  constructor(script: unknown) {
    this.responses = normalizeScript(script);
  }

  async complete(messages: ProviderMessage[]): Promise<ModelCompletion> {
    if (this.index >= this.responses.length) {
      throw new ModelError("Scripted model exhausted", {
        served: this.index,
      });
    }
    const next = this.responses[this.index++];
    if (next === "__THROW__") {
      throw new ModelError("Scripted model failure", { index: this.index - 1 });
    }
    return {
      text: next,
      provider: this.name,
      model: this.model,
      promptFingerprint: fingerprintPrompt(messages),
    };
  }
}

function normalizeScript(script: unknown): string[] {
  if (!Array.isArray(script)) {
    throw new ModelError("modelScript must be an array of decisions");
  }
  return script.map((item) =>
    typeof item === "string" ? item : JSON.stringify(item),
  );
}

/**
 * Select the provider for a Run. The scripted provider requires an explicit
 * environment opt-in so production input can never drive deterministic scripts.
 */
export function createModelProvider(
  env: Env,
  options: { modelScript?: unknown } = {},
): ModelProvider {
  const provider = env.MODEL_PROVIDER ?? "workers-ai";
  const model = env.MODEL_ID ?? "@cf/meta/llama-3.1-8b-instruct";

  if (provider === "scripted") {
    if (env.ALLOW_SCRIPTED_PROVIDER !== "true") {
      throw new ModelError(
        "Scripted provider is disabled (ALLOW_SCRIPTED_PROVIDER != true)",
      );
    }
    return new ScriptedProvider(options.modelScript);
  }

  if (provider === "openai") {
    if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY) {
      throw new ModelError(
        "OpenAI-compatible provider requires MODEL_BASE_URL and MODEL_API_KEY",
      );
    }
    return new OpenAiCompatibleProvider(
      env.MODEL_BASE_URL,
      env.MODEL_API_KEY,
      model,
    );
  }

  return new WorkersAiProvider(env.AI, model);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
