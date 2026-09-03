import { z } from "zod";
import type { SupabaseRestClient } from "../../supabase/rest";

/** Enums mirroring Splat's Postgres enums (see src/integrations/supabase/types.ts). */
export const BUG_STATUSES = ["backlog", "in_progress", "in_review", "shipped", "wont_fix"] as const;
export const BUG_SEVERITIES = ["blocker", "major", "minor", "polish"] as const;
export const BUG_CATEGORIES = ["ui", "logic", "performance", "infra", "content"] as const;

export const bugStatusSchema = z.enum(BUG_STATUSES);
export const bugSeveritySchema = z.enum(BUG_SEVERITIES);
export const bugCategorySchema = z.enum(BUG_CATEGORIES);

export const trackingIdSchema = z
  .string()
  .trim()
  .regex(/^SPL-\d{1,10}$/i, "Expected a tracking id like SPL-00001")
  .transform((v) => v.toUpperCase());

/** Row shape returned by PostgREST for the columns the tools select. */
export interface BugRow {
  id: string;
  tracking_id: string;
  title: string;
  description: string;
  status: (typeof BUG_STATUSES)[number];
  severity: (typeof BUG_SEVERITIES)[number];
  category: (typeof BUG_CATEGORIES)[number];
  steps_to_reproduce: string | null;
  expected_behavior: string | null;
  actual_behavior: string | null;
  environment: string | null;
  reporter_id: string;
  assignee_id: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export const bugSummarySchema = z.object({
  trackingId: z.string(),
  title: z.string(),
  status: bugStatusSchema,
  severity: bugSeveritySchema,
  category: bugCategorySchema,
  createdAt: z.string(),
});

export function toBugSummary(row: Pick<BugRow, "tracking_id" | "title" | "status" | "severity" | "category" | "created_at">) {
  return {
    trackingId: row.tracking_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    category: row.category,
    createdAt: row.created_at,
  };
}

/**
 * PostgREST `or=(...)` filters break on commas/parens inside patterns, so
 * strip characters that would change the filter grammar before building an
 * ilike pattern from free text.
 */
export function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

export async function findBugByTrackingId(
  supabase: SupabaseRestClient,
  trackingId: string,
  signal: AbortSignal,
): Promise<BugRow | null> {
  const rows = await supabase.select<BugRow>(
    "bugs",
    { select: "*", tracking_id: `eq.${trackingId}`, limit: "1" },
    { signal },
  );
  return rows[0] ?? null;
}
