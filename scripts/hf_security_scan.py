#!/usr/bin/env python3
"""
HF Security Intelligence Scanner
Hourly automated scan of Hugging Face Hub for security-related repositories.
Generates a structured intelligence digest, saves it to Notion, and emails
an HTML summary to the configured recipient.

Required GitHub Secrets:
  ANTHROPIC_API_KEY   - Anthropic API key for Claude-based classification
  NOTION_TOKEN        - Notion integration token
  NOTION_PAGE_ID      - (optional) Parent Notion page ID; defaults to workspace root
  SMTP_USER           - Gmail address used to send digests
  SMTP_PASSWORD       - Gmail app password (not account password)
  NOTIFICATION_EMAIL  - Recipient email address

Optional env vars (with defaults):
  SCAN_WINDOW_HOURS   - How many hours back to look (default: 2, gives overlap between runs)
  GITHUB_RUN_NUMBER   - Injected automatically by GitHub Actions
"""

import os
import sys
import json
import time
import datetime
import smtplib
import requests
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

try:
    import anthropic
    _HAS_ANTHROPIC = True
except ImportError:
    _HAS_ANTHROPIC = False

# ── Configuration ──────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY  = os.environ.get("ANTHROPIC_API_KEY", "")
NOTION_TOKEN       = os.environ.get("NOTION_TOKEN", "")
NOTION_PAGE_ID     = os.environ.get("NOTION_PAGE_ID", "")
SMTP_USER          = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD      = os.environ.get("SMTP_PASSWORD", "")
NOTIFICATION_EMAIL = os.environ.get("NOTIFICATION_EMAIL", "dejager.sa@gmail.com")
RUN_NUMBER         = os.environ.get("GITHUB_RUN_NUMBER", os.environ.get("RUN_NUMBER", "manual"))
SCAN_WINDOW_HOURS  = int(os.environ.get("SCAN_WINDOW_HOURS", "2"))

SECURITY_QUERIES = [
    "cybersecurity", "malware", "ransomware", "exploit", "phishing",
    "osint", "threat-intelligence", "red-team", "pentest", "yara",
    "sigma", "reverse-engineering", "vulnerability", "stealer",
    "botnet", "infostealer", "CVE", "malware-analysis", "forensic",
    "detection-engineering", "c2",
]

REPO_TYPES = ["models", "datasets", "spaces"]

# ── Hugging Face Hub Scan ──────────────────────────────────────────────────────

def fetch_hf_repos(query: str, repo_type: str, limit: int = 30) -> list[dict]:
    try:
        r = requests.get(
            f"https://huggingface.co/api/{repo_type}",
            params={"search": query, "sort": "lastModified", "direction": -1,
                    "limit": limit, "full": "true"},
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as exc:
        print(f"  WARNING  HF API [{repo_type}] query='{query}': {exc}", file=sys.stderr)
        return []


def is_recent(repo: dict, hours: int) -> bool:
    ts = repo.get("lastModified") or repo.get("createdAt", "")
    if not ts:
        return False
    try:
        modified = datetime.datetime.fromisoformat(ts.rstrip("Z") + "+00:00")
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
        return modified > cutoff
    except Exception:
        return False


def collect_repos() -> list[dict]:
    seen: dict[str, dict] = {}
    total_fetched = 0
    for query in SECURITY_QUERIES:
        for repo_type in REPO_TYPES:
            repos = fetch_hf_repos(query, repo_type)
            total_fetched += len(repos)
            for repo in repos:
                rid = repo.get("id") or repo.get("modelId") or repo.get("repoId", "")
                if not rid or rid in seen:
                    continue
                if is_recent(repo, SCAN_WINDOW_HOURS):
                    repo["_type"] = repo_type.rstrip("s")
                    repo["_match_query"] = query
                    seen[rid] = repo
        time.sleep(0.1)  # gentle rate-limiting between queries
    print(f"  Fetched {total_fetched} entries -> {len(seen)} unique recent repos")
    return list(seen.values())


# ── Claude Digest Generation ───────────────────────────────────────────────────

_DIGEST_SCHEMA = """{
  "executive_summary": "2-3 sentence analyst summary. Lead with the highest-risk finding.",
  "high_signal": [
    {
      "name": "owner/repo-name",
      "type": "Model|Dataset|Space",
      "url": "https://hf.co/...",
      "author": "username",
      "created": "YYYY-MM-DD",
      "modified": "YYYY-MM-DD",
      "tags": ["tag1", "tag2"],
      "summary": "One sentence description.",
      "why_matched": "Specific signal that triggered inclusion.",
      "risk_level": "HIGH|MEDIUM|LOW",
      "classification": "Defensive|Educational|Research|Dual-use|Suspicious",
      "trend_indicator": "new|trending|updated"
    }
  ],
  "patterns": ["Pattern 1", "Pattern 2"],
  "watchlist": [
    {"item": "repo or author name", "reason": "brief rationale", "priority": "HIGH|MEDIUM|LOW"}
  ],
  "false_positives": ["Item -- reason it is noise"],
  "actions": ["Action 1", "Action 2"],
  "top_finding": "One-line summary of the top finding (used in email subject)"
}"""


def _stub_digest(repos: list[dict], reason: str) -> dict:
    today = datetime.date.today().isoformat()
    if repos:
        summary = f"Found {len(repos)} recently modified security repositories. {reason}"
        top = f"{len(repos)} repos found - API key needed for classification"
    else:
        summary = f"No new or recently modified security repositories in the last {SCAN_WINDOW_HOURS}-hour window."
        top = "No new findings"
    return {
        "date": today, "run": RUN_NUMBER, "total": len(repos),
        "executive_summary": summary,
        "high_signal": [], "patterns": [], "watchlist": [],
        "false_positives": [], "actions": [reason] if reason else [],
        "top_finding": top,
    }


def generate_digest(repos: list[dict]) -> dict:
    today = datetime.date.today().isoformat()

    if not repos:
        return _stub_digest([], "")

    if not ANTHROPIC_API_KEY or not _HAS_ANTHROPIC:
        return _stub_digest(repos, "Set ANTHROPIC_API_KEY to enable Claude classification.")

    repo_data = json.dumps([{
        "id":        r.get("id", r.get("modelId", r.get("repoId", ""))),
        "type":      r.get("_type", ""),
        "author":    (r.get("author") or
                      (r.get("owner", {}).get("name", "") if isinstance(r.get("owner"), dict) else "")),
        "tags":      (r.get("tags") or [])[:20],
        "downloads": r.get("downloads", 0),
        "likes":     r.get("likes", 0),
        "created":   (r.get("createdAt", "") or "")[:10],
        "modified":  (r.get("lastModified", "") or "")[:10],
        "gated":     r.get("gated", False),
        "query":     r.get("_match_query", ""),
    } for r in repos], indent=2)

    prompt = f"""You are a cybersecurity intelligence analyst reviewing Hugging Face Hub repositories.
Scan date: {today} | Run: #{RUN_NUMBER} | Window: last {SCAN_WINDOW_HOURS} hours | Repos: {len(repos)}

HIGH-RISK indicators -> classify Suspicious or Dual-use:
  abliteration, uncensored, decensored, heretic, offensive-security, jailbreak,
  stealer, infostealer, botnet, c2, ransomware, malware-payload, exploit-kit, credential-theft

WATCHLIST indicators:
  red-team, pentest, hacking, bug-bounty + gated repo, fast download growth

NOISE / FALSE POSITIVE indicators:
  re-uploads of known datasets (Fenrir v2.x, Trendyol cybersecurity), student projects
  with 0 downloads and no offensive tags, purely synthetic academic datasets

REPOSITORIES:
{repo_data}

Return ONLY valid JSON matching this schema exactly (no markdown fences, no extra keys):
{_DIGEST_SCHEMA}

Rules:
- Include only repos with genuine security relevance in high_signal.
- Sort high_signal by risk_level: HIGH first, then MEDIUM, then LOW.
- Do NOT include exploit steps, payload code, C2 setup, persistence techniques, or credential theft instructions.
- Keep language concise and analyst-style."""

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = "\n".join(raw.splitlines()[1:])
        if raw.endswith("```"):
            raw = raw[:-3].strip()

    result = json.loads(raw)
    result["date"] = today
    result["run"] = RUN_NUMBER
    result["total"] = len(repos)
    return result


# ── Notion ─────────────────────────────────────────────────────────────────────

def _notion_blocks(text: str) -> list[dict]:
    """Split text into Notion paragraph blocks (<=2000 chars each)."""
    return [
        {"object": "block", "type": "paragraph",
         "paragraph": {"rich_text": [{"type": "text", "text": {"content": chunk}}]}}
        for chunk in [text[i:i+1990] for i in range(0, len(text), 1990)]
    ]


def save_to_notion(digest: dict) -> str | None:
    if not NOTION_TOKEN:
        print("  WARNING  NOTION_TOKEN not set -- skipping Notion save", file=sys.stderr)
        return None

    today = digest["date"]
    run   = digest["run"]
    high  = digest.get("high_signal", [])
    title = f"HF Security Intel Digest -- {today} [Run #{run}]"

    risk_icon = {"HIGH": "[HIGH]", "MEDIUM": "[MED]", "LOW": "[LOW]"}

    findings_text = ""
    for r in high:
        icon = risk_icon.get(r.get("risk_level", "LOW"), "[?]")
        findings_text += (
            f"\n\n{icon} {r.get('name','')} [{r.get('classification','')}]\n"
            f"URL: {r.get('url','')}\n"
            f"Type: {r.get('type','')} | Risk: {r.get('risk_level','')} | "
            f"Created: {r.get('created','')} | Modified: {r.get('modified','')}\n"
            f"Tags: {', '.join(r.get('tags', []))}\n"
            f"Summary: {r.get('summary','')}\n"
            f"Why matched: {r.get('why_matched','')}"
        )

    body = "\n".join([
        "EXECUTIVE SUMMARY",
        digest.get("executive_summary", ""),
        "",
        f"HIGH-SIGNAL FINDINGS ({len(high)}){findings_text or chr(10) + 'None in this scan window.'}",
        "",
        "EMERGING PATTERNS",
        "\n".join(f"- {p}" for p in digest.get("patterns", [])) or "None identified.",
        "",
        "WATCHLIST",
        "\n".join(f"[{w.get('priority','')}] {w.get('item','')} -- {w.get('reason','')}"
                  for w in digest.get("watchlist", [])) or "None.",
        "",
        "FALSE POSITIVES / NOISE",
        "\n".join(f"- {fp}" for fp in digest.get("false_positives", [])) or "None.",
        "",
        "RECOMMENDED ACTIONS",
        "\n".join(f"{i+1}. {a}" for i, a in enumerate(digest.get("actions", []))) or "None.",
        "",
        "---",
        f"Scan: Run #{run} | {today} | {digest.get('total',0)} repos | Window: {SCAN_WINDOW_HOURS}h",
        "Automated scan -- defensive posture only.",
    ])

    parent = ({"page_id": NOTION_PAGE_ID} if NOTION_PAGE_ID
              else {"type": "workspace", "workspace": True})
    payload = {
        "parent": parent,
        "properties": {"title": [{"type": "text", "text": {"content": title}}]},
        "children": _notion_blocks(body),
    }
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }
    r = requests.post("https://api.notion.com/v1/pages", headers=headers,
                      json=payload, timeout=30)
    if r.ok:
        page_id = r.json().get("id", "")
        page_url = r.json().get("url", "")
        print(f"  OK  Notion page created: {page_url or page_id}")
        return page_id
    print(f"  ERROR  Notion {r.status_code}: {r.text[:300]}", file=sys.stderr)
    return None


# ── Email ──────────────────────────────────────────────────────────────────────

def send_email(digest: dict) -> bool:
    if not SMTP_USER or not SMTP_PASSWORD:
        print("  WARNING  SMTP credentials not set -- skipping email", file=sys.stderr)
        return False

    today   = digest["date"]
    run     = digest["run"]
    subject = f"[HF SecIntel] Digest #{run} -- {today} | {digest.get('top_finding', 'See report')}"
    high    = digest.get("high_signal", [])

    def rc(lvl: str) -> str:
        return {"HIGH": "#dc2626", "MEDIUM": "#d97706", "LOW": "#16a34a"}.get(lvl, "#6b7280")

    rows = "".join(
        f'<tr>'
        f'<td style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">'
        f'<a href="{r.get("url","")}" style="color:{rc(r.get("risk_level",""))};font-weight:600;">'
        f'{r.get("name","")}</a></td>'
        f'<td style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">{r.get("type","")}</td>'
        f'<td style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;'
        f'color:{rc(r.get("risk_level",""))};font-weight:700;">{r.get("risk_level","")}</td>'
        f'<td style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">{r.get("classification","")}</td>'
        f'<td style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">{r.get("summary","")[:90]}</td>'
        f'</tr>'
        for r in high[:12]
    )

    def li_list(items: list[str]) -> str:
        return "".join(f"<li style='margin-bottom:3px;'>{i}</li>" for i in items) or "<li>None.</li>"

    watchlist_li = "".join(
        f"<li style='margin-bottom:3px;'><strong>[{w.get('priority','')}]</strong> "
        f"{w.get('item','')} -- {w.get('reason','')}</li>"
        for w in digest.get("watchlist", [])
    ) or "<li>None.</li>"

    table_html = (
        f'<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">'
        f'<thead><tr style="background:#f3f4f6;">'
        f'<th style="text-align:left;padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">Repository</th>'
        f'<th style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">Type</th>'
        f'<th style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">Risk</th>'
        f'<th style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">Class</th>'
        f'<th style="padding:7px 9px;border:1px solid #e5e7eb;font-size:12px;">Summary</th>'
        f'</tr></thead><tbody>{rows}</tbody></table>'
        if rows else '<p style="font-size:13px;color:#6b7280;">No new findings in this scan window.</p>'
    )

    html = f"""<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:780px;margin:0 auto;color:#111827;">
<div style="background:#0f172a;color:#f8fafc;padding:16px 22px;border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:16px;font-weight:700;">HF Security Intelligence Digest</h1>
  <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">
    Run #{run} &middot; {today} &middot; {digest.get('total',0)} repos reviewed &middot; {SCAN_WINDOW_HOURS}h window
  </p>
</div>
<div style="border:1px solid #e2e8f0;border-top:none;padding:20px 22px;border-radius:0 0 8px 8px;">
  <div style="background:#f8fafc;border-left:4px solid #3b82f6;padding:11px 14px;margin-bottom:18px;border-radius:0 6px 6px 0;">
    <p style="margin:0;font-size:13px;line-height:1.6;">
      <strong>Executive Summary:</strong> {digest.get('executive_summary','')}
    </p>
  </div>
  <h2 style="font-size:13px;font-weight:700;margin:0 0 9px;color:#374151;">High-Signal Findings ({len(high)})</h2>
  {table_html}
  <h2 style="font-size:13px;font-weight:700;margin:0 0 8px;color:#374151;">Emerging Patterns</h2>
  <ul style="font-size:12px;padding-left:15px;margin-bottom:14px;">{li_list(digest.get('patterns',[]))}</ul>
  <h2 style="font-size:13px;font-weight:700;margin:0 0 8px;color:#374151;">Watchlist</h2>
  <ul style="font-size:12px;padding-left:15px;margin-bottom:14px;">{watchlist_li}</ul>
  <h2 style="font-size:13px;font-weight:700;margin:0 0 8px;color:#374151;">Recommended Actions</h2>
  <ol style="font-size:12px;padding-left:15px;margin-bottom:14px;">{li_list(digest.get('actions',[]))}</ol>
  <p style="font-size:10px;color:#9ca3af;border-top:1px solid #e2e8f0;padding-top:10px;margin-top:10px;">
    Automated HF Security Intelligence &middot; canstralian/splat
    &middot; Run #{run} &middot; {today}<br>
    <em>Defensive posture only. No operational exploit details included.</em>
  </p>
</div></body></html>"""

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = SMTP_USER
        msg["To"]      = NOTIFICATION_EMAIL
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as srv:
            srv.login(SMTP_USER, SMTP_PASSWORD)
            srv.sendmail(SMTP_USER, NOTIFICATION_EMAIL, msg.as_string())
        print(f"  OK  Email sent to {NOTIFICATION_EMAIL}")
        return True
    except Exception as exc:
        print(f"  ERROR  Email: {exc}", file=sys.stderr)
        return False


# ── Entrypoint ─────────────────────────────────────────────────────────────────

def main() -> None:
    now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    sep = "=" * 60
    print(f"\n{sep}\nHF Security Intel Scan  Run #{RUN_NUMBER}  {now}\n{sep}\n")

    print("1/4  Collecting repositories from Hugging Face Hub...")
    repos = collect_repos()

    print(f"\n2/4  Generating digest via Claude ({len(repos)} repos)...")
    digest = generate_digest(repos)
    print(f"     {len(digest.get('high_signal',[]))} high-signal findings | "
          f"top: {digest.get('top_finding','--')}")

    print("\n3/4  Saving digest to Notion...")
    notion_id = save_to_notion(digest)

    print("\n4/4  Sending email summary...")
    sent = send_email(digest)

    print(f"\n{sep}")
    print(json.dumps({
        "run":           RUN_NUMBER,
        "date":          digest["date"],
        "repos_scanned": len(repos),
        "high_signal":   len(digest.get("high_signal", [])),
        "notion_page":   notion_id,
        "email_sent":    sent,
    }, indent=2))
    print(sep)


if __name__ == "__main__":
    main()
