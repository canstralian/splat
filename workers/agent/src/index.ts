import { AgentSession } from "./agent/session";
import type { Env } from "./env";
import { handleAgentRequest } from "./router";

export { AgentSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleAgentRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
