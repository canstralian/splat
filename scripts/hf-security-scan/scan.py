#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Scans HF Hub hourly for cybersecurity-relevant repositories and publishes
a structured digest to Notion and Gmail.
"""

import os
import json
import time
import datetime
import requests
from typing import Optional

# ── Config ────────────────────────────────────────────────────────────────────
HF_TOKEN = os.environ.get("HF_TOKEN", "")
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
NOTION_DATABASE_ID = os.environ.get(
    "NOTION_DATABASE_ID", "d9311332-6b18-45bf-8884-6c98f99e69dc"
)
GMAIL_TOKEN = os.environ.get("GMAIL_TOKEN", "")  # OAuth2 access token
RECIPIENT_EMAIL = os.environ.get("RECIPIENT_EMAIL", "dejager.sa@gmail.com")

HF_API = "https://huggingface.co/api"
NOTION_API = "https://api.notion.com/v1"

SCAN_QUERIES = [
    ("cybersecurity malware ransomware exploit", ["model", "dataset", "space"]),
    ("phishing infostealer stealer botnet credential theft", ["model", "dataset", "space"]),
    ("threat intelligence OSINT CVE vulnerability research", ["model", "dataset", "space"]),
    ("YARA sigma reverse engineering forensics malware analysis", ["model", "dataset", "space"]),
    ("detection engineering red-team pentest C2 offensive security", ["model", "dataset", "space"]),
    ("cybersecurity", ["model", "dataset", "space"]),
    ("exploit hacking penetration testing", ["model", "dataset", "space"]),
]

WATCHLIST_TAGS = {
    "abliteration", "uncensored", "decensored", "heretic", "jailbreak",
    "offensive-security", "red-team", "c2", "stealer", "botnet", "infostealer",
    "ransomware", "malware", "exploit", "phishing", "keylogger", "rootkit",
}

HIGH_RISK_TAGS = {"abliteration", "uncensored", "decensored", "heretic", "c2", "stealer", "botnet", "ransomware"}


# ── HF Hub API ────────────────────────────────────────────────────────────────

def hf_headers() -> dict:
    h = {"Accept": "application/json"}
    if HF_TOKEN:
        h["Authorization"] = f"Bearer {HF_TOKEN}"
    return h


def search_repos(query: str, repo_type: str, limit: int = 30, sort: str = "lastModified") -> list[dict]:
    endpoint_map = {"model": "models", "dataset": "datasets", "space": "spaces"}
    endpoint = endpoint_map.get(repo_type, "models")
    params = {
        "search": query,
        "sort": sort,
        "limit": limit,
        "full": "true",
    }
    try:
        r = requests.get(f"{HF_API}/{endpoint}", params=params, headers=hf_headers(), timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[WARN] HF search failed ({repo_type}, {query!r}): {e}")
        return []


def is_recent(repo: dict, since_hours: int = 1) -> bool:
    for field in ("lastModified", "createdAt"):
        val = repo.get(field)
        if val:
            try:
                ts = datetime.datetime.fromisoformat(val.replace("Z", "+00:00"))
                cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=since_hours)
                if ts >= cutoff:
                    return True
            except ValueError:
                pass
    return False


# ── Classification ─────────────────────────────────────────────────────────────

def classify(repo: dict) -> str:
    tags = set(t.lower() for t in repo.get("tags", []))
    name_lower = (repo.get("id") or repo.get("modelId") or "").lower()

    if tags & HIGH_RISK_TAGS or any(w in name_lower for w in ("heretic", "abliter", "uncensor")):
        return "Suspicious"
    if tags & {"offensive-security", "c2", "stealer", "botnet", "ransomware", "malware"}:
        return "Dual-use"
    if tags & {"red-team", "pentest", "penetration-testing", "exploit"}:
        return "Dual-use"
    if tags & {"defensive-security", "blue-team", "soc", "dfir", "detection-engineering",
               "threat-hunting", "incident-response", "intrusion-detection"}:
        return "Defensive"
    if tags & {"malware-analysis", "forensics", "yara", "sigma", "reverse-engineering"}:
        return "Research"
    return "Educational"


def risk_level(classification: str, repo: dict) -> str:
    tags = set(t.lower() for t in repo.get("tags", []))
    downloads = repo.get("downloads") or 0
    if classification == "Suspicious":
        return "Critical" if downloads > 1000 else "High"
    if classification == "Dual-use":
        return "High" if downloads > 500 else "Medium"
    return "Low"


def build_repo_entry(repo: dict, repo_type: str) -> dict:
    repo_id = repo.get("id") or repo.get("modelId") or repo.get("datasetId") or "unknown"
    author = repo.get("author") or repo_id.split("/")[0]
    tags = repo.get("tags", [])
    classification = classify(repo)
    risk = risk_level(classification, repo)
    url_prefix = {"model": "https://hf.co/", "dataset": "https://hf.co/datasets/", "space": "https://hf.co/spaces/"}
    return {
        "id": repo_id,
        "type": repo_type.title(),
        "url": url_prefix.get(repo_type, "https://hf.co/") + repo_id,
        "author": author,
        "created": repo.get("createdAt", ""),
        "modified": repo.get("lastModified", ""),
        "tags": tags,
        "downloads": repo.get("downloads") or 0,
        "likes": repo.get("likes") or 0,
        "classification": classification,
        "risk": risk,
        "gated": bool(repo.get("gated")),
        "task": repo.get("pipeline_tag") or "",
    }


# ── Scan ───────────────────────────────────────────────────────────────────────

def run_scan(since_hours: int = 1) -> dict:
    seen_ids: set[str] = set()
    all_findings: list[dict] = []

    for query, repo_types in SCAN_QUERIES:
        for rtype in repo_types:
            repos = search_repos(query, rtype, limit=30)
            for repo in repos:
                entry = build_repo_entry(repo, rtype)
                if entry["id"] in seen_ids:
                    continue
                seen_ids.add(entry["id"])
                if is_recent(repo, since_hours):
                    all_findings.append(entry)

    # Sort: Suspicious first, then Dual-use, then risk desc, then downloads desc
    priority = {"Suspicious": 0, "Dual-use": 1, "Research": 2, "Educational": 3, "Defensive": 4}
    risk_order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    all_findings.sort(key=lambda x: (
        priority.get(x["classification"], 5),
        risk_order.get(x["risk"], 4),
        -x["downloads"]
    ))

    high_signal = [f for f in all_findings if f["classification"] in ("Suspicious", "Dual-use")]
    watchlist = [f for f in all_findings if set(t.lower() for t in f["tags"]) & WATCHLIST_TAGS and f not in high_signal]
    noise = [f for f in all_findings if f not in high_signal and f not in watchlist]

    return {
        "scan_time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "since_hours": since_hours,
        "total_reviewed": len(seen_ids),
        "total_new": len(all_findings),
        "high_signal": high_signal,
        "watchlist": watchlist[:10],
        "noise": noise[:10],
    }


# ── Digest Generation ──────────────────────────────────────────────────────────

def scan_number_from_notion() -> int:
    """Query Notion to get the next scan number."""
    if not NOTION_TOKEN:
        return 1
    try:
        r = requests.post(
            f"{NOTION_API}/databases/{NOTION_DATABASE_ID}/query",
            headers={
                "Authorization": f"Bearer {NOTION_TOKEN}",
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
            },
            json={"page_size": 1, "sorts": [{"property": "Report ID", "direction": "descending"}]},
            timeout=10,
        )
        data = r.json()
        results = data.get("results", [])
        if results:
            props = results[0].get("properties", {})
            rid = props.get("Report ID", {}).get("unique_id", {}).get("number", 0)
            return (rid or 0) + 1
    except Exception as e:
        print(f"[WARN] Could not fetch scan number: {e}")
    return 1


def build_markdown_digest(results: dict, scan_num: int) -> str:
    date_str = results["scan_time"][:10]
    lines = [
        f"# HF Security Intelligence Digest — {date_str}",
        f"**Scan #{scan_num:03d}** | Scanned: {results['total_reviewed']} repos | "
        f"New/Updated: {results['total_new']} | High-Signal: {len(results['high_signal'])} | "
        f"Watchlist: {len(results['watchlist'])}",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
    ]

    if not results["high_signal"]:
        lines.append("No high-signal findings in this scan window. Landscape appears stable relative to previous scan.")
    else:
        class_counts = {}
        for f in results["high_signal"]:
            class_counts[f["classification"]] = class_counts.get(f["classification"], 0) + 1
        summary_parts = [f"{v} {k}" for k, v in class_counts.items()]
        lines.append(
            f"This scan window identified **{len(results['high_signal'])} high-signal repositories**: "
            + ", ".join(summary_parts) + ". "
            + f"Total repositories reviewed: {results['total_reviewed']}. "
            + f"Period: last {results['since_hours']}h."
        )

    lines += ["", "---", "", "## High-Signal Findings", ""]

    if not results["high_signal"]:
        lines.append("_No high-signal findings this scan._")
    else:
        for i, f in enumerate(results["high_signal"], 1):
            badge = {"Suspicious": "[SUSPICIOUS]", "Dual-use": "[DUAL-USE]"}.get(f["classification"], f"[{f['classification'].upper()}]")
            gated = " *(Gated)*" if f["gated"] else ""
            lines += [
                f"### {badge} {f['id']}{gated}",
                "",
                f"- **Type:** {f['type']} | **Author:** {f['author']} | **Risk:** {f['risk']}",
                f"- **URL:** {f['url']}",
                f"- **Created:** {f['created'][:10] if f['created'] else 'N/A'} | "
                f"**Modified:** {f['modified'][:10] if f['modified'] else 'N/A'}",
                f"- **Downloads:** {f['downloads']:,} | **Likes:** {f['likes']}",
                f"- **Tags:** {', '.join(f['tags'][:12]) if f['tags'] else 'none'}",
                "",
            ]
            suspicious_tags = set(t.lower() for t in f["tags"]) & WATCHLIST_TAGS
            if suspicious_tags:
                lines.append(f"**Why it matched:** Tags `{'`, `'.join(suspicious_tags)}`")
            lines.append("")

    lines += ["---", "", "## Watchlist Items", ""]
    if not results["watchlist"]:
        lines.append("_No new watchlist items this scan._")
    else:
        for f in results["watchlist"]:
            gated = " *(Gated)*" if f["gated"] else ""
            lines.append(
                f"- [{f['id']}]({f['url']}){gated} — {f['type']} by {f['author']} "
                f"({f['downloads']:,} dl) | Risk: {f['risk']}"
            )

    lines += ["", "---", "", "## Possible Noise / False Positives", ""]
    if not results["noise"]:
        lines.append("_No noise items recorded._")
    else:
        for f in results["noise"][:5]:
            lines.append(f"- {f['id']} ({f['type']}, {f['classification']}) — low signal")

    lines += [
        "",
        "---",
        "",
        "## Scan Metadata",
        "",
        f"- **Scan timestamp:** {results['scan_time']}",
        f"- **Repos reviewed:** {results['total_reviewed']}",
        f"- **New/updated repos:** {results['total_new']}",
        f"- **Cadence:** Hourly",
        f"- **Digest ID:** HF-SEC-{scan_num:03d}",
    ]

    return "\n".join(lines)


def build_html_digest(results: dict, scan_num: int) -> str:
    date_str = results["scan_time"][:10]
    risk_colors = {"Critical": "#c0392b", "High": "#e67e22", "Medium": "#f39c12", "Low": "#27ae60"}
    class_colors = {"Suspicious": "#c0392b", "Dual-use": "#e67e22", "Research": "#8e44ad",
                    "Defensive": "#27ae60", "Educational": "#2980b9"}

    rows = ""
    for f in results["high_signal"]:
        rc = risk_colors.get(f["risk"], "#666")
        cc = class_colors.get(f["classification"], "#666")
        gated = " 🔒" if f["gated"] else ""
        tag_str = ", ".join(f["tags"][:8])
        rows += f"""
        <tr>
          <td><a href="{f['url']}" style="color:#2980b9">{f['id']}</a>{gated}</td>
          <td>{f['type']}</td>
          <td>{f['author']}</td>
          <td><span style="color:{cc};font-weight:bold">{f['classification']}</span></td>
          <td><span style="color:{rc};font-weight:bold">{f['risk']}</span></td>
          <td>{f['downloads']:,}</td>
          <td style="font-size:11px;color:#666">{tag_str}</td>
        </tr>"""

    watchlist_rows = ""
    for f in results["watchlist"]:
        rc = risk_colors.get(f["risk"], "#666")
        gated = " 🔒" if f["gated"] else ""
        watchlist_rows += f"""
        <tr>
          <td><a href="{f['url']}" style="color:#2980b9">{f['id']}</a>{gated}</td>
          <td>{f['type']}</td>
          <td>{f['author']}</td>
          <td><span style="color:{rc};font-weight:bold">{f['risk']}</span></td>
          <td>{f['downloads']:,}</td>
        </tr>"""

    high_count = len(results["high_signal"])
    watch_count = len(results["watchlist"])
    overall_risk = "Critical" if any(f["risk"] == "Critical" for f in results["high_signal"]) else \
                   "High" if any(f["risk"] == "High" for f in results["high_signal"]) else \
                   "Medium" if watch_count > 0 else "Low"
    overall_color = risk_colors.get(overall_risk, "#666")

    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{{font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:900px;margin:0 auto;padding:20px}}
h1{{color:#c0392b;border-bottom:2px solid #c0392b;padding-bottom:8px}}
h2{{color:#2c3e50;border-left:4px solid #c0392b;padding-left:10px;margin-top:28px}}
table{{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}}
th{{background:#2c3e50;color:white;padding:8px 10px;text-align:left}}
td{{padding:7px 10px;border-bottom:1px solid #ddd;vertical-align:top}}
tr:hover{{background:#f5f5f5}}
.meta{{background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px;padding:12px;font-size:12px;color:#666}}
.summary-box{{background:#fff8f8;border:1px solid #e74c3c;border-radius:4px;padding:14px;margin:12px 0}}
</style></head>
<body>
<h1>🛡️ HF Security Intelligence Digest</h1>
<p class="meta">
  <strong>Report ID:</strong> HF-SEC-{scan_num:03d} &nbsp;|&nbsp;
  <strong>Date:</strong> {date_str} &nbsp;|&nbsp;
  <strong>Overall Risk:</strong> <span style="color:{overall_color};font-weight:bold">{overall_risk}</span> &nbsp;|&nbsp;
  <strong>High-Signal:</strong> {high_count} &nbsp;|&nbsp;
  <strong>Watchlist:</strong> {watch_count} &nbsp;|&nbsp;
  <strong>Repos Reviewed:</strong> {results['total_reviewed']}
</p>

<h2>Executive Summary</h2>
<div class="summary-box">
{"No high-signal findings in this scan window. Landscape stable relative to prior scan." if not results["high_signal"] else
f"<strong>{high_count} high-signal repositories</strong> identified in the last {results['since_hours']}h scan window. " +
("Abliterated/offensive-only models present — elevated risk." if any(f["classification"]=="Suspicious" for f in results["high_signal"]) else "Dual-use activity detected.")}
</div>

<h2>⚠️ High-Signal Findings</h2>
{"<p><em>No high-signal findings this scan.</em></p>" if not results["high_signal"] else f"""
<table>
  <tr><th>Repository</th><th>Type</th><th>Author</th><th>Class.</th><th>Risk</th><th>DLs</th><th>Tags</th></tr>
  {rows}
</table>"""}

<h2>🔍 Watchlist</h2>
{"<p><em>No new watchlist items.</em></p>" if not results["watchlist"] else f"""
<table>
  <tr><th>Repository</th><th>Type</th><th>Author</th><th>Risk</th><th>DLs</th></tr>
  {watchlist_rows}
</table>"""}

<h2>Scan Metadata</h2>
<p class="meta">
  Timestamp: {results['scan_time']} &nbsp;|&nbsp;
  Repos reviewed: {results['total_reviewed']} &nbsp;|&nbsp;
  New/updated: {results['total_new']} &nbsp;|&nbsp;
  Cadence: Hourly
</p>
</body></html>"""


# ── Notion Publisher ───────────────────────────────────────────────────────────

def publish_to_notion(markdown: str, results: dict, scan_num: int) -> Optional[str]:
    if not NOTION_TOKEN:
        print("[SKIP] NOTION_TOKEN not set.")
        return None

    date_str = results["scan_time"][:10]
    has_suspicious = any(f["classification"] == "Suspicious" for f in results["high_signal"])
    has_dual = any(f["classification"] == "Dual-use" for f in results["high_signal"])
    classifications = list({f["classification"] for f in results["high_signal"] + results["watchlist"]}) or ["Educational"]

    overall_risk = (
        "Critical" if any(f["risk"] == "Critical" for f in results["high_signal"]) else
        "High" if any(f["risk"] == "High" for f in results["high_signal"]) else
        "Medium" if results["watchlist"] else "Low"
    )

    topic_map = {
        "Malware": has_suspicious,
        "Red-Team": any("red-team" in f["tags"] for f in results["high_signal"]),
        "Threat-Intel": any("threat-intelligence" in f["tags"] for f in results["high_signal"] + results["watchlist"]),
        "CVE": any("cve" in f["tags"] for f in results["high_signal"] + results["watchlist"]),
        "Security-LLM": True,
    }
    topics = [k for k, v in topic_map.items() if v]

    payload = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "icon": {"type": "emoji", "emoji": "🛡️"},
        "properties": {
            "Report Title": {"title": [{"text": {"content": f"HF Security Intelligence Digest — {date_str} | Scan #{scan_num:03d}"}}]},
            "Scan Date": {"date": {"start": date_str}},
            "Classification": {"multi_select": [{"name": c} for c in classifications]},
            "Topics Covered": {"multi_select": [{"name": t} for t in topics]},
            "High-Signal Count": {"number": len(results["high_signal"])},
            "Watchlist Count": {"number": len(results["watchlist"])},
            "Risk Level": {"select": {"name": overall_risk}},
            "Status": {"select": {"name": "Published"}},
            "Emailed": {"checkbox": True},
        },
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": markdown[:1800]}}]
                },
            }
        ],
    }

    try:
        r = requests.post(
            f"{NOTION_API}/pages",
            headers={
                "Authorization": f"Bearer {NOTION_TOKEN}",
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        r.raise_for_status()
        page_url = r.json().get("url", "")
        print(f"[OK] Notion page created: {page_url}")
        return page_url
    except Exception as e:
        print(f"[ERROR] Notion publish failed: {e}")
        return None


# ── Gmail Draft ────────────────────────────────────────────────────────────────

def send_gmail_draft(html: str, scan_num: int, date_str: str) -> bool:
    if not GMAIL_TOKEN:
        print("[SKIP] GMAIL_TOKEN not set.")
        return False

    import base64
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    msg = MIMEMultipart("alternative")
    msg["To"] = RECIPIENT_EMAIL
    msg["Subject"] = f"[HF-SEC-{scan_num:03d}] Hugging Face Security Intelligence Digest — {date_str}"
    msg.attach(MIMEText(html, "html"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    try:
        r = requests.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
            headers={
                "Authorization": f"Bearer {GMAIL_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"message": {"raw": raw}},
            timeout=15,
        )
        r.raise_for_status()
        print(f"[OK] Gmail draft created: {r.json().get('id')}")
        return True
    except Exception as e:
        print(f"[ERROR] Gmail draft failed: {e}")
        return False


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    since_hours = int(os.environ.get("SCAN_WINDOW_HOURS", "1"))
    print(f"[START] HF Security Scan — window: {since_hours}h — {datetime.datetime.utcnow().isoformat()}Z")

    results = run_scan(since_hours)
    print(f"[SCAN] Reviewed: {results['total_reviewed']} | New: {results['total_new']} | "
          f"High-signal: {len(results['high_signal'])} | Watchlist: {len(results['watchlist'])}")

    scan_num = scan_number_from_notion()
    date_str = results["scan_time"][:10]

    markdown = build_markdown_digest(results, scan_num)
    html = build_html_digest(results, scan_num)

    # Always write a local JSON artifact for debugging
    with open("scan_results.json", "w") as fh:
        json.dump(results, fh, indent=2, default=str)
    print("[OK] scan_results.json written")

    # Only publish if there are findings worth reporting
    if results["high_signal"] or results["watchlist"]:
        publish_to_notion(markdown, results, scan_num)
        send_gmail_draft(html, scan_num, date_str)
    else:
        print("[INFO] No high-signal findings — skipping Notion/Gmail publish.")

    print(f"[DONE] Scan #{scan_num:03d} complete.")


if __name__ == "__main__":
    main()
