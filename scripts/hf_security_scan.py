#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Runs hourly via GitHub Actions. Scans HF Hub for newly created/updated
security-related repositories across Models, Datasets, and Spaces.

Required environment variables:
  HF_TOKEN         - Hugging Face API token (optional, raises rate limits)
  NOTION_TOKEN     - Notion integration token
  NOTION_DB_ID     - Notion database ID (4cacd7eb-7717-459c-8ebd-c884123e982b)
  GMAIL_TO         - Recipient email address
  GMAIL_USER       - Gmail sender address
  GMAIL_APP_PASS   - Gmail app password (or OAuth token)
  SCAN_STATE_FILE  - Path to JSON file persisting last-scan timestamps (default: .scan_state.json)
"""

import os
import json
import time
import smtplib
import requests
import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────────────

HF_API   = "https://huggingface.co/api"
HF_TOKEN = os.getenv("HF_TOKEN", "")

NOTION_TOKEN = os.getenv("NOTION_TOKEN", "")
NOTION_DB_ID = os.getenv("NOTION_DB_ID", "4cacd7eb-7717-459c-8ebd-c884123e982b")

GMAIL_TO       = os.getenv("GMAIL_TO", "dejager.sa@gmail.com")
GMAIL_USER     = os.getenv("GMAIL_USER", "")
GMAIL_APP_PASS = os.getenv("GMAIL_APP_PASS", "")

STATE_FILE = Path(os.getenv("SCAN_STATE_FILE", ".scan_state.json"))

SECURITY_QUERIES = [
    "cybersecurity", "malware", "ransomware", "phishing", "pentest",
    "vulnerability", "stealer", "infostealer", "botnet", "sigma", "yara",
    "exploit", "c2", "forensic", "osint",
]

REPO_TYPES = ["model", "dataset", "space"]

# False-positive filters — repo names/descriptions containing these are excluded
FALSE_POSITIVE_PATTERNS = [
    "robotics", "pick_and_place", "tuberculosis", "nutrition-climate",
    "flood-vulnerability", "cartilage", "oil-vulnerability", "lung-cancer",
    "Kashmir", "healthcare-ransomware",  # only when not cyber-healthcare
]

# Tags that elevate risk rating
HIGH_RISK_TAGS = {
    "malware", "ransomware", "exploit", "c2", "stealer", "infostealer",
    "botnet", "uncensored", "jailbreak", "abliterator", "bypass",
    "offensive", "red-team", "scada", "ics", "ot-security",
}
DUAL_USE_TAGS = {
    "pentest", "penetration-testing", "red-team", "kali", "ctf",
    "vulnerability-research", "adversarial",
}
DEFENSIVE_TAGS = {
    "malware-detection", "intrusion-detection", "dfir", "soc",
    "threat-intelligence", "incident-response", "defensive-security",
    "sigma", "yara", "mitre-attack",
}


# ── State persistence ─────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_scan": None, "seen_ids": [], "digest_count": 0}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── HF Hub search ─────────────────────────────────────────────────────────────

def hf_search(query: str, repo_type: str, since: str | None) -> list[dict]:
    """Search HF Hub for repos matching query, optionally filtered by lastModified."""
    params = {
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": 30,
        "full": "true",
    }
    headers = {}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"

    endpoint_map = {
        "model": f"{HF_API}/models",
        "dataset": f"{HF_API}/datasets",
        "space": f"{HF_API}/spaces",
    }
    url = endpoint_map[repo_type]

    try:
        r = requests.get(url, params=params, headers=headers, timeout=30)
        r.raise_for_status()
        repos = r.json()
    except Exception as e:
        print(f"  [WARN] HF search failed ({repo_type}/{query}): {e}")
        return []

    # Filter to only new/changed since last scan
    if since:
        since_dt = datetime.datetime.fromisoformat(since.replace("Z", "+00:00"))
        repos = [
            r for r in repos
            if datetime.datetime.fromisoformat(
                (r.get("lastModified") or r.get("createdAt", "2000-01-01T00:00:00"))
                .replace("Z", "+00:00")
            ) > since_dt
        ]
    return repos


def is_false_positive(repo: dict) -> bool:
    text = (repo.get("id", "") + " " + " ".join(repo.get("tags", []))).lower()
    return any(p in text for p in FALSE_POSITIVE_PATTERNS)


def classify(repo: dict) -> tuple[str, str]:
    """Returns (classification, risk_level)."""
    tags = set(t.lower() for t in repo.get("tags", []))
    name = repo.get("id", "").lower()

    h = tags & HIGH_RISK_TAGS
    d = tags & DUAL_USE_TAGS
    f = tags & DEFENSIVE_TAGS

    # Explicit safety-bypass indicators
    if any(x in name for x in ["uncensored", "jailbreak", "abliter", "bypass"]):
        return "Suspicious", "Critical"
    if h and not f:
        if "scada" in tags or "ics" in name or "ot-security" in tags:
            return "Dual-use", "High"
        return "Dual-use", "High"
    if d and not f:
        return "Dual-use", "Medium"
    if f:
        return "Defensive", "Low"
    return "Educational", "Low"


# ── Digest builder ────────────────────────────────────────────────────────────

def build_digest(findings: list[dict], digest_num: int, scan_time: str) -> dict:
    """Produces a structured digest dict from raw findings."""
    high_signal = [f for f in findings if f["risk"] in ("Critical", "High")]
    watchlist   = [f for f in findings if f["risk"] in ("Critical", "High", "Medium")]
    defensive   = [f for f in findings if f["classification"] == "Defensive"]
    suspicious  = [f for f in findings if f["classification"] == "Suspicious"]

    # Dominant risk level for the whole digest
    if any(f["risk"] == "Critical" for f in high_signal):
        overall_risk = "Critical"
    elif any(f["risk"] == "High" for f in high_signal):
        overall_risk = "High"
    elif watchlist:
        overall_risk = "Medium"
    else:
        overall_risk = "Low"

    # Dominant classification
    classifications = [f["classification"] for f in findings]
    dominant = max(set(classifications), key=classifications.count) if classifications else "Educational"

    return {
        "digest_num": digest_num,
        "scan_time": scan_time,
        "total": len(findings),
        "high_signal_count": len(high_signal),
        "overall_risk": overall_risk,
        "dominant_classification": dominant,
        "high_signal": high_signal,
        "watchlist": watchlist,
        "defensive": defensive,
        "suspicious": suspicious,
        "all_findings": findings,
    }


def format_notion_content(digest: dict) -> str:
    lines = [
        f"# HF Security Intelligence Digest #{digest['digest_num']:03d}",
        f"**Scan Time:** {digest['scan_time']}  |  **Total Findings:** {digest['total']}  |  **High-Signal:** {digest['high_signal_count']}",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
    ]

    if not digest["all_findings"]:
        lines.append("No new or materially changed security repositories detected since the previous scan.")
    else:
        lines.append(
            f"Scan identified **{digest['total']} new/updated** security repositories. "
            f"**{digest['high_signal_count']}** warrant elevated attention. "
            f"Dominant category: **{digest['dominant_classification']}**. "
            f"Overall risk: **{digest['overall_risk']}**."
        )

    lines += ["", "---", "", "## High-Signal Findings", ""]

    for f in digest["high_signal"][:15]:
        risk_icon = {"Critical": "🔴", "High": "🟠", "Medium": "🟡", "Low": "🟢"}.get(f["risk"], "⚪")
        lines += [
            f"### {risk_icon} {f['id']} [{f['type'].title()}]",
            f"- **URL:** {f['url']}",
            f"- **Author:** {f['author']} | **Modified:** {f['modified']} | **Downloads:** {f.get('downloads', 0)}",
            f"- **Tags:** {', '.join(f['tags'][:10])}",
            f"- **Classification:** {f['classification']} | **Risk:** {f['risk']}",
            f"- **Why matched:** {f['query']}",
            "",
        ]

    if digest["watchlist"]:
        lines += ["## Watchlist", ""]
        for f in digest["watchlist"]:
            lines.append(f"- `{f['id']}` — {f['classification']} / {f['risk']} — {f['url']}")
        lines.append("")

    if digest["defensive"]:
        lines += ["## Notable Defensive / Research", ""]
        for f in digest["defensive"][:5]:
            lines.append(f"- `{f['id']}` ({f['modified']}) — {', '.join(f['tags'][:5])}")
        lines.append("")

    return "\n".join(lines)


# ── Notion integration ────────────────────────────────────────────────────────

def save_to_notion(digest: dict):
    if not NOTION_TOKEN:
        print("[SKIP] NOTION_TOKEN not set — skipping Notion save.")
        return None

    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }

    title = (
        f"HF SecIntel Digest #{digest['digest_num']:03d} — "
        f"{digest['scan_time'][:10]}"
    )
    tags_str = "malware, ransomware, pentest, cybersecurity, phishing, vulnerability"

    page_data = {
        "parent": {"database_id": NOTION_DB_ID},
        "icon": {"type": "emoji", "emoji": "🛡️"},
        "properties": {
            "Report Title": {"title": [{"text": {"content": title}}]},
            "Scan Date": {"date": {"start": digest["scan_time"][:10]}},
            "Classification": {"select": {"name": digest["dominant_classification"]}},
            "High Signal Count": {"number": digest["high_signal_count"]},
            "Total Findings": {"number": digest["total"]},
            "Risk Level": {"select": {"name": digest["overall_risk"]}},
            "Tags": {"rich_text": [{"text": {"content": tags_str}}]},
            "Status": {"select": {"name": "New"}},
        },
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": format_notion_content(digest)[:2000]}}]
                },
            }
        ],
    }

    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=headers,
        json=page_data,
        timeout=30,
    )
    if r.ok:
        print(f"[OK] Notion page created: {r.json().get('url', '')}")
        return r.json().get("url")
    else:
        print(f"[WARN] Notion save failed: {r.status_code} {r.text[:200]}")
        return None


# ── Email integration ─────────────────────────────────────────────────────────

def send_email(digest: dict, notion_url: str | None):
    if not GMAIL_USER or not GMAIL_APP_PASS:
        print("[SKIP] Gmail credentials not set — skipping email.")
        return

    subject = (
        f"[HF SecIntel] Digest #{digest['digest_num']:03d} — "
        f"{digest['scan_time'][:10]} | "
        f"{digest['high_signal_count']} High-Signal Findings | "
        f"Risk: {digest['overall_risk'].upper()}"
    )

    risk_color = {"Critical": "#dc2626", "High": "#ea580c", "Medium": "#ca8a04", "Low": "#16a34a"}.get(
        digest["overall_risk"], "#666"
    )

    rows = ""
    for f in digest["high_signal"][:10]:
        risk_icon = {"Critical": "🔴", "High": "🟠", "Medium": "🟡"}.get(f["risk"], "⚪")
        rows += (
            f"<tr><td style='padding:8px;border:1px solid #ddd'>{risk_icon} "
            f"<a href='{f['url']}'>{f['id']}</a></td>"
            f"<td style='padding:8px;border:1px solid #ddd'>{f['type'].title()}</td>"
            f"<td style='padding:8px;border:1px solid #ddd'>{f['risk']}</td>"
            f"<td style='padding:8px;border:1px solid #ddd'>{f['classification']}</td>"
            f"<td style='padding:8px;border:1px solid #ddd'>{f.get('downloads', 0)}</td></tr>\n"
        )

    notion_link = f"<p><a href='{notion_url}'>→ View full report in Notion</a></p>" if notion_url else ""

    html = f"""<html><body style='font-family:Arial,sans-serif;max-width:800px;margin:0 auto'>
<div style='background:#1a1a2e;color:white;padding:20px;border-radius:8px 8px 0 0'>
  <h1 style='margin:0;font-size:20px'>🛡️ HF Security Intelligence Digest #{digest['digest_num']:03d}</h1>
  <p style='margin:5px 0 0;color:#aaa;font-size:13px'>
    {digest['scan_time'][:19]} UTC | Total: {digest['total']} | High-Signal: {digest['high_signal_count']}
  </p>
</div>
<div style='border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px'>
  <p><strong>Overall Risk:</strong>
    <span style='color:{risk_color};font-weight:bold'>{digest['overall_risk'].upper()}</span>
  </p>
  {notion_link}
  <h2 style='border-bottom:2px solid {risk_color};padding-bottom:5px;color:{risk_color}'>High-Signal Findings</h2>
  {'<p style="color:#666">No new high-signal repositories detected this cycle.</p>' if not digest['high_signal'] else f'''
  <table style='width:100%;border-collapse:collapse;font-size:13px'>
    <tr style='background:#f5f5f5'>
      <th style='padding:8px;border:1px solid #ddd;text-align:left'>Repository</th>
      <th style='padding:8px;border:1px solid #ddd'>Type</th>
      <th style='padding:8px;border:1px solid #ddd'>Risk</th>
      <th style='padding:8px;border:1px solid #ddd'>Class</th>
      <th style='padding:8px;border:1px solid #ddd'>DLs</th>
    </tr>
    {rows}
  </table>'''}
  <hr style='margin:20px 0;border:1px solid #eee'>
  <p style='color:#999;font-size:12px;text-align:center'>
    HF Security Intelligence | Automated Digest | Scan #{digest['digest_num']:03d}<br>
    Generated by hf_security_scan.py via GitHub Actions
  </p>
</div></body></html>"""

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = GMAIL_USER
    msg["To"]      = GMAIL_TO
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(GMAIL_USER, GMAIL_APP_PASS)
            server.sendmail(GMAIL_USER, GMAIL_TO, msg.as_string())
        print(f"[OK] Email sent to {GMAIL_TO}")
    except Exception as e:
        print(f"[WARN] Email failed: {e}")


# ── Main scan loop ────────────────────────────────────────────────────────────

def main():
    print(f"[{datetime.datetime.utcnow().isoformat()}] HF Security Scanner starting...")

    state = load_state()
    last_scan = state.get("last_scan")
    digest_num = state.get("digest_count", 0) + 1
    scan_time = datetime.datetime.utcnow().isoformat() + "Z"

    print(f"  Last scan: {last_scan or 'NONE (baseline)'}  |  Digest: #{digest_num:03d}")

    # Collect all findings
    findings_by_id: dict[str, dict] = {}
    seen_ids: set = set(state.get("seen_ids", []))

    for query in SECURITY_QUERIES:
        for repo_type in REPO_TYPES:
            print(f"  Searching {repo_type}/{query}...")
            repos = hf_search(query, repo_type, last_scan)
            time.sleep(0.2)  # gentle rate limiting

            for repo in repos:
                repo_id = repo.get("id", "")
                if not repo_id or repo_id in findings_by_id:
                    continue
                if is_false_positive(repo):
                    continue

                classification, risk = classify(repo)
                findings_by_id[repo_id] = {
                    "id":             repo_id,
                    "type":           repo_type,
                    "url":            f"https://hf.co{'/' if repo_type == 'model' else '/datasets/' if repo_type == 'dataset' else '/spaces/'}{repo_id}",
                    "author":         repo.get("author", repo_id.split("/")[0]),
                    "modified":       (repo.get("lastModified") or repo.get("createdAt", ""))[:10],
                    "downloads":      repo.get("downloads", 0),
                    "likes":          repo.get("likes", 0),
                    "tags":           repo.get("tags", []),
                    "classification": classification,
                    "risk":           risk,
                    "query":          query,
                    "is_new":         repo_id not in seen_ids,
                }

    findings = list(findings_by_id.values())

    # Sort: critical first, then by downloads desc
    risk_order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    findings.sort(key=lambda f: (risk_order.get(f["risk"], 9), -f.get("downloads", 0)))

    print(f"  Found {len(findings)} relevant repositories.")

    digest = build_digest(findings, digest_num, scan_time)

    # Save to Notion
    notion_url = save_to_notion(digest)

    # Send email
    send_email(digest, notion_url)

    # Update state
    state["last_scan"] = scan_time
    state["digest_count"] = digest_num
    state["seen_ids"] = list(set(seen_ids) | set(findings_by_id.keys()))
    # Cap seen_ids to last 5000 to prevent unbounded growth
    if len(state["seen_ids"]) > 5000:
        state["seen_ids"] = state["seen_ids"][-5000:]
    save_state(state)

    print(f"[{datetime.datetime.utcnow().isoformat()}] Scan complete. Digest #{digest_num:03d} | {len(findings)} findings | Risk: {digest['overall_risk']}")


if __name__ == "__main__":
    main()
