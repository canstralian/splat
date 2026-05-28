"""
HF Security Intelligence Scanner
Runs hourly via HF Jobs scheduled run.
Requires HF Secrets: NOTION_TOKEN, NOTION_PARENT_PAGE_ID, GMAIL_TO
Optional: GMAIL_APP_PASSWORD, GMAIL_FROM (for SMTP delivery)
"""

import json
import os
import re
import smtplib
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
HF_API   = "https://huggingface.co/api"
STATE_FILE = Path(__file__).parent / "scan_state.json"

NOTION_TOKEN    = os.environ.get("NOTION_TOKEN", "")
NOTION_PARENT   = os.environ.get("NOTION_PARENT_PAGE_ID", "")  # page ID to nest digests under
GMAIL_TO        = os.environ.get("GMAIL_TO", "dejager.sa@gmail.com")
GMAIL_FROM      = os.environ.get("GMAIL_FROM", "")
GMAIL_APP_PASS  = os.environ.get("GMAIL_APP_PASSWORD", "")

SEARCH_QUERIES = [
    "cybersecurity",
    "malware",
    "ransomware",
    "threat intelligence",
    "phishing osint",
    "exploit CVE",
    "red team pentest",
    "reverse engineering",
    "infostealer botnet",
    "YARA sigma detection",
]

REPO_TYPES = ["models", "datasets", "spaces"]

# Risk classification keywords
SUSPICIOUS_TAGS = {
    "malware-source", "exploit", "c2", "command-and-control", "payload",
    "stealer", "infostealer", "botnet", "ransomware-builder", "phishing-kit",
    "backdoor-builder", "rootkit",
}
DUAL_USE_TAGS = {
    "red-team", "pentest", "penetration-testing", "hacking", "offensive-security",
    "exploit-development", "c2", "post-exploitation",
}
DEFENSIVE_TAGS = {
    "defensive-security", "detection", "soc", "dfir", "incident-response",
    "threat-intelligence", "malware-detection", "intrusion-detection",
    "threat-hunting", "blue-team", "forensic",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def hf_search(query: str, repo_type: str, limit: int = 30) -> list[dict]:
    """Query HF Hub API for repos, sorted by lastModified."""
    endpoint_map = {"models": "models", "datasets": "datasets", "spaces": "spaces"}
    ep = endpoint_map[repo_type]
    params = urllib.parse.urlencode({
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": limit,
        "full": "false",
    })
    url = f"{HF_API}/{ep}?{params}"
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"[WARN] {repo_type} query '{query}' failed: {e}")
        return []


def repo_id(item: dict, repo_type: str) -> str:
    """Stable repo identifier."""
    prefix = {"models": "", "datasets": "datasets/", "spaces": "spaces/"}[repo_type]
    return prefix + item.get("id", item.get("modelId", ""))


def classify(item: dict) -> str:
    tags = {t.lower() for t in item.get("tags", [])}
    name = (item.get("id", "") + " " + item.get("cardData", {}).get("description", "")).lower()
    if tags & SUSPICIOUS_TAGS or any(k in name for k in ("malware source", "exploit kit", "phishing kit")):
        return "Suspicious"
    if tags & DUAL_USE_TAGS:
        return "Dual-use"
    if tags & DEFENSIVE_TAGS:
        return "Defensive"
    if "research" in tags or "paper" in name:
        return "Research"
    return "Educational"


def risk_level(classification: str, downloads: int) -> str:
    if classification == "Suspicious":
        return "HIGH" if downloads > 50 else "MEDIUM-HIGH"
    if classification == "Dual-use":
        return "MEDIUM" if downloads > 100 else "LOW-MEDIUM"
    return "LOW"


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_scan": "", "scan_number": 0, "known_repos": [], "watchlist": []}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── Notion ────────────────────────────────────────────────────────────────────

def notion_request(method: str, path: str, body: dict | None = None) -> dict:
    url = f"https://api.notion.com/v1{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {NOTION_TOKEN}")
    req.add_header("Notion-Version", "2022-06-28")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def create_notion_page(title: str, markdown_body: str) -> str | None:
    if not NOTION_TOKEN:
        print("[WARN] NOTION_TOKEN not set — skipping Notion.")
        return None
    parent = ({"type": "page_id", "page_id": NOTION_PARENT}
              if NOTION_PARENT else {"type": "workspace", "workspace": True})
    blocks = _md_to_blocks(markdown_body)
    page = notion_request("POST", "/pages", {
        "parent": parent,
        "properties": {"title": {"title": [{"text": {"content": title}}]}},
        "children": blocks,
    })
    return page.get("url")


def _md_to_blocks(md: str) -> list[dict]:
    """Convert simple markdown to Notion block objects (paragraphs + headings)."""
    blocks = []
    for line in md.splitlines():
        if line.startswith("## "):
            blocks.append({"object": "block", "type": "heading_2",
                            "heading_2": {"rich_text": [{"type": "text", "text": {"content": line[3:]}}]}})
        elif line.startswith("### "):
            blocks.append({"object": "block", "type": "heading_3",
                            "heading_3": {"rich_text": [{"type": "text", "text": {"content": line[4:]}}]}})
        elif line.startswith("- "):
            blocks.append({"object": "block", "type": "bulleted_list_item",
                            "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": line[2:]}}]}})
        elif line.strip():
            blocks.append({"object": "block", "type": "paragraph",
                            "paragraph": {"rich_text": [{"type": "text", "text": {"content": line}}]}})
    return blocks[:100]  # Notion limit


# ── Email ─────────────────────────────────────────────────────────────────────

def send_email(subject: str, html_body: str):
    if not GMAIL_APP_PASS or not GMAIL_FROM:
        print("[WARN] GMAIL_FROM / GMAIL_APP_PASSWORD not set — skipping email.")
        return
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = GMAIL_FROM
    msg["To"]      = GMAIL_TO
    msg.attach(MIMEText(html_body, "html"))
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
            s.login(GMAIL_FROM, GMAIL_APP_PASS)
            s.sendmail(GMAIL_FROM, GMAIL_TO, msg.as_string())
        print(f"[OK] Email sent to {GMAIL_TO}")
    except Exception as e:
        print(f"[ERROR] Email failed: {e}")


# ── Digest builder ────────────────────────────────────────────────────────────

def build_digest(new_repos: list[dict], watchlist_updates: list[str],
                 scan_number: int, scan_time: str) -> tuple[str, str]:
    """Returns (markdown, html) digest."""
    priority1 = [r for r in new_repos if r["classification"] in ("Suspicious", "Dual-use")]
    priority2 = [r for r in new_repos if r["classification"] == "Research"]
    priority3 = [r for r in new_repos if r["classification"] in ("Defensive", "Educational")]

    total = len(new_repos)
    md_lines = [
        f"# HF Security Intelligence Digest",
        f"**Scan:** #{scan_number} | **Time:** {scan_time} UTC",
        f"**New repos found:** {total}",
        "",
        "## Executive Summary",
        f"Scan #{scan_number} identified **{total} new or updated repositories** across "
        f"{len(priority1)} dual-use/suspicious, {len(priority2)} research, "
        f"and {len(priority3)} defensive/educational categories.",
        "",
    ]

    if priority1:
        md_lines += ["## 🔴 Priority 1 — Dual-Use / Suspicious", ""]
        for r in priority1:
            md_lines += [
                f"### {r['id']}",
                f"- **Type:** {r['type']} | **Classification:** {r['classification']} "
                f"| **Risk:** {r['risk']}",
                f"- **Author:** {r['author']} | **Created:** {r['created']} | "
                f"**Updated:** {r['updated']}",
                f"- **Downloads:** {r['downloads']} | **Likes:** {r['likes']}",
                f"- **Tags:** {', '.join(r['tags'][:10])}",
                f"- **Why matched:** {r['why']}",
                f"- **URL:** {r['url']}",
                "",
            ]

    if priority2:
        md_lines += ["## 🟡 Priority 2 — Research", ""]
        for r in priority2:
            md_lines += [
                f"### {r['id']}",
                f"- **Type:** {r['type']} | **Risk:** {r['risk']}",
                f"- **Author:** {r['author']} | **Updated:** {r['updated']} "
                f"| **Downloads:** {r['downloads']}",
                f"- **Tags:** {', '.join(r['tags'][:8])}",
                f"- **URL:** {r['url']}",
                "",
            ]

    if priority3:
        md_lines += ["## 🟢 Priority 3 — Defensive / Educational", ""]
        for r in priority3:
            md_lines += [
                f"- [{r['id']}]({r['url']}) — {r['author']} | {r['updated']} "
                f"| {r['downloads']} downloads | {', '.join(r['tags'][:5])}",
            ]
        md_lines.append("")

    if watchlist_updates:
        md_lines += ["## 👁 Watchlist Updates", ""] + watchlist_updates + [""]

    md_lines += [
        "## Recommended Actions",
        "- Review Priority 1 items for ToS violations or operational misuse risk.",
        "- Monitor download velocity on high-risk repos.",
        "- Update threat intelligence feeds with newly identified tooling.",
        "",
        f"*Scanner v1.0 | {scan_time} UTC | Next run in ~1 hour*",
    ]

    markdown = "\n".join(md_lines)

    # Build HTML
    html = f"""<html><body style="font-family:sans-serif;font-size:13px;max-width:800px">
<h2>🛡️ HF Security Intelligence — Scan #{scan_number}</h2>
<p><strong>Time:</strong> {scan_time} UTC &nbsp;|&nbsp; <strong>New repos:</strong> {total}</p>
<hr>
<p>{len(priority1)} dual-use/suspicious &nbsp;|&nbsp; {len(priority2)} research &nbsp;|&nbsp;
{len(priority3)} defensive/educational</p>
<hr>"""

    if priority1:
        html += "<h3 style='color:#b00'>🔴 Priority 1 — Dual-Use / Suspicious</h3><table border='1' cellpadding='5' style='border-collapse:collapse;width:100%'><tr style='background:#f0f0f0'><th>Repo</th><th>Type</th><th>Risk</th><th>Downloads</th><th>Tags</th></tr>"
        for r in priority1:
            html += f"<tr><td><a href='{r['url']}'>{r['id']}</a></td><td>{r['type']}</td><td style='color:#b00'><b>{r['risk']}</b></td><td>{r['downloads']}</td><td>{', '.join(r['tags'][:5])}</td></tr>"
        html += "</table><br>"

    if priority2:
        html += "<h3 style='color:#c60'>🟡 Priority 2 — Research</h3><ul>"
        for r in priority2:
            html += f"<li><a href='{r['url']}'>{r['id']}</a> — {r['author']} | {r['updated']} | {r['downloads']} dl</li>"
        html += "</ul>"

    if priority3:
        html += "<h3 style='color:#0a0'>🟢 Priority 3 — Defensive</h3><ul>"
        for r in priority3:
            html += f"<li><a href='{r['url']}'>{r['id']}</a> — {r['author']} | {r['downloads']} dl</li>"
        html += "</ul>"

    if watchlist_updates:
        html += "<h3>👁 Watchlist Updates</h3><ul>" + "".join(f"<li>{u}</li>" for u in watchlist_updates) + "</ul>"

    html += f"<hr><p style='font-size:11px;color:#666'>Automated scan · {scan_time} UTC · No exploit guidance provided.</p></body></html>"

    return markdown, html


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    state       = load_state()
    known       = set(state["known_repos"])
    watchlist   = set(state.get("watchlist", []))
    scan_number = state["scan_number"] + 1
    scan_time   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")

    new_repos         = []
    watchlist_updates = []
    all_seen          = {}  # rid → item

    for query in SEARCH_QUERIES:
        for repo_type in REPO_TYPES:
            items = hf_search(query, repo_type)
            for item in items:
                rid = repo_id(item, repo_type)
                if not rid:
                    continue
                all_seen[rid] = (item, repo_type)

    for rid, (item, repo_type) in all_seen.items():
        downloads = item.get("downloads", 0) or 0
        likes     = item.get("likes", 0) or 0
        tags      = item.get("tags", [])
        author    = item.get("author", rid.split("/")[0] if "/" in rid else "")
        created   = (item.get("createdAt") or "")[:10]
        updated   = (item.get("lastModified") or item.get("updatedAt") or "")[:10]

        # Watchlist delta
        if rid in watchlist:
            prev_dl = state.get("watchlist_downloads", {}).get(rid, 0)
            if downloads > prev_dl:
                watchlist_updates.append(
                    f"`{rid}` — downloads {prev_dl}→{downloads} (+{downloads - prev_dl})"
                )
            continue  # don't re-report as new

        if rid in known:
            continue

        # New repo
        classification = classify(item)
        risk           = risk_level(classification, downloads)
        tags_matched   = [t for t in tags if any(
            k in t.lower() for k in
            ("malware","ransomware","exploit","phishing","red-team","pentest","threat",
             "osint","cve","sigma","yara","dfir","soc","c2","infostealer","botnet",
             "cybersecurity","vulnerability","reverse","forensic","backdoor","stealer")
        )]
        why = (f"Tags: {', '.join(tags_matched[:5])}" if tags_matched
               else f"Name match on query: {repo_type}/{rid}")

        new_repos.append({
            "id":             rid,
            "type":           repo_type.rstrip("s").capitalize(),
            "url":            f"https://hf.co/{rid}",
            "author":         author,
            "created":        created,
            "updated":        updated,
            "tags":           tags,
            "downloads":      downloads,
            "likes":          likes,
            "classification": classification,
            "risk":           risk,
            "why":            why,
        })

    if not new_repos and not watchlist_updates:
        print(f"[OK] No new findings — scan #{scan_number} complete at {scan_time} UTC")
    else:
        print(f"[SCAN #{scan_number}] {len(new_repos)} new repos | "
              f"{len(watchlist_updates)} watchlist updates")

        # Build digest
        markdown, html = build_digest(new_repos, watchlist_updates, scan_number, scan_time)
        title = f"HF Security Intel Digest — {scan_time} (Scan #{scan_number})"

        # Save to Notion
        notion_url = create_notion_page(title, markdown)
        if notion_url:
            print(f"[OK] Notion page: {notion_url}")

        # Send email
        subject = f"🛡️ HF Security Intel — {len(new_repos)} new repos — Scan #{scan_number}"
        send_email(subject, html)

    # Update state
    state["scan_number"]  = scan_number
    state["last_scan"]    = datetime.now(timezone.utc).isoformat()
    state["known_repos"]  = sorted(known | {r["id"] for r in new_repos})
    # Track watchlist download counts
    wdl = state.get("watchlist_downloads", {})
    for rid in watchlist:
        if rid in all_seen:
            wdl[rid] = all_seen[rid][0].get("downloads", 0) or 0
    state["watchlist_downloads"] = wdl
    save_state(state)
    print(f"[OK] State saved. Known repos: {len(state['known_repos'])}")


if __name__ == "__main__":
    main()
