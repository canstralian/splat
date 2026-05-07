import { useState, useEffect } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import {
  User, Building2, Users, Bell, Settings as SettingsIcon,
  Mail, Trash2, Shield, Send, AlertTriangle, Loader2, Camera,
  History, ChevronLeft, ChevronRight
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";

// ─── Profile Tab ────────────────────────────────────────────────────────────────

function ProfileTab() {
  const { user, profile, refreshProfile } = useAuth();
  const [fullName, setFullName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      toast({ title: "Invalid file type", description: "Please upload a JPG, PNG, WebP, or GIF image.", variant: "destructive" });
      return;
    }

    const maxSize = 5 * 1024 * 1024; // 5 MB
    if (file.size > maxSize) {
      toast({ title: "File too large", description: "Avatar must be under 5 MB.", variant: "destructive" });
      return;
    }

    const allowedExts = ["jpg", "jpeg", "png", "webp", "gif"];
    const fileExt = (file.name.split(".").pop() || "").toLowerCase();
    if (!allowedExts.includes(fileExt)) {
      toast({ title: "Invalid file extension", description: "Please upload a JPG, PNG, WebP, or GIF image.", variant: "destructive" });
      return;
    }

    setUploadingAvatar(true);
    const filePath = `${user.id}/avatar.${fileExt}`;
    const { error: uploadError } = await supabase.storage.from("avatars").upload(filePath, file, { upsert: true });
    if (uploadError) { toast({ title: "Upload failed", description: uploadError.message, variant: "destructive" }); setUploadingAvatar(false); return; }
    const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(filePath);
    const avatarUrl = `${urlData.publicUrl}?t=${Date.now()}`;
    const { error: updateError } = await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("user_id", user.id);
    setUploadingAvatar(false);
    if (updateError) toast({ title: "Error", description: updateError.message, variant: "destructive" });
    else { toast({ title: "Avatar updated" }); await refreshProfile(); }
  };

  useEffect(() => {
    if (profile) { setFullName(profile.full_name || ""); setJobTitle(profile.job_title || ""); }
  }, [profile]);

  const initials = fullName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);

  const handleSaveProfile = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase.from("profiles").update({ full_name: fullName, job_title: jobTitle }).eq("user_id", user.id);
    setSaving(false);
    if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" }));
    else { toast({ title: "Profile updated" }); await refreshProfile(); }
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 6) { toast({ title: "Error", description: "Password must be at least 6 characters.", variant: "destructive" }); return; }
    setChangingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setChangingPassword(false);
    if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" }));
    else { toast({ title: "Password updated" }); setNewPassword(""); }
  };

  return (
    <div className="divide-y divide-border">
      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Profile Information</p>
        <div className="flex items-center gap-3 mb-4">
          <div className="relative group">
            <Avatar className="h-10 w-10">
              <AvatarImage src={profile?.avatar_url || ""} className="object-contain" />
              <AvatarFallback className="text-[12px]">{initials || "?"}</AvatarFallback>
            </Avatar>
            <label htmlFor="avatar-upload" className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
              {uploadingAvatar ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white" /> : <Camera className="h-3.5 w-3.5 text-white" />}
            </label>
            <input id="avatar-upload" type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={uploadingAvatar} />
          </div>
          <div>
            <p className="text-[13px] font-medium">{fullName || "Your Name"}</p>
            <p className="text-[12px] text-muted-foreground">{user?.email}</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 max-w-lg">
          <div className="space-y-1">
            <Label className="text-[12px]">Full Name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="John Doe" className="h-8 text-[13px]" />
          </div>
          <div className="space-y-1">
            <Label className="text-[12px]">Job Title</Label>
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Software Engineer" className="h-8 text-[13px]" />
          </div>
        </div>
        <Button onClick={handleSaveProfile} disabled={saving} size="sm" className="h-7 text-[12px] mt-3">
          {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />} Save
        </Button>
      </div>

      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Change Password</p>
        <div className="max-w-xs space-y-1">
          <Label className="text-[12px]">New Password</Label>
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" className="h-8 text-[13px]" />
        </div>
        <Button onClick={handleChangePassword} disabled={changingPassword} variant="outline" size="sm" className="h-7 text-[12px] mt-3">
          {changingPassword && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />} Update Password
        </Button>
      </div>
    </div>
  );
}

// ─── Company Tab ────────────────────────────────────────────────────────────────

function CompanyTab() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ company_name: "", company_website: "", industry: "", company_size: "", address: "", phone: "" });
  const [existingId, setExistingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from("company_settings").select("*").eq("user_id", user.id).maybeSingle().then(({ data }) => {
      if (data) { setForm({ company_name: data.company_name || "", company_website: data.company_website || "", industry: data.industry || "", company_size: data.company_size || "", address: data.address || "", phone: data.phone || "" }); setExistingId(data.id); }
      setLoading(false);
    });
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    if (existingId) {
      const { error } = await supabase.from("company_settings").update(form).eq("id", existingId);
      if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" })); else toast({ title: "Company settings saved" });
    } else {
      const { data, error } = await supabase.from("company_settings").insert({ ...form, user_id: user.id }).select().single();
      if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" })); else { setExistingId(data.id); toast({ title: "Company settings created" }); }
    }
    setSaving(false);
  };

  const update = (key: string, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="px-4 md:px-6 py-4">
      <p className="text-[12px] text-muted-foreground font-medium mb-3">Company Information</p>
      <div className="grid gap-3 sm:grid-cols-2 max-w-lg">
        <div className="space-y-1"><Label className="text-[12px]">Company Name</Label><Input value={form.company_name} onChange={(e) => update("company_name", e.target.value)} placeholder="Acme Inc." className="h-8 text-[13px]" /></div>
        <div className="space-y-1"><Label className="text-[12px]">Website</Label><Input value={form.company_website} onChange={(e) => update("company_website", e.target.value)} placeholder="https://acme.com" className="h-8 text-[13px]" /></div>
        <div className="space-y-1"><Label className="text-[12px]">Industry</Label>
          <Select value={form.industry} onValueChange={(v) => update("industry", v)}><SelectTrigger className="h-8 text-[13px]"><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{["Technology","Healthcare","Finance","Education","Retail","Manufacturing","Other"].map(i => <SelectItem key={i} value={i.toLowerCase()}>{i}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label className="text-[12px]">Company Size</Label>
          <Select value={form.company_size} onValueChange={(v) => update("company_size", v)}><SelectTrigger className="h-8 text-[13px]"><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{["1-10","11-50","51-200","201-500","501-1000","1000+"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1 sm:col-span-2"><Label className="text-[12px]">Address</Label><Input value={form.address} onChange={(e) => update("address", e.target.value)} placeholder="123 Main St" className="h-8 text-[13px]" /></div>
        <div className="space-y-1"><Label className="text-[12px]">Phone</Label><Input value={form.phone} onChange={(e) => update("phone", e.target.value)} placeholder="+1 (555) 000-0000" className="h-8 text-[13px]" /></div>
      </div>
      <Button onClick={handleSave} disabled={saving} size="sm" className="h-7 text-[12px] mt-3">
        {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />} Save
      </Button>
    </div>
  );
}

// ─── Team Tab ───────────────────────────────────────────────────────────────────

function TeamTab() {
  const { user } = useAuth();
  const [members, setMembers] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("user");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const fetchData = async () => {
    const [teamRes, invitationsRes] = await Promise.all([
      supabase.rpc("get_team_members"),
      supabase.from("invitations").select("*").eq("status", "pending"),
    ]);
    setMembers(teamRes.data || []);
    setInvitations(invitationsRes.data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleInvite = async () => {
    if (!user || !inviteEmail) return;
    setSending(true);
    const { error } = await supabase.from("invitations").insert({ email: inviteEmail, role: inviteRole as any, invited_by: user.id });
    setSending(false);
    if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" }));
    else { toast({ title: "Invitation sent", description: `Invited ${inviteEmail}` }); setInviteEmail(""); fetchData(); }
  };

  const handleRevoke = async (id: string) => {
    const { error } = await supabase.from("invitations").delete().eq("id", id);
    if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" }));
    else { toast({ title: "Invitation revoked" }); fetchData(); }
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="divide-y divide-border">
      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Invite Team Member</p>
        <div className="flex gap-2 max-w-lg">
          <Input placeholder="colleague@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="h-8 text-[13px] flex-1" />
          <Select value={inviteRole} onValueChange={setInviteRole}>
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
            {invitations.map((inv: any) => (
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
          {members.map((m: any) => (
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

// ─── Email Tab ──────────────────────────────────────────────────────────────────

function EmailTab() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState({ email_on_new_bug: true, email_on_assignment: true, email_on_status_change: true, email_on_comment: true, email_on_sla_breach: true, daily_digest: false });
  const [existingId, setExistingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from("notification_preferences").select("*").eq("user_id", user.id).maybeSingle().then(({ data }) => {
      if (data) { setPrefs({ email_on_new_bug: data.email_on_new_bug, email_on_assignment: data.email_on_assignment, email_on_status_change: data.email_on_status_change, email_on_comment: data.email_on_comment, email_on_sla_breach: data.email_on_sla_breach, daily_digest: data.daily_digest }); setExistingId(data.id); }
      setLoading(false);
    });
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    if (existingId) {
      const { error } = await supabase.from("notification_preferences").update(prefs).eq("id", existingId);
      if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" })); else toast({ title: "Preferences saved" });
    } else {
      const { data, error } = await supabase.from("notification_preferences").insert({ ...prefs, user_id: user.id }).select().single();
      if (error) (console.error("Error", error), toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" })); else { setExistingId(data.id); toast({ title: "Preferences saved" }); }
    }
    setSaving(false);
  };

  const togglePref = (key: keyof typeof prefs) => setPrefs(p => ({ ...p, [key]: !p[key] }));

  const items = [
    { key: "email_on_new_bug" as const, label: "New Bug Reported" },
    { key: "email_on_assignment" as const, label: "Bug Assigned to You" },
    { key: "email_on_status_change" as const, label: "Status Changes" },
    { key: "email_on_comment" as const, label: "New Comments" },
    { key: "email_on_sla_breach" as const, label: "SLA Breach Warning" },
    { key: "daily_digest" as const, label: "Daily Digest" },
  ];

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="divide-y divide-border">
      <div className="px-4 md:px-6 py-3 flex items-start gap-2 bg-muted/30">
        <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-[12px] text-muted-foreground">Email delivery not yet connected. Preferences will take effect once an email provider is configured.</p>
      </div>
      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Email Notifications</p>
        <div className="space-y-1">
          {items.map(item => (
            <div key={item.key} className="flex items-center justify-between py-2 px-2 rounded hover:bg-muted/30">
              <span className="text-[13px]">{item.label}</span>
              <Switch checked={prefs[item.key]} onCheckedChange={() => togglePref(item.key)} className="scale-90" />
            </div>
          ))}
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm" className="h-7 text-[12px] mt-3">
          {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />} Save Preferences
        </Button>
      </div>
    </div>
  );
}

// ─── General Tab ────────────────────────────────────────────────────────────────

function GeneralTab() {
  const [theme, setThemeState] = useState<string>(() => {
    if (typeof window !== "undefined") return document.documentElement.classList.contains("dark") ? "dark" : "light";
    return "dark";
  });

  const toggleTheme = (value: string) => {
    setThemeState(value);
    if (value === "dark") { document.documentElement.classList.add("dark"); localStorage.setItem("theme", "dark"); }
    else { document.documentElement.classList.remove("dark"); localStorage.setItem("theme", "light"); }
  };

  return (
    <div className="divide-y divide-border">
      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Appearance</p>
        <div className="flex items-center justify-between max-w-lg">
          <span className="text-[13px]">Theme</span>
          <Select value={theme} onValueChange={toggleTheme}>
            <SelectTrigger className="w-[100px] h-7 text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem></SelectContent>
          </Select>
        </div>
      </div>

      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-muted-foreground font-medium mb-3">Defaults</p>
        <div className="grid gap-3 sm:grid-cols-2 max-w-lg">
          <div className="space-y-1"><Label className="text-[12px]">Default Severity</Label>
            <Select defaultValue="medium"><SelectTrigger className="h-8 text-[13px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem><SelectItem value="critical">Critical</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label className="text-[12px]">Default Environment</Label>
            <Select defaultValue="production"><SelectTrigger className="h-8 text-[13px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="production">Production</SelectItem><SelectItem value="staging">Staging</SelectItem><SelectItem value="development">Development</SelectItem><SelectItem value="qa">QA</SelectItem></SelectContent></Select></div>
        </div>
      </div>

      <div className="px-4 md:px-6 py-4">
        <p className="text-[12px] text-destructive font-medium mb-3">Danger Zone</p>
        <div className="flex items-center justify-between max-w-lg border border-destructive/20 rounded-md p-3">
          <div>
            <p className="text-[13px] font-medium">Delete Account</p>
            <p className="text-[12px] text-muted-foreground">Permanently delete your account and all data.</p>
          </div>
          <Button variant="destructive" size="sm" disabled className="h-7 text-[12px]">Coming Soon</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Audit Log Tab ──────────────────────────────────────────────────────────────

type AuditRow = {
  id: string;
  company_settings_id: string | null;
  user_id: string;
  actor_id: string | null;
  action: string;
  old_data: any;
  new_data: any;
  created_at: string;
};

const PAGE_SIZE = 10;

function AuditLogTab() {
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
        (console.error("Failed to load audit log", error), toast({ title: "Failed to load audit log", description: "Something went wrong. Please try again.", variant: "destructive" }));
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
    load();
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
              {selected.old_data && (
                <div>
                  <div className="text-muted-foreground mb-1">Old data</div>
                  <pre className="bg-muted p-2 rounded text-[11px] overflow-auto">{JSON.stringify(selected.old_data, null, 2)}</pre>
                </div>
              )}
              {selected.new_data && (
                <div>
                  <div className="text-muted-foreground mb-1">New data</div>
                  <pre className="bg-muted p-2 rounded text-[11px] overflow-auto">{JSON.stringify(selected.new_data, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Settings Page ─────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        <div className="px-4 md:px-6 h-11 border-b border-border flex items-center shrink-0">
          <h1 className="text-[13px] font-medium">Settings</h1>
        </div>

        <div className="flex-1 overflow-auto">
          <Tabs defaultValue="profile" className="flex flex-col md:flex-row h-full">
            <div className="md:w-44 shrink-0 border-b md:border-b-0 md:border-r border-border">
              <TabsList className="flex md:flex-col items-stretch w-full bg-transparent h-auto p-1.5 gap-px">
                <TabsTrigger value="profile" className="justify-start gap-1.5 text-[12px] h-7 px-2 data-[state=active]:bg-muted w-full">
                  <User className="h-3.5 w-3.5" /> Profile
                </TabsTrigger>
                <TabsTrigger value="company" className="justify-start gap-1.5 text-[12px] h-7 px-2 data-[state=active]:bg-muted w-full">
                  <Building2 className="h-3.5 w-3.5" /> Company
                </TabsTrigger>
                <TabsTrigger value="team" className="justify-start gap-1.5 text-[12px] h-7 px-2 data-[state=active]:bg-muted w-full">
                  <Users className="h-3.5 w-3.5" /> Team
                </TabsTrigger>
                <TabsTrigger value="email" className="justify-start gap-1.5 text-[12px] h-7 px-2 data-[state=active]:bg-muted w-full">
                  <Bell className="h-3.5 w-3.5" /> Notifications
                </TabsTrigger>
                <TabsTrigger value="general" className="justify-start gap-1.5 text-[12px] h-7 px-2 data-[state=active]:bg-muted w-full">
                  <SettingsIcon className="h-3.5 w-3.5" /> General
                </TabsTrigger>
                <TabsTrigger value="audit" className="justify-start gap-1.5 text-[12px] h-7 px-2 data-[state=active]:bg-muted w-full">
                  <History className="h-3.5 w-3.5" /> Audit Log
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 min-w-0">
              <TabsContent value="profile" className="m-0"><ProfileTab /></TabsContent>
              <TabsContent value="company" className="m-0"><CompanyTab /></TabsContent>
              <TabsContent value="team" className="m-0"><TeamTab /></TabsContent>
              <TabsContent value="email" className="m-0"><EmailTab /></TabsContent>
              <TabsContent value="general" className="m-0"><GeneralTab /></TabsContent>
              <TabsContent value="audit" className="m-0"><AuditLogTab /></TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </AppLayout>
  );
}
