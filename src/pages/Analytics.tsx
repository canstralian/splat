import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { format, subDays, parseISO, startOfDay } from "date-fns";
import type { Tables } from "@/integrations/supabase/types";
import { useNeonCharts } from "@/hooks/use-neon-charts";
import { NeonPatternDefs, neonPatternId } from "@/components/NeonPatternDefs";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  PieChart, Pie, Cell,
  LineChart, Line,
  AreaChart, Area,
} from "recharts";


type BugRow = Tables<"bugs">;

const STATUS_COLORS: Record<string, string> = {
  new: "hsl(199, 89%, 48%)", assigned: "hsl(234, 55%, 60%)",
  in_progress: "hsl(38, 92%, 50%)", testing: "hsl(280, 60%, 55%)",
  resolved: "hsl(142, 70%, 40%)", closed: "hsl(0, 0%, 50%)",
};
const STATUS_LABELS: Record<string, string> = {
  new: "New", assigned: "Assigned", in_progress: "In Progress",
  testing: "Testing", resolved: "Resolved", closed: "Closed",
};
const SEVERITY_COLORS: Record<string, string> = {
  critical: "hsl(0, 72%, 51%)", high: "hsl(25, 95%, 53%)",
  medium: "hsl(38, 92%, 50%)", low: "hsl(142, 70%, 40%)",
};
const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical", high: "High", medium: "Medium", low: "Low",
};

export default function Analytics() {
  const [bugs, setBugs] = useState<BugRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { getFill } = useNeonCharts();

  useEffect(() => {
    supabase.from("bugs").select("*").then(({ data }) => {
      setBugs(data ?? []);
      setLoading(false);
    });
  }, []);

  const stats = useMemo(() => {
    const total = bugs.length;
    const resolved = bugs.filter(b => b.status === "resolved" || b.status === "closed").length;
    const critical = bugs.filter(b => b.severity === "critical").length;
    const thirtyDaysAgo = subDays(new Date(), 30);
    const recent = bugs.filter(b => parseISO(b.created_at) >= thirtyDaysAgo).length;
    return { total, resolutionRate: total ? Math.round((resolved / total) * 100) : 0, avgPerDay: Math.round((recent / 30) * 10) / 10, critical };
  }, [bugs]);

  const statusData = useMemo(() => {
    const counts: Record<string, number> = {};
    bugs.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1; });
    return Object.entries(STATUS_LABELS).map(([key, label]) => ({ status: label, count: counts[key] || 0, fill: STATUS_COLORS[key] }));
  }, [bugs]);
  const statusChartConfig: ChartConfig = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, label]) => [k, { label, color: STATUS_COLORS[k] }]));

  const severityData = useMemo(() => {
    const counts: Record<string, number> = {};
    bugs.forEach(b => { counts[b.severity] = (counts[b.severity] || 0) + 1; });
    return Object.entries(SEVERITY_LABELS).map(([key, label]) => ({ name: label, value: counts[key] || 0, fill: SEVERITY_COLORS[key] }));
  }, [bugs]);
  const severityChartConfig: ChartConfig = Object.fromEntries(Object.entries(SEVERITY_LABELS).map(([k, label]) => [k, { label, color: SEVERITY_COLORS[k] }]));

  const trendData = useMemo(() => {
    const days: Record<string, number> = {};
    for (let i = 29; i >= 0; i--) days[format(subDays(new Date(), i), "MMM dd")] = 0;
    bugs.forEach(b => { const key = format(parseISO(b.created_at), "MMM dd"); if (key in days) days[key]++; });
    return Object.entries(days).map(([date, count]) => ({ date, count }));
  }, [bugs]);
  const trendChartConfig: ChartConfig = { count: { label: "Bugs Created", color: "hsl(234, 55%, 60%)" } };

  const areaData = useMemo(() => {
    const resolvedStatuses = new Set(["resolved", "closed"]);
    const result: { date: string; open: number; resolved: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const day = startOfDay(subDays(new Date(), i));
      let open = 0, resolved = 0;
      bugs.forEach(b => { if (parseISO(b.created_at) <= day) { if (resolvedStatuses.has(b.status)) resolved++; else open++; } });
      result.push({ date: format(day, "MMM dd"), open, resolved });
    }
    return result;
  }, [bugs]);
  const areaChartConfig: ChartConfig = { open: { label: "Open", color: "hsl(38, 92%, 50%)" }, resolved: { label: "Resolved", color: "hsl(142, 70%, 40%)" } };

  const stackedData = useMemo(() => {
    return Object.entries(STATUS_LABELS).map(([statusKey, statusLabel]) => {
      const row: Record<string, string | number> = { status: statusLabel };
      Object.keys(SEVERITY_LABELS).forEach(sev => { row[sev] = bugs.filter(b => b.status === statusKey && b.severity === sev).length; });
      return row;
    });
  }, [bugs]);
  const stackedChartConfig: ChartConfig = Object.fromEntries(Object.entries(SEVERITY_LABELS).map(([k, label]) => [k, { label, color: SEVERITY_COLORS[k] }]));

  if (loading) {
    return (
      <AppLayout>
        <div className="flex flex-col h-full">
          <div className="px-4 md:px-6 h-11 border-b border-border flex items-center">
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="p-4 md:p-6 space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-md overflow-hidden">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        <div className="px-4 md:px-6 h-11 border-b border-border flex items-center shrink-0">
          <h1 className="text-[13px] font-medium">Analytics</h1>
        </div>

        <div className="flex-1 overflow-auto">
          <NeonPatternDefs colors={[...Object.values(STATUS_COLORS), ...Object.values(SEVERITY_COLORS), "hsl(38, 92%, 50%)", "hsl(142, 70%, 40%)"]} />
          <div className="p-4 md:p-6 space-y-6 max-w-[1400px]">
            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-md overflow-hidden">
              {[
                { label: "Total bugs", value: stats.total },
                { label: "Resolution rate", value: `${stats.resolutionRate}%` },
                { label: "Avg bugs/day", value: stats.avgPerDay },
                { label: "Critical bugs", value: stats.critical },
              ].map((stat) => (
                <div key={stat.label} className="bg-background p-4">
                  <p className="text-[12px] text-muted-foreground">{stat.label}</p>
                  <p className="text-2xl font-medium mt-1">{stat.value}</p>
                </div>
              ))}
            </div>

            {/* Charts grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border rounded-md overflow-hidden">
              {/* Status Bar */}
              <div className="bg-background p-4">
                <p className="text-[13px] font-medium mb-1">Bugs by status</p>
                <p className="text-[12px] text-muted-foreground mb-4">Distribution across workflow stages</p>
                <ChartContainer config={statusChartConfig} className="h-[220px] w-full">
                  <BarChart data={statusData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="status" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" radius={0}>
                      {statusData.map((e, i) => <Cell key={i} {...getFill(e.fill)} />)}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </div>

              {/* Severity Pie */}
              <div className="bg-background p-4">
                <p className="text-[13px] font-medium mb-1">Severity distribution</p>
                <p className="text-[12px] text-muted-foreground mb-4">Breakdown by severity level</p>
                <ChartContainer config={severityChartConfig} className="h-[220px] w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Pie data={severityData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                      {severityData.map((e, i) => <Cell key={i} {...getFill(e.fill)} />)}
                    </Pie>
                  </PieChart>
                </ChartContainer>
              </div>

              {/* Trend Line */}
              <div className="bg-background p-4">
                <p className="text-[13px] font-medium mb-1">Bug creation trend</p>
                <p className="text-[12px] text-muted-foreground mb-4">New bugs reported per day (last 30 days)</p>
                <ChartContainer config={trendChartConfig} className="h-[220px] w-full">
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} stroke="hsl(var(--muted-foreground))" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line type="monotone" dataKey="count" stroke="hsl(234, 55%, 60%)" strokeWidth={1.5} dot={{ r: 2 }} />
                  </LineChart>
                </ChartContainer>
              </div>

              {/* Open vs Resolved */}
              <div className="bg-background p-4">
                <p className="text-[13px] font-medium mb-1">Open vs resolved</p>
                <p className="text-[12px] text-muted-foreground mb-4">Cumulative counts over the last 30 days</p>
                <ChartContainer config={areaChartConfig} className="h-[220px] w-full">
                  <AreaChart data={areaData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} stroke="hsl(var(--muted-foreground))" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area type="monotone" dataKey="open" stackId="1" stroke="hsl(38, 92%, 50%)" fill={`url(#${neonPatternId("hsl(38, 92%, 50%)")})`} fillOpacity={1} strokeWidth={1.5} />
                    <Area type="monotone" dataKey="resolved" stackId="1" stroke="hsl(142, 70%, 40%)" fill={`url(#${neonPatternId("hsl(142, 70%, 40%)")})`} fillOpacity={1} strokeWidth={1.5} />
                  </AreaChart>
                </ChartContainer>
              </div>

              {/* Severity by Status */}
              <div className="bg-background p-4 lg:col-span-2">
                <p className="text-[13px] font-medium mb-1">Severity by status</p>
                <p className="text-[12px] text-muted-foreground mb-4">How severity levels distribute across each status</p>
                <ChartContainer config={stackedChartConfig} className="h-[220px] w-full">
                  <BarChart data={stackedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="status" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="critical" stackId="a" fill={`url(#${neonPatternId(SEVERITY_COLORS.critical)})`} stroke={SEVERITY_COLORS.critical} strokeWidth={1.5} shape={(props: any) => {
                      const { x, y, width, height, fill, stroke } = props;
                      return (<g><rect x={x} y={y} width={width} height={height} fill={fill} stroke="none" />
                        <line x1={x} y1={y+height} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x} y1={y} x2={x} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x+width} y1={y} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x} y1={y} x2={x+width} y2={y} stroke={stroke} strokeWidth={0.5} /></g>);
                    }} />
                    <Bar dataKey="high" stackId="a" fill={`url(#${neonPatternId(SEVERITY_COLORS.high)})`} stroke={SEVERITY_COLORS.high} strokeWidth={1.5} shape={(props: any) => {
                      const { x, y, width, height, fill, stroke } = props;
                      return (<g><rect x={x} y={y} width={width} height={height} fill={fill} stroke="none" />
                        <line x1={x} y1={y+height} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={0.5} />
                        <line x1={x} y1={y} x2={x} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x+width} y1={y} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x} y1={y} x2={x+width} y2={y} stroke={stroke} strokeWidth={0.5} /></g>);
                    }} />
                    <Bar dataKey="medium" stackId="a" fill={`url(#${neonPatternId(SEVERITY_COLORS.medium)})`} stroke={SEVERITY_COLORS.medium} strokeWidth={1.5} shape={(props: any) => {
                      const { x, y, width, height, fill, stroke } = props;
                      return (<g><rect x={x} y={y} width={width} height={height} fill={fill} stroke="none" />
                        <line x1={x} y1={y+height} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={0.5} />
                        <line x1={x} y1={y} x2={x} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x+width} y1={y} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x} y1={y} x2={x+width} y2={y} stroke={stroke} strokeWidth={0.5} /></g>);
                    }} />
                    <Bar dataKey="low" stackId="a" fill={`url(#${neonPatternId(SEVERITY_COLORS.low)})`} stroke={SEVERITY_COLORS.low} strokeWidth={1.5} shape={(props: any) => {
                      const { x, y, width, height, fill, stroke } = props;
                      return (<g><rect x={x} y={y} width={width} height={height} fill={fill} stroke="none" />
                        <line x1={x} y1={y+height} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={0.5} />
                        <line x1={x} y1={y} x2={x} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x+width} y1={y} x2={x+width} y2={y+height} stroke={stroke} strokeWidth={1.5} />
                        <line x1={x} y1={y} x2={x+width} y2={y} stroke={stroke} strokeWidth={1.5} /></g>);
                    }} />
                  </BarChart>
                </ChartContainer>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
