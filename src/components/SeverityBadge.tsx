import { cn } from "@/lib/utils";
import type { Enums } from "@/integrations/supabase/types";

const severityConfig: Record<Enums<"bug_severity">, { label: string; className: string }> = {
  blocker: { label: "Blocker", className: "text-severity-critical" },
  major: { label: "Major", className: "text-severity-high" },
  minor: { label: "Minor", className: "text-severity-medium" },
  polish: { label: "Polish", className: "text-severity-low" },
};

export function SeverityBadge({ severity }: { severity: Enums<"bug_severity"> }) {
  const config = severityConfig[severity];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", config.className)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <rect x="2" y="10" width="3" height="4" rx="0.5" opacity={severity === "polish" ? 1 : 0.3} />
        <rect x="6.5" y="7" width="3" height="7" rx="0.5" opacity={severity === "minor" || severity === "major" || severity === "blocker" ? 1 : 0.3} />
        <rect x="11" y="4" width="3" height="10" rx="0.5" opacity={severity === "major" || severity === "blocker" ? 1 : 0.3} />
      </svg>
      {config.label}
    </span>
  );
}
