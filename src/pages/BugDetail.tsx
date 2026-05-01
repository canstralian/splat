import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SeverityBadge } from "@/components/SeverityBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import type { Tables, Enums } from "@/integrations/supabase/types";
import { formatDistanceToNow } from "date-fns";

type BugRow = Tables<"bugs">;
type CommentRow = Tables<"comments">;

const statusFlow: Enums<"bug_status">[] = ["new", "assigned", "in_progress", "testing", "resolved", "closed"];

export default function BugDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [bug, setBug] = useState<BugRow | null>(null);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [submittingComment, setSubmittingComment] = useState(false);

  const fetchBug = async () => {
    if (!id) return;
    const { data } = await supabase.from("bugs").select("*").eq("id", id).single();
    setBug(data);
    setLoading(false);
  };

  const fetchComments = async () => {
    if (!id) return;
    const { data } = await supabase
      .from("comments").select("*").eq("bug_id", id).order("created_at", { ascending: true });
    setComments(data || []);
    const userIds = [...new Set((data || []).map(c => c.user_id))];
    if (userIds.length > 0) {
      const { data: profileData } = await supabase.from("profiles").select("user_id, full_name").in("user_id", userIds);
      const map: Record<string, string> = {};
      (profileData || []).forEach(p => { map[p.user_id] = p.full_name; });
      setProfiles(prev => ({ ...prev, ...map }));
    }
  };

  useEffect(() => {
    fetchBug();
    fetchComments();
    const channel = supabase
      .channel(`bug-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "comments", filter: `bug_id=eq.${id}` }, () => fetchComments())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "bugs", filter: `id=eq.${id}` }, () => fetchBug())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id]);

  const updateStatus = async (newStatus: Enums<"bug_status">) => {
    if (!bug || !user) return;
    const { error } = await supabase.from("bugs").update({ status: newStatus }).eq("id", bug.id);
    if (error) {
      toast({ title: "Failed to update status", description: error.message, variant: "destructive" });
    } else {
      await supabase.from("activity_log").insert({
        bug_id: bug.id, user_id: user.id, action: "status_change",
        old_value: bug.status, new_value: newStatus,
      });
      toast({ title: `Status updated to ${newStatus.replace("_", " ")}` });
    }
  };

  const addComment = async () => {
    if (!newComment.trim() || !user || !bug) return;
    setSubmittingComment(true);
    const { error } = await supabase.from("comments").insert({
      bug_id: bug.id, user_id: user.id, content: newComment.trim(),
    });
    if (error) toast({ title: "Failed to add comment", description: error.message, variant: "destructive" });
    else setNewComment("");
    setSubmittingComment(false);
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!bug) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-full gap-3">
          <p className="text-[13px] text-muted-foreground">Bug not found</p>
          <Button variant="outline" size="sm" onClick={() => navigate("/")} className="h-7 text-[12px]">
            Back to Dashboard
          </Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        {/* Header bar */}
        <div className="flex items-center gap-2 px-4 md:px-6 h-11 border-b border-border shrink-0">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-7 w-7">
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="font-mono text-[12px] text-muted-foreground">{bug.tracking_id}</span>
          <StatusBadge status={bug.status} />
          <SeverityBadge severity={bug.severity} />
        </div>

        <div className="flex-1 overflow-auto">
          <div className="flex flex-col lg:flex-row">
            {/* Main content */}
            <div className="flex-1 min-w-0 border-r border-border">
              {/* Title */}
              <div className="px-4 md:px-6 py-4 border-b border-border">
                <h1 className="text-base font-medium">{bug.title}</h1>
              </div>

              {/* Description */}
              <div className="px-4 md:px-6 py-4 border-b border-border">
                <p className="text-[12px] text-muted-foreground mb-2 font-medium">Description</p>
                <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{bug.description || "No description"}</p>
              </div>

              {bug.steps_to_reproduce && (
                <div className="px-4 md:px-6 py-4 border-b border-border">
                  <p className="text-[12px] text-muted-foreground mb-2 font-medium">Steps to Reproduce</p>
                  <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{bug.steps_to_reproduce}</p>
                </div>
              )}

              {(bug.expected_behavior || bug.actual_behavior) && (
                <div className="grid grid-cols-1 md:grid-cols-2 border-b border-border">
                  {bug.expected_behavior && (
                    <div className="px-4 md:px-6 py-4 md:border-r border-border">
                      <p className="text-[12px] text-muted-foreground mb-2 font-medium">Expected</p>
                      <p className="text-[13px]">{bug.expected_behavior}</p>
                    </div>
                  )}
                  {bug.actual_behavior && (
                    <div className="px-4 md:px-6 py-4">
                      <p className="text-[12px] text-muted-foreground mb-2 font-medium">Actual</p>
                      <p className="text-[13px]">{bug.actual_behavior}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Comments */}
              <div className="px-4 md:px-6 py-4">
                <p className="text-[12px] text-muted-foreground mb-3 font-medium">Activity · {comments.length}</p>
                <div className="space-y-3">
                  {comments.map((c) => (
                    <div key={c.id} className="flex gap-3">
                      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                        <span className="text-2xs font-medium text-muted-foreground">
                          {(profiles[c.user_id] || "U").charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium">{profiles[c.user_id] || "User"}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        <p className="text-[13px] mt-0.5 leading-relaxed">{c.content}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex gap-2">
                  <Textarea
                    placeholder="Leave a comment..."
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    rows={2}
                    maxLength={2000}
                    className="text-[13px] min-h-[60px] resize-none"
                  />
                  <Button
                    onClick={addComment}
                    disabled={!newComment.trim() || submittingComment}
                    size="sm"
                    className="shrink-0 self-end h-8"
                  >
                    {submittingComment ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>

            {/* Right sidebar */}
            <div className="w-full lg:w-64 shrink-0">
              {/* Status workflow */}
              <div className="px-4 py-3 border-b border-border">
                <p className="text-[12px] text-muted-foreground mb-2 font-medium">Status</p>
                <div className="flex flex-wrap gap-1">
                  {statusFlow.map((status) => (
                    <Button
                      key={status}
                      variant={bug.status === status ? "secondary" : "ghost"}
                      size="sm"
                      disabled={bug.status === status}
                      onClick={() => updateStatus(status)}
                      className="h-6 text-[11px] px-2"
                    >
                      {status.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase())}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Properties */}
              <div className="px-4 py-3 space-y-3 text-[13px]">
                <div>
                  <p className="text-[12px] text-muted-foreground mb-0.5">Environment</p>
                  <p>{bug.environment || "—"}</p>
                </div>
                <div>
                  <p className="text-[12px] text-muted-foreground mb-0.5">Created</p>
                  <p>{formatDistanceToNow(new Date(bug.created_at), { addSuffix: true })}</p>
                </div>
                <div>
                  <p className="text-[12px] text-muted-foreground mb-0.5">Updated</p>
                  <p>{formatDistanceToNow(new Date(bug.updated_at), { addSuffix: true })}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
