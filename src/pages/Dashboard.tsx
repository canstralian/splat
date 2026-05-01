import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/AppLayout";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SeverityBadge } from "@/components/SeverityBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Bug, Plus, Search, LayoutGrid, List, Loader2 } from "lucide-react";
import type { Tables, Enums } from "@/integrations/supabase/types";
import { Constants } from "@/integrations/supabase/types";
import { formatDistanceToNow } from "date-fns";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { NeonPatternDefs } from "@/components/NeonPatternDefs";
import { useNeonCharts } from "@/hooks/use-neon-charts";

const STATUS_COLORS: Record<string, string> = {
  new: "hsl(var(--info))",
  assigned: "hsl(var(--primary))",
  in_progress: "hsl(var(--warning))",
  testing: "hsl(280, 60%, 55%)",
  resolved: "hsl(var(--success))",
  closed: "hsl(var(--muted-foreground))",
};

const STATUS_LABELS: Record<string, string> = {
  new: "New", assigned: "Assigned", in_progress: "In Progress",
  testing: "Testing", resolved: "Resolved", closed: "Closed",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "hsl(var(--severity-critical))", high: "hsl(var(--severity-high))",
  medium: "hsl(var(--severity-medium))", low: "hsl(var(--severity-low))",
};
const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical", high: "High", medium: "Medium", low: "Low",
};

type BugRow = Tables<"bugs">;
const statusColumns: Enums<"bug_status">[] = ["new", "assigned", "in_progress", "testing", "resolved", "closed"];

export default function Dashboard() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [bugs, setBugs] = useState<BugRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"kanban" | "table">("table");
  const { getFill } = useNeonCharts();

  useEffect(() => {
    const fetchBugs = async () => {
      const { data } = await supabase.from("bugs").select("*").order("created_at", { ascending: false });
      setBugs(data || []);
      setLoading(false);
    };
    fetchBugs();
    const channel = supabase
      .channel("bugs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "bugs" }, () => fetchBugs())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const filtered = bugs.filter(b =>
    b.title.toLowerCase().includes(search.toLowerCase()) ||
    b.tracking_id.toLowerCase().includes(search.toLowerCase())
  );

  const counts = {
    total: bugs.length,
    critical: bugs.filter(b => b.severity === "critical").length,
    open: bugs.filter(b => !["resolved", "closed"].includes(b.status)).length,
    resolved: bugs.filter(b => b.status === "resolved" || b.status === "closed").length,
  };

  const statusData = useMemo(() => {
    const c: Record<string, number> = {};
    bugs.forEach(b => { c[b.status] = (c[b.status] || 0) + 1; });
    return Object.entries(STATUS_LABELS).map(([key, label]) => ({
      status: label, count: c[key] || 0, fill: STATUS_COLORS[key],
    }));
  }, [bugs]);

  const statusChartConfig: ChartConfig = Object.fromEntries(
    Object.entries(STATUS_LABELS).map(([k, label]) => [k, { label, color: STATUS_COLORS[k] }])
  );

  const severityData = useMemo(() => {
    const c: Record<string, number> = {};
    bugs.forEach(b => { c[b.severity] = (c[b.severity] || 0) + 1; });
    return Object.entries(SEVERITY_LABELS).map(([key, label]) => ({
      name: label, value: c[key] || 0, fill: SEVERITY_COLORS[key],
    }));
  }, [bugs]);

  const severityChartConfig: ChartConfig = Object.fromEntries(
    Object.entries(SEVERITY_LABELS).map(([k, label]) => [k, { label, color: SEVERITY_COLORS[k] }])
  );

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 md:px-6 h-11 border-b border-border shrink-0">
          <h1 className="text-[13px] font-medium">Dashboard</h1>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" className="h-7 text-[12px] gap-1.5">
              <Link to="/bugs/new">
                <Plus className="h-3.5 w-3.5" /> Report bug
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <div className="p-4 md:p-6 space-y-6 max-w-[1400px]">
            {/* Stats row */}
            <NeonPatternDefs colors={[...Object.values(STATUS_COLORS), ...Object.values(SEVERITY_COLORS)]} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border rounded-md overflow-hidden">
              {[
                { label: "Total bugs", value: counts.total },
                { label: "Critical", value: counts.critical },
                { label: "Open", value: counts.open },
                { label: "Resolved", value: counts.resolved },
              ].map((stat) => (
                <div key={stat.label} className="bg-background p-4">
                  <p className="text-[12px] text-muted-foreground">{stat.label}</p>
                  <p className="text-2xl font-medium mt-1">{stat.value}</p>
                </div>
              ))}
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border rounded-md overflow-hidden">
              <div className="bg-background p-4">
                <p className="text-[13px] font-medium mb-1">Bugs by status</p>
                <p className="text-[12px] text-muted-foreground mb-4">Distribution across workflow stages</p>
                <ChartContainer config={statusChartConfig} className="h-[200px] w-full">
                  <BarChart data={statusData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="status" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" radius={0}>
                      {statusData.map((entry, i) => <Cell key={i} {...getFill(entry.fill)} />)}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </div>
              <div className="bg-background p-4">
                <p className="text-[13px] font-medium mb-1">Severity distribution</p>
                <p className="text-[12px] text-muted-foreground mb-4">Breakdown by severity level</p>
                <ChartContainer config={severityChartConfig} className="h-[200px] w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Pie data={severityData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2}>
                      {severityData.map((entry, i) => <Cell key={i} {...getFill(entry.fill)} />)}
                    </Pie>
                  </PieChart>
                </ChartContainer>
              </div>
            </div>

            {/* Search & View Toggle */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search bugs..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 text-[13px] bg-transparent"
                />
              </div>
              <div className="flex items-center border rounded-md">
                <Button variant={view === "table" ? "secondary" : "ghost"} size="sm" onClick={() => setView("table")} className="h-8 w-8 p-0">
                  <List className="h-3.5 w-3.5" />
                </Button>
                <Button variant={view === "kanban" ? "secondary" : "ghost"} size="sm" onClick={() => setView("kanban")} className="h-8 w-8 p-0">
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Table View */}
            {view === "table" && (
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left font-medium text-muted-foreground px-3 py-2">ID</th>
                      <th className="text-left font-medium text-muted-foreground px-3 py-2">Title</th>
                      <th className="text-left font-medium text-muted-foreground px-3 py-2">Status</th>
                      <th className="text-left font-medium text-muted-foreground px-3 py-2">Priority</th>
                      <th className="text-left font-medium text-muted-foreground px-3 py-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center py-8 text-muted-foreground text-[13px]">No bugs found</td>
                      </tr>
                    ) : (
                      filtered.map((bug) => (
                        <tr
                          key={bug.id}
                          className="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => navigate(`/bugs/${bug.id}`)}
                        >
                          <td className="px-3 py-2 text-muted-foreground font-mono text-[12px]">{bug.tracking_id}</td>
                          <td className="px-3 py-2 font-medium">{bug.title}</td>
                          <td className="px-3 py-2"><StatusBadge status={bug.status} /></td>
                          <td className="px-3 py-2"><SeverityBadge severity={bug.severity} /></td>
                          <td className="px-3 py-2 text-muted-foreground text-[12px] whitespace-nowrap">
                            {formatDistanceToNow(new Date(bug.created_at), { addSuffix: true })}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Kanban View */}
            {view === "kanban" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
                {statusColumns.map((status) => {
                  const columnBugs = filtered.filter(b => b.status === status);
                  return (
                    <div key={status} className="space-y-1.5">
                      <div className="flex items-center justify-between px-1">
                        <StatusBadge status={status} />
                        <span className="text-[11px] text-muted-foreground">{columnBugs.length}</span>
                      </div>
                      <div className="space-y-1">
                        {columnBugs.map((bug) => (
                          <Link key={bug.id} to={`/bugs/${bug.id}`}>
                            <div className="border border-border rounded-md p-2.5 hover:bg-muted/30 transition-colors cursor-pointer space-y-1.5">
                              <p className="text-[11px] text-muted-foreground font-mono">{bug.tracking_id}</p>
                              <p className="text-[13px] font-medium leading-snug line-clamp-2">{bug.title}</p>
                              <div className="flex items-center justify-between">
                                <SeverityBadge severity={bug.severity} />
                                <span className="text-[10px] text-muted-foreground">
                                  {formatDistanceToNow(new Date(bug.created_at), { addSuffix: true })}
                                </span>
                              </div>
                            </div>
                          </Link>
                        ))}
                        {columnBugs.length === 0 && (
                          <div className="border border-dashed border-border rounded-md p-3 text-center">
                            <p className="text-[11px] text-muted-foreground">No bugs</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
