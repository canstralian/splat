import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SeverityBadge } from "@/components/SeverityBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Loader2 } from "lucide-react";
import type { Tables, Enums } from "@/integrations/supabase/types";
import { Constants } from "@/integrations/supabase/types";
import { formatDistanceToNow } from "date-fns";

type BugRow = Tables<"bugs">;

export default function BugList() {
  const navigate = useNavigate();
  const [bugs, setBugs] = useState<BugRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  useEffect(() => {
    const fetchBugs = async () => {
      const { data } = await supabase.from("bugs").select("*").order("created_at", { ascending: false });
      setBugs(data || []);
      setLoading(false);
    };
    fetchBugs();
    const channel = supabase
      .channel("buglist-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "bugs" }, () => fetchBugs())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const filtered = bugs.filter(b => {
    const matchesSearch = b.title.toLowerCase().includes(search.toLowerCase()) ||
      b.tracking_id.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || b.status === statusFilter;
    const matchesSeverity = severityFilter === "all" || b.severity === severityFilter;
    return matchesSearch && matchesStatus && matchesSeverity;
  });

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
        {/* Header */}
        <div className="flex items-center justify-between px-4 md:px-6 h-11 border-b border-border shrink-0">
          <h1 className="text-[13px] font-medium">All Bugs</h1>
          <Button asChild size="sm" className="h-7 text-[12px] gap-1.5">
            <Link to="/bugs/new">
              <Plus className="h-3.5 w-3.5" /> Report Bug
            </Link>
          </Button>
        </div>

        {/* Filters bar */}
        <div className="flex items-center gap-2 px-4 md:px-6 h-10 border-b border-border shrink-0">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search bugs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-7 text-[13px] bg-transparent border-none shadow-none focus-visible:ring-0"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[120px] h-7 text-[12px] border-none bg-transparent">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {Constants.public.Enums.bug_status.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="w-[120px] h-7 text-[12px] border-none bg-transparent">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              {Constants.public.Enums.bug_severity.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b border-border">
                <th className="text-left font-medium text-muted-foreground px-4 md:px-6 py-2">ID</th>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">Title</th>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">Status</th>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">Priority</th>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-12 text-muted-foreground">No bugs found</td>
                </tr>
              ) : (
                filtered.map((bug) => (
                  <tr
                    key={bug.id}
                    className="border-b border-border hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => navigate(`/bugs/${bug.id}`)}
                  >
                    <td className="px-4 md:px-6 py-2 text-muted-foreground font-mono text-[12px]">{bug.tracking_id}</td>
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
      </div>
    </AppLayout>
  );
}
