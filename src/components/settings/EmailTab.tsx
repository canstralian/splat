import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { AlertTriangle, Loader2 } from "lucide-react";

type Prefs = {
  email_on_new_bug: boolean;
  email_on_assignment: boolean;
  email_on_status_change: boolean;
  email_on_comment: boolean;
  email_on_sla_breach: boolean;
  daily_digest: boolean;
};

const DEFAULT_PREFS: Prefs = {
  email_on_new_bug: true, email_on_assignment: true, email_on_status_change: true,
  email_on_comment: true, email_on_sla_breach: true, daily_digest: false,
};

export function EmailTab() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [existingId, setExistingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from("notification_preferences").select("*").eq("user_id", user.id).maybeSingle().then(({ data }) => {
      if (data) {
        setPrefs({
          email_on_new_bug: data.email_on_new_bug, email_on_assignment: data.email_on_assignment,
          email_on_status_change: data.email_on_status_change, email_on_comment: data.email_on_comment,
          email_on_sla_breach: data.email_on_sla_breach, daily_digest: data.daily_digest,
        });
        setExistingId(data.id);
      }
      setLoading(false);
    });
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    if (existingId) {
      const { error } = await supabase.from("notification_preferences").update(prefs).eq("id", existingId);
      if (error) {
        console.error("Error", error);
        toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" });
      } else {
        toast({ title: "Preferences saved" });
      }
    } else {
      const { data, error } = await supabase.from("notification_preferences").insert({ ...prefs, user_id: user.id }).select().single();
      if (error) {
        console.error("Error", error);
        toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" });
      } else {
        setExistingId(data.id);
        toast({ title: "Preferences saved" });
      }
    }
    setSaving(false);
  };

  const togglePref = (key: keyof Prefs) => setPrefs(p => ({ ...p, [key]: !p[key] }));

  const items: { key: keyof Prefs; label: string }[] = [
    { key: "email_on_new_bug", label: "New Bug Reported" },
    { key: "email_on_assignment", label: "Bug Assigned to You" },
    { key: "email_on_status_change", label: "Status Changes" },
    { key: "email_on_comment", label: "New Comments" },
    { key: "email_on_sla_breach", label: "SLA Breach Warning" },
    { key: "daily_digest", label: "Daily Digest" },
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
