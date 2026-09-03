import { AgentSession } from "./agent/session";
import { handleAgentRequest } from "./router";

export { AgentSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleAgentRequest(request, env, { ctx });
  },
} satisfies ExportedHandler<Env>;
