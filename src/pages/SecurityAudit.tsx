import { AppLayout } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, FileCode, Database, Server } from "lucide-react";

type Change = { kind: "file" | "edge-function" | "migration"; path: string };
type Entry = {
  id: string;
  date: string;
  title: string;
  severity: "warn" | "error" | "info";
  source: "agent_security" | "supabase_lov" | "supabase_linter";
  summary: string;
  fix: string;
  changes: Change[];
};

const entries: Entry[] = [
  {
    id: "raw_storage_errors",
    date: "2026-05-07",
    title: "Raw Supabase error messages exposed in UI toasts",
    severity: "warn",
    source: "agent_security",
    summary: "Settings.tsx forwarded raw uploadError.message and updateError.message to user toasts, leaking bucket paths, RLS messages, and column names.",
    fix: "Replaced with generic toast copy ('Something went wrong. Please try again.'); raw errors now logged via console.error only.",
    changes: [{ kind: "file", path: "src/pages/Settings.tsx" }],
  },
  {
    id: "edge_fn_error_strings",
    date: "2026-05-07",
    title: "Edge functions returned String(e) in 500 responses",
    severity: "warn",
    source: "agent_security",
    summary: "get-paddle-price and update-subscription leaked Paddle and runtime error details to any HTTP caller.",
    fix: "Both functions now log full errors server-side and return a generic 'An internal error occurred' message.",
    changes: [
      { kind: "edge-function", path: "supabase/functions/get-paddle-price/index.ts" },
      { kind: "edge-function", path: "supabase/functions/update-subscription/index.ts" },
    ],
  },
  {
    id: "unauthenticated_price_fn",
    date: "2026-05-07",
    title: "Unauthenticated access to get-paddle-price",
    severity: "warn",
    source: "agent_security",
    summary: "The price-lookup edge function had no JWT check, allowing any caller to consume Paddle API quota.",
    fix: "Added Authorization header check and supabase.auth.getUser() validation; unauthenticated callers receive 401.",
    changes: [{ kind: "edge-function", path: "supabase/functions/get-paddle-price/index.ts" }],
  },
  {
    id: "raw_auth_errors_app",
    date: "2026-05-07",
    title: "Raw auth/DB error messages across app pages",
    severity: "warn",
    source: "agent_security",
    summary: "Auth.tsx, BugCreate.tsx, and BugDetail.tsx surfaced raw error.message strings, enabling user enumeration and schema leakage.",
    fix: "All toasts switched to generic copy; raw errors logged to console only.",
    changes: [
      { kind: "file", path: "src/pages/Auth.tsx" },
      { kind: "file", path: "src/pages/BugCreate.tsx" },
      { kind: "file", path: "src/pages/BugDetail.tsx" },
    ],
  },
  {
    id: "server_side_length_limits",
    date: "2026-05-07",
    title: "Missing server-side length limits on user content",
    severity: "warn",
    source: "agent_security",
    summary: "Bug and comment fields had no length enforcement at the database level, relying only on client-side validation.",
    fix: "Added CHECK constraints on bugs (title ≤ 200, description/steps ≤ 5000, expected/actual ≤ 2000, environment ≤ 200) and comments.content ≤ 2000.",
    changes: [{ kind: "migration", path: "supabase/migrations/20260507083102_*.sql" }],
  },
  {
    id: "company_settings_delete",
    date: "2026-05-07",
    title: "Missing DELETE policy on company_settings",
    severity: "warn",
    source: "supabase_lov",
    summary: "Owners could not delete their own company settings; no explicit DELETE policy existed.",
    fix: "Recreated owner-scoped DELETE policy: USING (auth.uid() = user_id).",
    changes: [{ kind: "migration", path: "supabase/migrations/20260507083102_*.sql" }],
  },
  {
    id: "invitations_role_scoped",
    date: "2026-05-07",
    title: "Role-scoped invitation creation",
    severity: "warn",
    source: "supabase_lov",
    summary: "Non-admins could potentially create invitations for elevated roles.",
    fix: "Recreated INSERT policy on invitations: only admins can invite at moderator/admin roles; all authenticated users may invite at 'user' role.",
    changes: [{ kind: "migration", path: "supabase/migrations/20260507083102_*.sql" }],
  },
  {
    id: "public_bucket_listing",
    date: "2026-05-07",
    title: "Public avatars bucket allowed enumeration",
    severity: "warn",
    source: "supabase_linter",
    summary: "Broad SELECT policy on storage.objects let any authenticated user list every avatar in the bucket.",
    fix: "Replaced with a folder-scoped policy: users can only list their own avatar folder. Public URLs continue to resolve.",
    changes: [{ kind: "migration", path: "supabase/migrations (avatars policy)" }],
  },
  {
    id: "security_definer_function",
    date: "2026-05-07",
    title: "SECURITY DEFINER function callable by signed-in users",
    severity: "warn",
    source: "supabase_linter",
    summary: "get_team_members ran with elevated privileges, bypassing RLS for any authenticated caller.",
    fix: "Switched to SECURITY INVOKER; added an authenticated SELECT policy on user_roles to preserve intentional team-wide visibility.",
    changes: [{ kind: "migration", path: "supabase/migrations (get_team_members)" }],
  },
  {
    id: "user_roles_team_visibility",
    date: "2026-06-15",
    title: "user_roles RLS blocked intentional team visibility",
    severity: "warn",
    source: "agent_security",
    summary: "A later hardening migration removed broad role visibility, causing team member and authorization views to see only partial role data.",
    fix: "Restored authenticated SELECT visibility on user_roles and split admin mutation into explicit INSERT, UPDATE, and DELETE policies with WITH CHECK on writes.",
    changes: [{ kind: "migration", path: "supabase/migrations/20260615122000_fix_user_roles_rls.sql" }],
  },
  {
    id: "tracked_env_file",
    date: "2026-06-15",
    title: "Tracked .env file in public repository",
    severity: "warn",
    source: "agent_security",
    summary: "The repository tracked a Vite environment file containing Supabase project wiring. Even publishable keys should not be maintained in committed local env files.",
    fix: "Removed the tracked .env file, added .env/.env.* ignore rules, and committed a safe .env.example template.",
    changes: [
      { kind: "file", path: ".env" },
      { kind: "file", path: ".gitignore" },
      { kind: "file", path: ".env.example" },
    ],
  },
  {
    id: "team_members_rpc_execute",
    date: "2026-06-15",
    title: "Team members RPC missing authenticated EXECUTE grant",
    severity: "warn",
    source: "agent_security",
    summary: "Earlier revokes removed broad EXECUTE access from get_team_members(); after conversion to SECURITY INVOKER, the Settings Team tab still calls that RPC directly.",
    fix: "Granted EXECUTE on get_team_members() to authenticated so the RPC boundary matches the intended signed-in team view.",
    changes: [{ kind: "migration", path: "supabase/migrations/20260615123500_grant_team_members_rpc.sql" }],
  },
];

const sourceLabel: Record<Entry["source"], string> = {
  agent_security: "Agent scan",
  supabase_lov: "Backend scan",
  supabase_linter: "DB linter",
};

const kindIcon = (kind: Change["kind"]) => {
  if (kind === "edge-function") return Server;
  if (kind === "migration") return Database;
  return FileCode;
};

export default function SecurityAudit() {
  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-4 md:px-6 h-11 border-b border-border shrink-0">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h1 className="text-[13px] font-medium">Security audit trail</h1>
          <Badge variant="secondary" className="text-2xs ml-auto">
            {entries.length} fixes applied
          </Badge>
        </div>

        <div className="flex-1 overflow-auto">
          <div className="px-4 md:px-6 py-4 border-b border-border">
            <p className="text-[12px] text-muted-foreground leading-relaxed max-w-2xl">
              Record of security findings remediated in this project. Each entry captures the issue,
              the fix applied, and the files, edge functions, or migrations changed.
            </p>
          </div>

          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="px-4 md:px-6 py-4">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-[13px] font-medium">{e.title}</span>
                      <Badge variant="outline" className="text-2xs uppercase tracking-wide">
                        {e.severity}
                      </Badge>
                      <Badge variant="secondary" className="text-2xs">
                        {sourceLabel[e.source]}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground ml-auto">{e.date}</span>
                    </div>
                    <p className="text-[12px] text-muted-foreground leading-relaxed mb-1.5">
                      <span className="text-foreground/80 font-medium">Issue: </span>
                      {e.summary}
                    </p>
                    <p className="text-[12px] text-muted-foreground leading-relaxed mb-2">
                      <span className="text-foreground/80 font-medium">Fix: </span>
                      {e.fix}
                    </p>
                    <ul className="space-y-1">
                      {e.changes.map((c, i) => {
                        const Icon = kindIcon(c.kind);
                        return (
                          <li key={i} className="flex items-center gap-2 text-[12px] font-mono text-muted-foreground">
                            <Icon className="h-3 w-3 shrink-0 text-primary/70" />
                            <span className="truncate">{c.path}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </AppLayout>
  );
}
