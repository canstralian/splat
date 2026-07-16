import { AppLayout } from "@/components/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { User, Building2, Users, Bell, Settings as SettingsIcon, History } from "lucide-react";
import { ProfileTab } from "@/components/settings/ProfileTab";
import { CompanyTab } from "@/components/settings/CompanyTab";
import { TeamTab } from "@/components/settings/TeamTab";
import { EmailTab } from "@/components/settings/EmailTab";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { AuditLogTab } from "@/components/settings/AuditLogTab";

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
