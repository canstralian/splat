import { cn } from "@/lib/utils";
import type { Enums } from "@/integrations/supabase/types";

const statusConfig: Record<Enums<"bug_status">, { label: string; dotClass: string }> = {
  new: { label: "New", dotClass: "bg-info" },
  assigned: { label: "Assigned", dotClass: "bg-primary" },
  in_progress: { label: "In Progress", dotClass: "bg-warning" },
  testing: { label: "Testing", dotClass: "bg-[hsl(280,60%,55%)]" },
  resolved: { label: "Resolved", dotClass: "bg-success" },
  closed: { label: "Closed", dotClass: "bg-muted-foreground" },
};

export function StatusBadge({ status }: { status: Enums<"bug_status"> }) {
  const config = statusConfig[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full shrink-0", config.dotClass)} />
      {config.label}
    </span>
  );
}
