#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Hourly scan of HF Models/Datasets/Spaces for cybersecurity-related repositories.
Saves digest to Notion and drafts email via Gmail.
"""

import os
import sys
import json
import base64
import hashlib
import datetime
import requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ── Config ────────────────────────────────────────────────────────────────────
HF_TOKEN        = os.getenv("HF_TOKEN", "")
NOTION_TOKEN    = os.getenv("NOTION_API_KEY", "")
NOTION_PAGE_ID  = os.getenv("NOTION_PARENT_PAGE_ID", "")  # parent page/DB
GMAIL_TO        = os.getenv("GMAIL_RECIPIENT", "dejager.sa@gmail.com")
SMTP_USER       = os.getenv("SMTP_USER", "")   # Gmail address
SMTP_PASS       = os.getenv("SMTP_APP_PASSWORD", "")  # Gmail app password
RUN_NUMBER      = os.getenv("GITHUB_RUN_NUMBER", "?")
STATE_FILE      = os.getenv("STATE_FILE", "/tmp/hf_secIntel_seen.json")

QUERIES = [
    "malware", "cybersecurity", "exploit", "phishing",
    "ransomware", "vulnerability", "pentest", "forensic",
    "stealer", "c2", "osint", "botnet", "backdoor",
]
REPO_TYPES = ["model", "dataset", "space"]

# Risk keywords that bump classification to Suspicious/Dual-use
SUSPICIOUS_KEYWORDS = {
    "c2", "command-and-control", "stealer", "infostealer", "rat",
    "keylogger", "botnet", "ransomware-payload", "dropper", "loader",
    "exploit-poc", "poc", "zero-click", "zero-day", "malware-source",
    "uncensored", "jailbreak", "bypass", "abliterat",
}
DUALUSE_KEYWORDS = {
    "red-team", "redteam", "pentest", "exploit", "offensive",
    "adversarial", "attack", "payload", "shellcode", "privilege-escalation",
}

CLASSIFY_DEFENSIVE = {
    "detection", "defensive", "blue-team", "soc", "dfir", "forensic",
    "incident-response", "threat-intelligence", "anomaly-detection",
    "intrusion-detection", "ids", "nids", "hids", "siem",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_seen() -> set:
    try:
        with open(STATE_FILE) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_seen(seen: set):
    with open(STATE_FILE, "w") as f:
        json.dump(list(seen), f)


def repo_id(repo: dict) -> str:
    return repo.get("id", repo.get("modelId", repo.get("_id", "")))


def classify(repo: dict) -> str:
    raw = json.dumps(repo).lower()
    tags = " ".join(repo.get("tags", []) + [repo.get("id", "")]).lower()
    if any(k in raw for k in SUSPICIOUS_KEYWORDS):
        return "Suspicious"
    if any(k in tags for k in DUALUSE_KEYWORDS):
        return "Dual-use"
    if any(k in tags for k in CLASSIFY_DEFENSIVE):
        return "Defensive"
    return "Research/Educational"


def risk_level(classification: str) -> str:
    return {"Suspicious": "HIGH", "Dual-use": "MEDIUM"}.get(classification, "LOW")


def hf_search(query: str, repo_type: str, limit: int = 30) -> list:
    headers = {}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"
    base = "https://huggingface.co/api"
    endpoint = {
        "model": f"{base}/models",
        "dataset": f"{base}/datasets",
        "space": f"{base}/spaces",
    }[repo_type]
    params = {
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": limit,
        "full": "true",
    }
    try:
        r = requests.get(endpoint, params=params, headers=headers, timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[WARN] HF search failed ({repo_type}/{query}): {e}", file=sys.stderr)
        return []


def is_recent(repo: dict, hours: int = 1) -> bool:
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
    for field in ("lastModified", "createdAt"):
        ts = repo.get(field)
        if ts:
            try:
                dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if dt >= cutoff:
                    return True
            except Exception:
                pass
    return False


# ── Scan ──────────────────────────────────────────────────────────────────────

def run_scan(lookback_hours: int = 1) -> list:
    seen = load_seen()
    findings = []
    seen_this_run: set = set()

    for query in QUERIES:
        for rtype in REPO_TYPES:
            repos = hf_search(query, rtype)
            for repo in repos:
                rid = repo_id(repo)
                if not rid or rid in seen or rid in seen_this_run:
                    continue
                if not is_recent(repo, lookback_hours):
                    continue
                seen_this_run.add(rid)
                classification = classify(repo)
                findings.append({
                    "id": rid,
                    "type": rtype.capitalize(),
                    "url": f"https://huggingface.co/{'datasets/' if rtype=='dataset' else 'spaces/' if rtype=='space' else ''}{rid}",
                    "author": repo.get("author", rid.split("/")[0] if "/" in rid else ""),
                    "created": repo.get("createdAt", ""),
                    "modified": repo.get("lastModified", ""),
                    "tags": repo.get("tags", [])[:10],
                    "downloads": repo.get("downloads", 0),
                    "likes": repo.get("likes", 0),
                    "classification": classification,
                    "risk": risk_level(classification),
                    "matched_query": query,
                })

    save_seen(seen | seen_this_run)
    return findings


# ── Notion ────────────────────────────────────────────────────────────────────

def notion_headers():
    return {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }


def build_notion_content(findings: list, run_n: str, scan_date: str) -> str:
    high   = [f for f in findings if f["risk"] == "HIGH"]
    medium = [f for f in findings if f["risk"] == "MEDIUM"]
    low    = [f for f in findings if f["risk"] == "LOW"]

    lines = [
        f"## Scan Metadata",
        f"- **Date**: {scan_date}",
        f"- **Run #**: {run_n}",
        f"- **Total new repositories**: {len(findings)}",
        f"- **High-risk**: {len(high)} | Medium: {len(medium)} | Low/Defensive: {len(low)}",
        "",
        "## Executive Summary",
    ]
    if not findings:
        lines.append("No new or recently modified cybersecurity-relevant repositories detected since last scan.")
        return "\n".join(lines)

    lines.append(
        f"Detected **{len(findings)}** new/updated repositories this hour. "
        f"{len(high)} flagged HIGH risk, {len(medium)} MEDIUM, {len(low)} Defensive/Educational."
    )
    lines.append("")

    for section, items, icon in [
        ("High-Risk / Suspicious", high, "🔴"),
        ("Dual-Use Watchlist", medium, "🟡"),
        ("Defensive / Research", low, "🟢"),
    ]:
        if not items:
            continue
        lines.append(f"## {icon} {section}")
        lines.append("")
        for f in items:
            tags_str = ", ".join(f["tags"][:6]) if f["tags"] else "—"
            lines += [
                f"### [{f['id']}]({f['url']})",
                f"- **Type**: {f['type']} | **Author**: {f['author']} | **Risk**: {f['risk']}",
                f"- **Classification**: {f['classification']} | **Matched query**: `{f['matched_query']}`",
                f"- **Downloads**: {f['downloads']} | **Likes**: {f['likes']}",
                f"- **Modified**: {f['modified'][:10] if f['modified'] else '—'} | **Created**: {f['created'][:10] if f['created'] else '—'}",
                f"- **Tags**: {tags_str}",
                "",
            ]

    return "\n".join(lines)


def save_to_notion(findings: list, run_n: str, scan_date: str):
    if not NOTION_TOKEN:
        print("[SKIP] NOTION_API_KEY not set — skipping Notion save.", file=sys.stderr)
        return None

    title = f"HF SecIntel Digest — {scan_date} | Run #{run_n}"
    content = build_notion_content(findings, run_n, scan_date)

    body: dict = {
        "properties": {"title": {"title": [{"text": {"content": title}}]}},
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text", "text": {"content": content[:1900]}}]},
            }
        ],
    }
    if NOTION_PAGE_ID:
        body["parent"] = {"page_id": NOTION_PAGE_ID}

    try:
        r = requests.post(
            "https://api.notion.com/v1/pages",
            headers=notion_headers(),
            json=body,
            timeout=20,
        )
        r.raise_for_status()
        page = r.json()
        print(f"[OK] Notion page created: {page.get('url', '')}")
        return page.get("url")
    except Exception as e:
        print(f"[ERROR] Notion save failed: {e}", file=sys.stderr)
        return None


# ── Email ─────────────────────────────────────────────────────────────────────

def build_email_html(findings: list, run_n: str, scan_date: str, notion_url: str) -> str:
    high   = [f for f in findings if f["risk"] == "HIGH"]
    medium = [f for f in findings if f["risk"] == "MEDIUM"]

    rows = ""
    for f in high + medium:
        badge = f'<span style="background:{"#cc0000" if f["risk"]=="HIGH" else "#e07000"};color:white;padding:2px 6px;border-radius:3px;font-size:11px">{f["risk"]}</span>'
        rows += f"""<tr>
          <td>{badge}</td>
          <td><a href="{f['url']}" style="color:#0066cc">{f['id']}</a></td>
          <td>{f['type']}</td>
          <td>{f['downloads']}</td>
          <td>{f['modified'][:10] if f['modified'] else '—'}</td>
          <td>{f['classification']}</td>
        </tr>"""

    if not rows:
        rows = '<tr><td colspan="6" style="color:#666;padding:12px">No high/medium risk items this hour.</td></tr>'

    notion_link = f'<a href="{notion_url}">Full report in Notion ↗</a>' if notion_url else "Notion link unavailable"

    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;font-size:14px;max-width:800px;margin:0 auto;padding:20px">
<h2 style="border-bottom:2px solid #cc0000;padding-bottom:6px">🛡️ HF Security Intelligence Digest #{run_n}</h2>
<p style="color:#666;font-size:12px">Scan date: {scan_date} &nbsp;|&nbsp; {notion_link}</p>
<p><strong>{len(findings)}</strong> new/updated repositories detected &nbsp;|&nbsp;
   <span style="color:#cc0000"><strong>{len(high)} HIGH</strong></span> &nbsp;
   <span style="color:#e07000"><strong>{len(medium)} MEDIUM</strong></span></p>
<table style="border-collapse:collapse;width:100%;font-size:13px">
  <tr style="background:#f0f0f0">
    <th style="padding:6px 8px;border:1px solid #ccc;text-align:left">Risk</th>
    <th style="padding:6px 8px;border:1px solid #ccc;text-align:left">Repository</th>
    <th style="padding:6px 8px;border:1px solid #ccc;text-align:left">Type</th>
    <th style="padding:6px 8px;border:1px solid #ccc;text-align:left">⬇</th>
    <th style="padding:6px 8px;border:1px solid #ccc;text-align:left">Modified</th>
    <th style="padding:6px 8px;border:1px solid #ccc;text-align:left">Class</th>
  </tr>
  {rows}
</table>
<hr style="margin-top:24px"/>
<p style="color:#888;font-size:11px">Generated by HF SecIntel Pipeline &nbsp;|&nbsp; Next scan: +1 hour</p>
</body></html>"""


def send_email(findings: list, run_n: str, scan_date: str, notion_url: str):
    if not SMTP_USER or not SMTP_PASS:
        print("[SKIP] SMTP_USER/SMTP_APP_PASSWORD not set — skipping email.", file=sys.stderr)
        return

    import smtplib

    high = [f for f in findings if f["risk"] == "HIGH"]
    med  = [f for f in findings if f["risk"] == "MEDIUM"]
    subject = f"[HF SecIntel] Digest #{run_n} — {scan_date} | {len(high)}H {len(med)}M findings"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = SMTP_USER
    msg["To"] = GMAIL_TO

    text = f"HF SecIntel Digest #{run_n} — {scan_date}\n{len(findings)} new repos | {len(high)} HIGH | {len(med)} MEDIUM\nFull report: {notion_url or 'N/A'}"
    html = build_email_html(findings, run_n, scan_date, notion_url)

    msg.attach(MIMEText(text, "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, GMAIL_TO, msg.as_string())
        print(f"[OK] Email sent to {GMAIL_TO}")
    except Exception as e:
        print(f"[ERROR] Email send failed: {e}", file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    lookback = int(os.getenv("LOOKBACK_HOURS", "1"))
    scan_date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    print(f"[START] HF SecIntel scan — {scan_date} (lookback {lookback}h)")
    findings = run_scan(lookback_hours=lookback)
    print(f"[SCAN] {len(findings)} new/updated relevant repositories found")

    if not findings and os.getenv("SKIP_EMPTY", "true") == "true":
        print("[SKIP] No new findings — skipping Notion/email output")
        return

    notion_url = save_to_notion(findings, RUN_NUMBER, scan_date)
    send_email(findings, RUN_NUMBER, scan_date, notion_url)
    print("[DONE]")


if __name__ == "__main__":
    main()
