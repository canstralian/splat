import { applyD1Migrations, env } from "cloudflare:test";

/**
 * Applies D1 migrations to the isolated per-test database before the suite runs.
 * `TEST_MIGRATIONS` is injected by vitest.config.ts via readD1Migrations().
 */
// TEST_MIGRATIONS is always injected by vitest.config.ts for the test env.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
