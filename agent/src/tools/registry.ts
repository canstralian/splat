import { ToolNotFoundError } from "../errors";
import type { Tool } from "./types";

/**
 * Immutable-by-convention registry of the tools an agent may use. Tools must be
 * registered up front; there is no dynamic/arbitrary tool loading.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** A compact catalogue the model can be shown (no executable references). */
  describe(): Array<{
    name: string;
    description: string;
    capability: string;
    effect: string;
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      capability: t.requiredCapability,
      effect: t.effect,
    }));
  }
}
