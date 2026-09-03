import { LayoutDashboard, Plus, Bug, BarChart3, Settings, ShieldCheck, Sparkles } from "lucide-react";

export const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
  { icon: Plus, label: "Report Bug", path: "/bugs/new" },
  { icon: Bug, label: "All Bugs", path: "/bugs" },
  { icon: BarChart3, label: "Analytics", path: "/analytics" },
  { icon: Sparkles, label: "Assistant", path: "/assistant" },
  { icon: ShieldCheck, label: "Security", path: "/security" },
  { icon: Settings, label: "Settings", path: "/settings" },
];
