import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { History, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import type { Tables } from "@/integrations/supabase/types";

type AuditRow = Tables<"company_settings_audit">;

const PAGE_SIZE = 10;

export function AuditLogTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actorNames, setActorNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<AuditRow | null>(null);

  useEffect(() => {
    setPage(0);
  }, [actionFilter]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      let q = supabase
        .from("company_settings_audit")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (actionFilter !== "all") q = q.eq("action", actionFilter);
      const { data, count, error } = await q;
      if (error) {
        console.error("Failed to load audit log", error);
        toast({ title: "Failed to load audit log", description: "Something went wrong. Please try again.", variant: "destructive" });
        setLoading(false);
        return;
      }
      const list = (data ?? []) as AuditRow[];
      setRows(list);
      setTotal(count ?? 0);

      const actorIds = Array.from(new Set(list.map(r => r.actor_id).filter(Boolean))) as string[];
      if (actorIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", actorIds);
        const map: Record<string, string> = {};
        profs?.forEach(p => { map[p.user_id] = p.full_name || "Unknown"; });
        setActorNames(map);
      }
      setLoading(false);
    };
    void load();
  }, [page, actionFilter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[14px] font-medium flex items-center gap-2"><History className="h-4 w-4" /> Company Settings Audit Log</h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">History of company settings updates and deletions.</p>
        </div>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="h-8 text-[12px] w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            <SelectItem value="update">Updates</SelectItem>
            <SelectItem value="delete">Deletions</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border border-border rounded">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[11px] h-8">When</TableHead>
              <TableHead className="text-[11px] h-8">Action</TableHead>
              <TableHead className="text-[11px] h-8">Actor</TableHead>
              <TableHead className="text-[11px] h-8 text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="h-4 w-4 animate-spin inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-[12px] text-muted-foreground">No audit entries.</TableCell></TableRow>
            ) : rows.map(r => (
              <TableRow key={r.id}>
                <TableCell className="text-[12px]">{format(new Date(r.created_at), "MMM d, yyyy HH:mm")}</TableCell>
                <TableCell><Badge variant={r.action === "delete" ? "destructive" : "secondary"} className="text-[10px]">{r.action}</Badge></TableCell>
                <TableCell className="text-[12px]">{r.actor_id ? (actorNames[r.actor_id] || r.actor_id.slice(0, 8)) : "System"}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setSelected(r)}>View</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <div>{total === 0 ? "0" : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)}`} of {total}</div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
          <span>Page {page + 1} / {totalPages}</span>
          <Button size="sm" variant="outline" className="h-7" disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-card border border-border rounded-lg max-w-2xl w-full max-h-[80vh] overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[13px] font-medium">Audit entry details</h3>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(null)}>Close</Button>
            </div>
            <div className="space-y-3 text-[12px]">
              <div><span className="text-muted-foreground">Action:</span> {selected.action}</div>
              <div><span className="text-muted-foreground">When:</span> {format(new Date(selected.created_at), "PPpp")}</div>
              <div><span className="text-muted-foreground">Actor:</span> {selected.actor_id ? (actorNames[selected.actor_id] || selected.actor_id) : "System"}</div>
              {selected.old_data ? (
                <div>
                  <div className="text-muted-foreground mb-1">Old data</div>
                  <pre className="bg-muted p-2 rounded text-[11px] overflow-auto">{JSON.stringify(selected.old_data, null, 2)}</pre>
                </div>
              ) : null}
              {selected.new_data ? (
                <div>
                  <div className="text-muted-foreground mb-1">New data</div>
                  <pre className="bg-muted p-2 rounded text-[11px] overflow-auto">{JSON.stringify(selected.new_data, null, 2)}</pre>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
