import { Link } from "react-router-dom";
import { ArrowRight, Moon, Sun, Check, Zap, Keyboard, GitBranch, History, Shield } from "lucide-react";
import { Logo3D } from "@/components/Logo3D";
import testimonialAvatarAsset from "@/assets/testimonial-avatar.jpg.asset.json";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { StackedLogo } from "@/components/StackedLogo";

/** Splat magenta accent */
const SLATE_HSL = "322 85% 52%";
const SLATE_DARK = "322 90% 60%";

const LOGO_VARIANT = 1;
const CUBE_SIZE = 840;
const CUBE_OFFSET_X = -140;
const CUBE_OFFSET_Y = -80;

type Issue = {
  id: string;
  title: string;
  priority: "High" | "Medium" | "Low";
  status: "Triage" | "In Progress" | "Review" | "Backlog" | "Done";
  label: string;
  assignee: string;
  updated: string;
  comments: number;
};

const ISSUES: Issue[] = [
  { id: "TRG-142", title: "Fix websocket reconnect race condition", priority: "High", status: "In Progress", label: "infra", assignee: "JK", updated: "2m", comments: 4 },
  { id: "TRG-139", title: "Resolve stale optimistic update rollback", priority: "Medium", status: "Review", label: "logic", assignee: "AM", updated: "18m", comments: 2 },
  { id: "TRG-138", title: "Add markdown diff rendering", priority: "Low", status: "Backlog", label: "ui", assignee: "RS", updated: "1h", comments: 0 },
  { id: "TRG-135", title: "Refactor notification batching", priority: "Medium", status: "In Progress", label: "perf", assignee: "JK", updated: "3h", comments: 6 },
  { id: "TRG-131", title: "Implement issue dependency graph", priority: "High", status: "Triage", label: "logic", assignee: "DV", updated: "5h", comments: 1 },
  { id: "TRG-128", title: "Fix attachment upload timeout", priority: "Medium", status: "Done", label: "infra", assignee: "AM", updated: "1d", comments: 3 },
];

const priorityDot = (p: Issue["priority"]) =>
  p === "High" ? "bg-destructive" : p === "Medium" ? "bg-warning" : "bg-muted-foreground/40";

const statusDot = (s: Issue["status"]) =>
  s === "Done" ? "bg-success"
    : s === "In Progress" ? "bg-warning"
    : s === "Review" ? "bg-primary"
    : s === "Triage" ? "bg-destructive"
    : "bg-muted-foreground/40";

const Landing = () => {
  const { theme, setTheme } = useTheme();
  const [cubeZoom, setCubeZoom] = useState(() => {
    const w = typeof window !== "undefined" ? window.innerWidth : 1200;
    return w < 1024 ? 270 : 360;
  });

  useEffect(() => {
    const handleResize = () => {
      setCubeZoom(window.innerWidth < 1024 ? 270 : 360);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isDark = theme === "dark";
  const diagonalLineColor = isDark ? "hsl(240 4% 26%" : "hsl(240 4% 80%";

  useEffect(() => {
    const root = document.documentElement;
    const isDark = theme === "dark";
    const hsl = isDark ? SLATE_DARK : SLATE_HSL;
    root.style.setProperty("--primary", hsl);
    root.style.setProperty("--ring", hsl);
    root.style.setProperty("--sidebar-primary", hsl);
    root.style.setProperty("--sidebar-ring", hsl);
  }, [theme]);

  return (
    <div
      className="min-h-screen bg-background text-foreground overflow-x-hidden"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full bg-background border-b border-border px-6">
        <div className="mx-auto flex h-[56px] max-w-[1200px] items-center justify-between">
          <Link to="/" className="flex items-center gap-2 -ml-0.5">
            <StackedLogo size={16} />
            <span className="text-[14px] font-bold text-foreground tracking-[0.08em] uppercase">Splat</span>
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="h-11 w-11 md:h-8 md:w-8 flex items-center justify-center text-foreground/70 hover:text-foreground transition-colors"
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </button>
            <Link to="/auth">
              <button className="text-[13px] text-foreground/80 hover:text-foreground transition-colors h-11 md:h-8 px-3">
                Log in
              </button>
            </Link>
            <Link to="/auth">
              <button className="text-[13px] h-11 md:h-8 px-4 border border-foreground/40 text-foreground hover:bg-foreground hover:text-background transition-colors">
                Sign up
              </button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 pt-16 pb-0 px-6 overflow-hidden">
        <div className="mx-auto max-w-[1200px] relative">
          <div className="pt-[52px] pb-12 md:pb-16 relative flex">
            {/* Left column */}
            <div className="relative z-[3] flex-1 min-w-0 max-w-[560px]">
              <h1 className="text-[clamp(2.1rem,4.2vw,3.4rem)] font-[500] leading-[1.06] tracking-[-0.04em] text-foreground">
                Crush bugs faster.<br />Stay in flow.
              </h1>
              <p className="mt-6 text-[15px] md:text-base leading-relaxed text-foreground/75 max-w-[460px]">
                SPLAT is a lightweight, keyboard-first issue tracker for indie developers and small studios. Triage, prioritize, and resolve bugs without turning every fix into a meeting.
              </p>
              <div className="mt-8 md:mt-10 flex flex-wrap items-center gap-3">
                <Link to="/auth">
                  <button className="group relative inline-flex items-center gap-2 px-6 min-h-[44px] py-3 text-[14px] font-medium bg-foreground text-background transition-all duration-200 hover:bg-foreground/90">
                    Get started free
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </Link>
                <a href="#how-it-works">
                  <button className="inline-flex items-center gap-2 px-5 min-h-[44px] py-3 text-[14px] font-medium border border-foreground/30 text-foreground hover:bg-foreground/5 transition-colors">
                    See how it works
                  </button>
                </a>
              </div>
              <p className="mt-6 text-[12px] text-foreground/55 tracking-wide">
                Fast triage · Keyboard-first · GitHub-ready · Low ceremony
              </p>
            </div>

            {/* Right column — 3D cube */}
            <div className="hidden md:block flex-1 relative z-[1] pointer-events-none" style={{ minWidth: 0 }}>
              <div className="absolute top-1/2 right-0 -translate-y-1/2" style={{ width: CUBE_SIZE, height: CUBE_SIZE, transform: `translate(${-CUBE_OFFSET_X}px, calc(-50% + ${CUBE_OFFSET_Y}px))` }}>
                <Logo3D variant={LOGO_VARIANT} size={CUBE_SIZE} zoom={cubeZoom} bgHex={theme === "dark" ? "#0e0e10" : "#ffffff"} lineHex={theme === "dark" ? "#58585e" : "#c0c0c8"} />
              </div>
            </div>
          </div>

          {/* Product mock */}
          <div className="relative" style={{ overflow: "visible" }}>
            <div className="relative z-10 rounded-t-xl border border-b-0 border-border bg-card overflow-hidden">
              <div className="flex min-h-[420px]">
                {/* Sidebar mock — hidden on small */}
                <div className="hidden sm:flex w-[180px] border-r border-border p-3 flex-col gap-1 shrink-0">
                  <div className="flex items-center gap-2 px-2 h-8 mb-2">
                    <div className="h-4 w-4 rounded bg-primary/30" />
                    <span className="text-[11px] font-semibold tracking-wide text-foreground/80">SPLAT</span>
                  </div>
                  <div className="h-px bg-border" />
                  {["Inbox", "My issues", "Active", "Backlog"].map((label, i) => (
                    <div key={label} className={`flex items-center gap-2 px-2 h-7 rounded text-[11px] ${i === 2 ? "bg-accent text-foreground" : "text-foreground/65"}`}>
                      <div className="h-2 w-2 rounded-sm bg-muted-foreground/30 shrink-0" />
                      {label}
                    </div>
                  ))}
                  <div className="h-px bg-border my-1" />
                  <div className="px-2 mb-1 text-[10px] uppercase tracking-wider text-foreground/40">Projects</div>
                  {["Splat web", "Splat API", "Marketing"].map((p) => (
                    <div key={p} className="flex items-center gap-2 px-2 h-7 text-[11px] text-foreground/65">
                      <div className="h-2 w-2 rounded-full bg-primary/50 shrink-0" />
                      {p}
                    </div>
                  ))}
                </div>

                {/* Main — issue list */}
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="flex items-center gap-3 px-4 h-10 border-b border-border text-[11px] text-foreground/60">
                    <span className="font-medium text-foreground/80">All issues</span>
                    <span>·</span>
                    <span>{ISSUES.length} open</span>
                    <div className="ml-auto hidden sm:flex gap-2 text-foreground/50">
                      <span>Filter</span>
                      <span>Sort</span>
                    </div>
                  </div>
                  <div className="flex-1">
                    {ISSUES.map((row) => (
                      <div key={row.id} className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-10 border-b border-border hover:bg-accent/30 transition-colors">
                        <div className={`h-2 w-2 rounded-full shrink-0 ${priorityDot(row.priority)}`} title={row.priority} />
                        <span className="text-[11px] text-foreground/55 font-mono shrink-0 w-[58px]">{row.id}</span>
                        <span className="text-[12px] text-foreground/90 truncate flex-1">{row.title}</span>
                        <span className="hidden md:inline text-[10px] px-1.5 py-0.5 rounded border border-border text-foreground/55 shrink-0">{row.label}</span>
                        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                          <div className={`h-1.5 w-1.5 rounded-full ${statusDot(row.status)}`} />
                          <span className="text-[11px] text-foreground/60">{row.status}</span>
                        </div>
                        <span className="hidden lg:inline text-[11px] text-foreground/45 shrink-0 w-8 text-right">{row.updated}</span>
                        {row.comments > 0 && (
                          <span className="hidden md:inline text-[10px] text-foreground/45 shrink-0">{row.comments}c</span>
                        )}
                        <div className="h-5 w-5 rounded-full bg-muted-foreground/15 text-[9px] font-medium text-foreground/70 flex items-center justify-center shrink-0">{row.assignee}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Detail panel */}
                <div className="w-[260px] border-l border-border shrink-0 hidden lg:flex flex-col">
                  <div className="flex items-center justify-between px-4 h-10 border-b border-border">
                    <span className="text-[11px] font-mono text-foreground/55">TRG-142</span>
                    <div className={`h-2 w-2 rounded-full ${statusDot("In Progress")}`} />
                  </div>
                  <div className="p-4 space-y-3 text-[12px]">
                    <div className="text-[13px] font-medium text-foreground leading-snug">Fix websocket reconnect race condition</div>
                    <p className="text-foreground/60 leading-relaxed text-[11px]">
                      Reconnection retries fire before the previous socket fully tears down, causing duplicate event subscriptions.
                    </p>
                    <div className="h-px bg-border" />
                    {[
                      { label: "Status", value: "In Progress" },
                      { label: "Priority", value: "High" },
                      { label: "Assignee", value: "Jamie K." },
                      { label: "Branch", value: "fix/ws-reconnect" },
                    ].map((prop) => (
                      <div key={prop.label} className="flex items-center justify-between">
                        <span className="text-[11px] text-foreground/55">{prop.label}</span>
                        <span className="text-[11px] text-foreground/85">{prop.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
            </div>
          </div>
        </div>
      </section>

      <div className="relative z-10 w-full border-t border-border" />

      {/* Built for real development work */}
      <section className="relative z-10 pt-20 md:pt-24 pb-20 md:pb-24 px-6">
        <div className="mx-auto max-w-[1200px]">
          <p className="text-[12px] uppercase tracking-[0.18em] text-foreground/55 mb-4">Workflow</p>
          <h2 className="text-[clamp(1.8rem,3vw,2.4rem)] font-[500] tracking-[-0.03em] text-foreground leading-[1.15] max-w-[640px]">
            Built for real development work
          </h2>
          <p className="mt-4 text-[15px] text-foreground/70 max-w-[640px] leading-relaxed">
            SPLAT keeps the issue lifecycle tight: capture, triage, prioritize, fix, review, and close.
          </p>

          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-border">
            {[
              { icon: Zap, title: "Fast triage", desc: "Sort incoming bugs by severity, owner, label, and sprint state before your backlog turns into compost." },
              { icon: Keyboard, title: "Flow-first execution", desc: "Keyboard shortcuts, fast search, and minimal modal friction keep developers moving." },
              { icon: GitBranch, title: "Git-aware context", desc: "Connect issues to branches, commits, pull requests, and release notes so fixes stay traceable." },
              { icon: History, title: "Clear issue history", desc: "Every meaningful change leaves an activity trail, making decisions easier to review later." },
            ].map((f, i) => (
              <div key={f.title} className={`p-6 ${i < 3 ? "lg:border-r border-border" : ""} ${i % 2 === 0 ? "sm:border-r border-border" : ""} ${i > 0 ? "border-t sm:border-t-0 border-border" : ""} ${i > 1 ? "sm:border-t lg:border-t-0 border-border" : ""}`}>
                <div className="h-9 w-9 border border-border flex items-center justify-center mb-4">
                  <f.icon className="h-4 w-4 text-foreground/80" />
                </div>
                <h3 className="text-[14px] font-medium text-foreground mb-2">{f.title}</h3>
                <p className="text-[13px] leading-[1.6] text-foreground/65">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="relative z-10 w-full border-t border-border" />

      {/* How SPLAT works */}
      <section id="how-it-works" className="relative z-10 py-20 md:py-24 px-6">
        <div className="mx-auto max-w-[1200px]">
          <p className="text-[12px] uppercase tracking-[0.18em] text-foreground/55 mb-4">How it works</p>
          <h2 className="text-[clamp(1.8rem,3vw,2.4rem)] font-[500] tracking-[-0.03em] text-foreground leading-[1.15] max-w-[640px]">
            From bug to closed in five steps
          </h2>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-5 gap-px bg-border border border-border">
            {[
              { step: "01", title: "Capture", desc: "Log bugs quickly from the app or connected tools." },
              { step: "02", title: "Triage", desc: "Assign severity, labels, owner, and sprint state." },
              { step: "03", title: "Focus", desc: "Work from a clean prioritized queue." },
              { step: "04", title: "Resolve", desc: "Link fixes to branches, commits, and pull requests." },
              { step: "05", title: "Review", desc: "Audit status changes and close with confidence." },
            ].map((s) => (
              <div key={s.step} className="bg-background p-5">
                <div className="text-[11px] font-mono text-primary mb-3">{s.step}</div>
                <div className="text-[14px] font-medium text-foreground mb-1.5">{s.title}</div>
                <p className="text-[12px] leading-[1.55] text-foreground/65">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="relative z-10 w-full border-t border-border" />

      {/* Less Jira cosplay */}
      <section className="relative z-10 py-20 md:py-24 px-6">
        <div className="mx-auto max-w-[1200px]">
          <h2 className="text-[clamp(1.8rem,3vw,2.4rem)] font-[500] tracking-[-0.03em] text-foreground leading-[1.15] max-w-[640px]">
            Less Jira cosplay. More shipping.
          </h2>
          <p className="mt-4 text-[15px] text-foreground/70 max-w-[680px] leading-relaxed">
            SPLAT is for teams that need enough structure to stay aligned, but not so much process that fixing a typo requires a committee, a ritual, and three dashboards nobody reads.
          </p>

          <ul className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-3 max-w-[760px]">
            {[
              "No bloated project ceremony",
              "No meeting-first workflow",
              "No endless configuration maze",
              "No fake productivity theater",
              "Just fast issue capture, triage, and resolution",
            ].map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-[14px] text-foreground/85">
                <span className="text-destructive mt-[2px]">✕</span>
                <span>{b.replace(/^No /, "No ")}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="relative z-10 w-full border-t border-border" />

      {/* Trust the workflow */}
      <section className="relative z-10 py-20 md:py-24 px-6">
        <div className="mx-auto max-w-[1200px]">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="h-4 w-4 text-foreground/60" />
            <p className="text-[12px] uppercase tracking-[0.18em] text-foreground/55">Planned production controls</p>
          </div>
          <h2 className="text-[clamp(1.8rem,3vw,2.4rem)] font-[500] tracking-[-0.03em] text-foreground leading-[1.15] max-w-[640px]">
            Trust the workflow, not the vibes
          </h2>
          <p className="mt-4 text-[15px] text-foreground/70 max-w-[640px] leading-relaxed">
            SPLAT is designed around clear permissions, private workspaces, reversible changes, and readable issue history.
          </p>

          <ul className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-[760px]">
            {[
              "Workspace-scoped access",
              "Private projects by default",
              "Server-side authorization",
              "Reversible state changes",
              "Activity history for issue changes",
              "Safe file attachment handling",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-[14px] text-foreground/85">
                <Check className="h-4 w-4 text-primary shrink-0 mt-[2px]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="relative z-10 w-full border-t border-border" />

      {/* Social proof */}
      <section className="relative z-10 py-20 md:py-24 px-6 overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(
              -45deg,
              ${diagonalLineColor} / 0.55) 0px,
              ${diagonalLineColor} / 0.55) 1px,
              transparent 1px,
              transparent 8px
            )`,
            backgroundSize: "100% 100%",
          }}
        />
        <div className="mx-auto max-w-[1200px] relative">
          <div className="border border-border bg-background p-8 md:p-10 max-w-[720px] mx-auto">
            <blockquote className="text-[18px] md:text-[20px] font-[400] leading-[1.5] tracking-[-0.01em] text-foreground/90">
              "I tried Linear, Jira, three Notion templates, and a Trello board. Splat is the first one I actually open every morning."
            </blockquote>
            <div className="mt-6 flex items-center gap-3">
              <img src={testimonialAvatarAsset.url} alt="Jamie Kim" className="h-8 w-8 rounded-full object-cover" />
              <div>
                <span className="text-[13px] font-medium text-foreground">Jamie Kim</span>
                <span className="text-[13px] text-foreground/60 ml-2">Solo founder, Inkpath</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="relative z-10 w-full border-t border-border" />

      {/* CTA */}
      <section className="relative z-10 pt-24 md:pt-32 pb-28 md:pb-40 px-6">
        <div className="mx-auto max-w-[1200px] text-center relative">
          <h2 className="text-[clamp(2rem,4vw,3.2rem)] font-[500] tracking-[-0.035em] text-foreground leading-[1.1] mx-auto max-w-[560px]">
            Stop losing bugs in your Notes app.
          </h2>
          <p className="mt-5 text-[15px] text-foreground/70 max-w-[440px] mx-auto leading-relaxed">
            Two minutes to set up. No credit card. No sales call.<br />Just fewer bugs, starting now.
          </p>
          <div className="mt-10 flex justify-center">
            <Link to="/auth">
              <button className="group relative inline-flex items-center gap-2.5 px-8 min-h-[48px] py-3.5 text-[15px] font-medium transition-all duration-200 border border-foreground/40 text-foreground hover:bg-foreground hover:text-background hover:border-foreground">
                Splat your first bug
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border">
        <div className="mx-auto max-w-[1200px] px-6 py-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
            <div>
              <div className="text-[11px] uppercase tracking-[0.15em] text-foreground/55 mb-3">Product</div>
              <ul className="space-y-2 text-[13px] text-foreground/75">
                <li><a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a></li>
                <li><Link to="/auth" className="hover:text-foreground transition-colors">Sign up</Link></li>
                <li><span className="text-foreground/45">Changelog · soon</span></li>
              </ul>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.15em] text-foreground/55 mb-3">Trust</div>
              <ul className="space-y-2 text-[13px] text-foreground/75">
                <li><span className="text-foreground/45">Security · soon</span></li>
                <li><span className="text-foreground/45">Privacy · soon</span></li>
                <li><span className="text-foreground/45">Status · soon</span></li>
              </ul>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.15em] text-foreground/55 mb-3">Community</div>
              <ul className="space-y-2 text-[13px] text-foreground/75">
                <li><span className="text-foreground/45">GitHub · soon</span></li>
                <li><span className="text-foreground/45">Contact · soon</span></li>
              </ul>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.15em] text-foreground/55 mb-3">Splat</div>
              <p className="text-[13px] text-foreground/65 leading-relaxed">
                A flow-state issue tracker for indie developers and small studios.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-6">
            <div className="flex items-center gap-2 -ml-0.5">
              <StackedLogo size={16} />
              <span className="text-[12px] font-bold text-foreground uppercase tracking-[0.08em]">Splat</span>
            </div>
            <span className="text-[12px] text-foreground/55">© {new Date().getFullYear()}</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
