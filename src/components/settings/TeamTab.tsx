import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Mail, Trash2, Shield, Send, Loader2 } from "lucide-react";
import type { Database, Tables, Enums } from "@/integrations/supabase/types";

type TeamMember = Database["public"]["Functions"]["get_team_members"]["Returns"][number];
type Invitation = Tables<"invitations">;
type Role = Enums<"app_role">;

export function TeamTab() {
  const { user } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("user");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const fetchData = useCallback(async () => {
    const [teamRes, invitationsRes] = await Promise.all([
      supabase.rpc("get_team_members"),
      supabase.from("invitations").select("*").eq("status", "pending"),
    ]);
    setMembers(teamRes.data ?? []);
    setInvitations(invitationsRes.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleInvite = async () => {
    if (!user || !inviteEmail) return;
    setSending(true);
    const { error } = await supabase.from("invitations").insert({ email: inviteEmail, role: inviteRole, invited_by: user.id });
    setSending(false);
    if (error) {
      console.error("Error", error);
      toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" });
    } else {
      toast({ title: "Invitation sent", description: `Invited ${inviteEmail}` });
      setInviteEmail("");
      void fetchData();
    }
  };

  const handleRevoke = async (id: string) => {
    const { error } = await supabase.from("invitations").delete().eq("id", id);
    if (error) {
      console.error("Error", error);
      toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" });
    } else {
      toast({ title: "Invitation revoked" });
      void fetchData();
    }
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="divide-y divide-border">
      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Invite Team Member</p>
        <div className="flex gap-2 max-w-lg">
          <Input placeholder="colleague@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="h-8 text-[13px] flex-1" />
          <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
            <SelectTrigger className="w-[100px] h-8 text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="user">User</SelectItem><SelectItem value="moderator">Moderator</SelectItem><SelectItem value="admin">Admin</SelectItem></SelectContent>
          </Select>
          <Button onClick={handleInvite} disabled={sending || !inviteEmail} size="sm" className="h-8 text-[12px] gap-1">
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Invite
          </Button>
        </div>
      </div>

      {invitations.length > 0 && (
        <div className="px-4 md:px-6 py-4">
          <p className="text-[12px] text-muted-foreground font-medium mb-3">Pending Invitations</p>
          <div className="space-y-1">
            {invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/30">
                <div className="flex items-center gap-2">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[13px]">{inv.email}</span>
                  <Badge variant="outline" className="text-[10px] h-4 px-1">{inv.role}</Badge>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleRevoke(inv.id)} className="h-6 w-6 p-0">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Team Members · {members.length}</p>
        <div className="space-y-1">
          {members.map((m) => (
            <div key={m.user_id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/30">
              <div className="flex items-center gap-2">
                <Avatar className="h-5 w-5">
                  <AvatarImage src={m.avatar_url || ""} />
                  <AvatarFallback className="text-2xs">{(m.full_name || "?").split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)}</AvatarFallback>
                </Avatar>
                <span className="text-[13px] font-medium">{m.full_name || "Unnamed"}</span>
                <span className="text-[12px] text-muted-foreground">{m.job_title || ""}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] h-4 px-1 gap-0.5">
                  <Shield className="h-2.5 w-2.5" />{m.role}
                </Badge>
                {m.user_id === user?.id && <Badge variant="secondary" className="text-[10px] h-4 px-1">You</Badge>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
