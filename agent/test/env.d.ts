/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as AppEnv } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// `cloudflare:test` types the test `env` as the global `Cloudflare.Env`.
// Augment it with our application bindings plus the injected test migrations so
// tests are fully typed against the real Env.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      // Optional so production Env (AppEnv) remains assignable to Cloudflare.Env.
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}
