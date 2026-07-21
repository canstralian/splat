import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

type CompanyForm = {
  company_name: string;
  company_website: string;
  industry: string;
  company_size: string;
  address: string;
  phone: string;
};

const EMPTY: CompanyForm = {
  company_name: "", company_website: "", industry: "",
  company_size: "", address: "", phone: "",
};

export function CompanyTab() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CompanyForm>(EMPTY);
  const [existingId, setExistingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from("company_settings").select("*").eq("user_id", user.id).maybeSingle().then(({ data }) => {
      if (data) {
        setForm({
          company_name: data.company_name || "", company_website: data.company_website || "",
          industry: data.industry || "", company_size: data.company_size || "",
          address: data.address || "", phone: data.phone || "",
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
      const { error } = await supabase.from("company_settings").update(form).eq("id", existingId);
      if (error) {
        console.error("Error", error);
        toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" });
      } else {
        toast({ title: "Company settings saved" });
      }
    } else {
      const { data, error } = await supabase.from("company_settings").insert({ ...form, user_id: user.id }).select().single();
      if (error) {
        console.error("Error", error);
        toast({ title: "Error", description: "Something went wrong. Please try again.", variant: "destructive" });
      } else {
        setExistingId(data.id);
        toast({ title: "Company settings created" });
      }
    }
    setSaving(false);
  };

  const update = (key: keyof CompanyForm, value: string) => setForm(prev => ({ ...prev, [key]: value }));

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
