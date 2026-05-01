import { cn } from "@/lib/utils";
import type { Enums } from "@/integrations/supabase/types";

const severityConfig: Record<Enums<"bug_severity">, { label: string; className: string }> = {
  critical: { label: "Critical", className: "text-severity-critical" },
  high: { label: "High", className: "text-severity-high" },
  medium: { label: "Medium", className: "text-severity-medium" },
  low: { label: "Low", className: "text-severity-low" },
};

export function SeverityBadge({ severity }: { severity: Enums<"bug_severity"> }) {
  const config = severityConfig[severity];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", config.className)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <rect x="2" y="10" width="3" height="4" rx="0.5" opacity={severity === "low" ? 1 : 0.3} />
        <rect x="6.5" y="7" width="3" height="7" rx="0.5" opacity={severity === "medium" || severity === "high" || severity === "critical" ? 1 : 0.3} />
        <rect x="11" y="4" width="3" height="10" rx="0.5" opacity={severity === "high" || severity === "critical" ? 1 : 0.3} />
      </svg>
      {config.label}
    </span>
  );
}
