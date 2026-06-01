#!/usr/bin/env python3
"""
HF Security Intelligence Scanner
Hourly scan of Hugging Face for cybersecurity-related repositories.
Outputs a structured digest to Notion and emails a summary.
"""

import json
import os
import re
import smtplib
import sys
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any

import requests
from dateutil import parser as dateparser
from notion_client import Client as NotionClient

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HF_API = "https://huggingface.co/api"
HF_TOKEN = os.environ.get("HF_TOKEN", "")
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
NOTION_DATABASE_ID = os.environ.get("NOTION_DATABASE_ID", "")
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
RECIPIENT_EMAIL = os.environ.get("RECIPIENT_EMAIL", "")
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "2"))
STATE_FILE = Path(os.environ.get("STATE_FILE", "/tmp/hf_scan_state.json"))

SEARCH_QUERIES = [
    "malware",
    "ransomware",
    "cybersecurity",
    "exploit",
    "phishing",
    "osint",
    "pentest",
    "vulnerability",
    "botnet",
    "stealer",
    "infostealer",
    "yara",
    "sigma",
    "forensics",
    "red-team",
    "threat-intelligence",
    "CVE",
    "malware-analysis",
    "reverse-engineering",
    "detection-engineering",
]

REPO_TYPES = ["model", "dataset", "space"]

# Tags that signal elevated risk regardless of query
SUSPICIOUS_TAGS = {
    "uncensored", "jailbreak", "abliterate", "no-restrictions",
    "bypass", "stealer", "c2", "botnet", "infostealer", "backdoor",
    "rat", "rootkit", "cryptojacker", "keylogger",
}

DEFENSIVE_TAGS = {
    "defensive-security", "detection-engineering", "incident-response",
    "dfir", "soc", "blue-team", "threat-intelligence", "sigma", "yara",
    "malware-analysis", "forensics", "intrusion-detection", "ids",
}

DUAL_USE_TAGS = {
    "red-team", "pentest", "penetration-testing", "exploit", "cve",
    "vulnerability", "osint", "bug-bounty",
}


# ---------------------------------------------------------------------------
# State management (deduplication between runs)
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"seen_ids": [], "last_run": None}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, default=str))


# ---------------------------------------------------------------------------
# HF API helpers
# ---------------------------------------------------------------------------

def hf_headers() -> dict:
    h = {"Accept": "application/json"}
    if HF_TOKEN:
        h["Authorization"] = f"Bearer {HF_TOKEN}"
    return h


def search_hf(query: str, repo_type: str, limit: int = 50) -> list[dict]:
    """Call the HF search API and return raw repo objects."""
    params = {
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": limit,
        "full": "true",
    }
    try:
        resp = requests.get(
            f"{HF_API}/{repo_type}s",
            params=params,
            headers=hf_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"[WARN] search_hf({query}, {repo_type}): {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

def classify(repo: dict) -> str:
    tags = {t.lower() for t in (repo.get("tags") or [])}
    name_lower = (repo.get("id") or "").lower()

    if tags & SUSPICIOUS_TAGS:
        return "Suspicious"
    if "uncensored" in name_lower or "jailbreak" in name_lower:
        return "Suspicious"
    if tags & DEFENSIVE_TAGS:
        return "Defensive"
    if tags & DUAL_USE_TAGS:
        return "Dual-use"
    if "research" in name_lower or "paper" in name_lower:
        return "Research"
    return "Educational"


def risk_level(repo: dict, classification: str) -> str:
    if classification == "Suspicious":
        return "HIGH"
    downloads = repo.get("downloads") or 0
    if classification == "Dual-use" and downloads > 500:
        return "MEDIUM-HIGH"
    if classification == "Dual-use":
        return "MEDIUM"
    if downloads > 1000:
        return "MEDIUM"
    return "LOW"


# ---------------------------------------------------------------------------
# Filter to new/materially changed repos
# ---------------------------------------------------------------------------

def is_recent(repo: dict, cutoff: datetime) -> bool:
    for field in ("lastModified", "createdAt"):
        raw = repo.get(field)
        if raw:
            try:
                ts = dateparser.parse(raw)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                if ts >= cutoff:
                    return True
            except Exception:
                pass
    return False


def is_security_relevant(repo: dict) -> bool:
    tags = {t.lower() for t in (repo.get("tags") or [])}
    name = (repo.get("id") or "").lower()
    desc = (repo.get("cardData", {}) or {}).get("summary", "").lower()
    noise_keywords = {"tunnel", "ferroviaire", "nutrition", "tuberculosis", "poker", "robotics"}
    if any(k in name for k in noise_keywords):
        return False
    sec_keywords = {
        "malware", "ransomware", "exploit", "phishing", "osint", "pentest",
        "vulnerability", "cve", "cwe", "cybersecurity", "security", "red-team",
        "threat", "botnet", "stealer", "yara", "sigma", "forensic", "dfir",
        "reverse-engineer", "c2", "backdoor", "infostealer", "keylogger", "rat",
    }
    if tags & sec_keywords:
        return True
    if any(k in name for k in sec_keywords):
        return True
    return False


# ---------------------------------------------------------------------------
# Digest building
# ---------------------------------------------------------------------------

def build_digest(findings: list[dict], scan_ts: datetime) -> dict:
    suspicious = [f for f in findings if f["classification"] == "Suspicious"]
    dual_use = [f for f in findings if f["classification"] == "Dual-use"]
    defensive = [f for f in findings if f["classification"] == "Defensive"]
    research = [f for f in findings if f["classification"] == "Research"]
    educational = [f for f in findings if f["classification"] == "Educational"]

    high_signal = sorted(
        [f for f in findings if f["risk"] in ("HIGH", "MEDIUM-HIGH")],
        key=lambda x: x.get("downloads", 0),
        reverse=True,
    )

    return {
        "scan_timestamp": scan_ts.isoformat(),
        "total_findings": len(findings),
        "by_classification": {
            "Suspicious": len(suspicious),
            "Dual-use": len(dual_use),
            "Defensive": len(defensive),
            "Research": len(research),
            "Educational": len(educational),
        },
        "high_signal": high_signal[:20],
        "all_findings": findings,
    }


def format_digest_markdown(digest: dict) -> str:
    ts = digest["scan_timestamp"]
    total = digest["total_findings"]
    bc = digest["by_classification"]
    hs = digest["high_signal"]

    lines = [
        f"# HF Security Intelligence Digest",
        f"**Scan Time:** {ts}  |  **New/Changed Repos:** {total}",
        f"",
        f"## Summary",
        f"| Category | Count |",
        f"|----------|-------|",
        f"| Suspicious | {bc['Suspicious']} |",
        f"| Dual-use | {bc['Dual-use']} |",
        f"| Defensive | {bc['Defensive']} |",
        f"| Research | {bc['Research']} |",
        f"| Educational | {bc['Educational']} |",
        f"",
        f"## High-Signal Findings",
    ]

    for f in hs:
        lines += [
            f"",
            f"### [{f['id']}]({f['url']})",
            f"- **Type:** {f['type']} | **Risk:** {f['risk']} | **Class:** {f['classification']}",
            f"- **Author:** {f['author']} | **Downloads:** {f.get('downloads', 0)} | **Likes:** {f.get('likes', 0)}",
            f"- **Created:** {f.get('created', 'N/A')} | **Updated:** {f.get('updated', 'N/A')}",
            f"- **Tags:** {', '.join(f.get('tags', [])[:10])}",
            f"- **Why flagged:** {f.get('why_flagged', f['classification'])}",
        ]

    lines += [
        "",
        "---",
        "*Generated by HF Security Intelligence Pipeline*",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Notion output
# ---------------------------------------------------------------------------

def push_to_notion(digest: dict, markdown_body: str) -> str | None:
    if not NOTION_TOKEN:
        print("[INFO] NOTION_TOKEN not set, skipping Notion push.")
        return None

    notion = NotionClient(auth=NOTION_TOKEN)
    ts = digest["scan_timestamp"][:10]
    title = f"HF Security Intel Digest — {ts} (Hourly)"

    try:
        if NOTION_DATABASE_ID:
            resp = notion.pages.create(
                parent={"database_id": NOTION_DATABASE_ID},
                properties={"title": [{"text": {"content": title}}]},
                children=[{
                    "object": "block",
                    "type": "paragraph",
                    "paragraph": {
                        "rich_text": [{"type": "text", "text": {"content": markdown_body[:2000]}}]
                    },
                }],
            )
        else:
            resp = notion.pages.create(
                properties={"title": [{"text": {"content": title}}]},
                children=[{
                    "object": "block",
                    "type": "paragraph",
                    "paragraph": {
                        "rich_text": [{"type": "text", "text": {"content": markdown_body[:2000]}}]
                    },
                }],
            )
        page_url = resp.get("url", "")
        print(f"[OK] Notion page created: {page_url}")
        return page_url
    except Exception as e:
        print(f"[ERROR] Notion push failed: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Email output
# ---------------------------------------------------------------------------

def send_email(digest: dict, notion_url: str | None) -> None:
    if not (SMTP_USER and SMTP_PASS and RECIPIENT_EMAIL):
        print("[INFO] SMTP credentials not set, skipping email.")
        return

    bc = digest["by_classification"]
    hs = digest["high_signal"]
    ts = digest["scan_timestamp"]
    total = digest["total_findings"]

    subject = (
        f"[HF Intel] Security Scan {ts[:16]} — "
        f"{total} findings | {bc['Suspicious']} suspicious"
    )

    html_rows = "".join(
        f"<tr>"
        f"<td><a href='{f['url']}'>{f['id']}</a></td>"
        f"<td>{f['type']}</td>"
        f"<td style='color:{'red' if f['risk']=='HIGH' else 'orange' if 'MEDIUM' in f['risk'] else 'green'}'>"
        f"{f['risk']}</td>"
        f"<td>{f['classification']}</td>"
        f"<td>{f.get('downloads', 0)}</td>"
        f"</tr>"
        for f in hs[:15]
    )

    notion_link = f'<p><a href="{notion_url}">View full digest in Notion</a></p>' if notion_url else ""

    html = f"""
    <html><body>
    <h2>HF Security Intelligence Digest</h2>
    <p><strong>Scan Time:</strong> {ts} &nbsp;|&nbsp; <strong>New/Changed Repos:</strong> {total}</p>

    <h3>Classification Summary</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <tr><th>Category</th><th>Count</th></tr>
      <tr><td>🔴 Suspicious</td><td>{bc['Suspicious']}</td></tr>
      <tr><td>🟠 Dual-use</td><td>{bc['Dual-use']}</td></tr>
      <tr><td>🟢 Defensive</td><td>{bc['Defensive']}</td></tr>
      <tr><td>🔵 Research</td><td>{bc['Research']}</td></tr>
      <tr><td>⚪ Educational</td><td>{bc['Educational']}</td></tr>
    </table>

    <h3>High-Signal Findings</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <tr><th>Repository</th><th>Type</th><th>Risk</th><th>Classification</th><th>Downloads</th></tr>
      {html_rows}
    </table>

    {notion_link}

    <hr>
    <p><small>Generated by HF Security Intelligence Pipeline — canstralian/splat</small></p>
    </body></html>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = SMTP_USER
    msg["To"] = RECIPIENT_EMAIL
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.ehlo()
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, RECIPIENT_EMAIL, msg.as_string())
        print(f"[OK] Email sent to {RECIPIENT_EMAIL}")
    except Exception as e:
        print(f"[ERROR] Email send failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Main scan loop
# ---------------------------------------------------------------------------

def main() -> None:
    scan_ts = datetime.now(timezone.utc)
    cutoff = scan_ts - timedelta(hours=LOOKBACK_HOURS)
    state = load_state()
    seen_ids: set[str] = set(state.get("seen_ids", []))

    print(f"[INFO] Scan start: {scan_ts.isoformat()} | Lookback: {LOOKBACK_HOURS}h | Cutoff: {cutoff.isoformat()}")

    all_repos: dict[str, dict] = {}

    for query in SEARCH_QUERIES:
        for repo_type in REPO_TYPES:
            repos = search_hf(query, repo_type, limit=50)
            for repo in repos:
                rid = repo.get("id") or repo.get("modelId") or repo.get("name", "")
                if rid:
                    all_repos[f"{repo_type}/{rid}"] = {**repo, "_type": repo_type}

    print(f"[INFO] Raw repos fetched: {len(all_repos)}")

    findings: list[dict] = []
    new_seen: list[str] = []

    for key, repo in all_repos.items():
        if not is_recent(repo, cutoff):
            continue
        if not is_security_relevant(repo):
            continue
        if key in seen_ids:
            continue

        repo_id = repo.get("id") or repo.get("modelId") or repo.get("name", "")
        repo_type = repo["_type"]
        author = repo_id.split("/")[0] if "/" in repo_id else "unknown"
        tags = list({t.lower() for t in (repo.get("tags") or [])})
        cls = classify(repo)
        risk = risk_level(repo, cls)

        # Build a basic "why flagged" message
        suspicious_t = [t for t in tags if t in SUSPICIOUS_TAGS]
        if suspicious_t:
            why = f"Suspicious tags: {', '.join(suspicious_t)}"
        elif cls == "Defensive":
            why = f"Defensive security tooling"
        elif cls == "Dual-use":
            why = f"Dual-use security content"
        else:
            why = f"Matched search queries; {cls.lower()} classification"

        base_url = {
            "model": f"https://hf.co/{repo_id}",
            "dataset": f"https://hf.co/datasets/{repo_id}",
            "space": f"https://hf.co/spaces/{repo_id}",
        }[repo_type]

        findings.append({
            "id": repo_id,
            "type": repo_type.capitalize(),
            "url": base_url,
            "author": author,
            "created": repo.get("createdAt", "")[:10],
            "updated": repo.get("lastModified", "")[:10],
            "tags": tags[:15],
            "classification": cls,
            "risk": risk,
            "downloads": repo.get("downloads", 0),
            "likes": repo.get("likes", 0),
            "why_flagged": why,
        })
        new_seen.append(key)

    print(f"[INFO] Filtered findings: {len(findings)}")

    digest = build_digest(findings, scan_ts)
    markdown = format_digest_markdown(digest)

    # Save digest to file
    digest_path = Path(f"/tmp/hf_digest_{scan_ts.strftime('%Y%m%d_%H%M%S')}.md")
    digest_path.write_text(markdown)
    print(f"[INFO] Digest written to {digest_path}")

    notion_url = push_to_notion(digest, markdown)
    send_email(digest, notion_url)

    # Update state (keep last 10K seen IDs to avoid unbounded growth)
    all_seen = list(seen_ids | set(new_seen))
    state["seen_ids"] = all_seen[-10000:]
    state["last_run"] = scan_ts.isoformat()
    save_state(state)

    print(f"[INFO] Scan complete. {len(findings)} new findings. State saved.")


if __name__ == "__main__":
    main()
