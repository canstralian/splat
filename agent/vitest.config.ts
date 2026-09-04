import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  // Load D1 migrations at config time so tests can apply them to the isolated
  // per-test D1 instance (see test/apply-migrations.ts). Path is relative to the
  // project root (this directory), which is Vitest's working directory.
  const migrations = await readD1Migrations("migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          // Test-only binding overrides. The scripted (deterministic) model
          // provider is enabled ONLY here; production keeps it disabled.
          bindings: {
            TEST_MIGRATIONS: migrations,
            MODEL_PROVIDER: "scripted",
            ALLOW_SCRIPTED_PROVIDER: "true",
            API_AUTH_TOKEN: "test-token",
            AGENT_ID: "splat-orchestrator",
            AGENT_VERSION: "0.1.0-test",
            MAX_TOOL_CALLS: "8",
            MAX_WALL_CLOCK_MS: "60000",
            TOOL_DEFAULT_TIMEOUT_MS: "10000",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
