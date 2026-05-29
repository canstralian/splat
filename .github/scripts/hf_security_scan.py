#!/usr/bin/env python3
"""
HF Security Intelligence Scanner
Runs hourly via GitHub Actions. Scans Hugging Face for security-related
repositories and saves a digest to Notion + emails a summary.

Required secrets:
  HF_TOKEN            - Hugging Face access token
  NOTION_TOKEN        - Notion integration token
  NOTION_PARENT_PAGE_ID - Notion page ID to create reports under
  ANTHROPIC_API_KEY   - Claude API key (for digest synthesis)
  SENDGRID_API_KEY    - SendGrid key for email delivery
  GMAIL_RECIPIENT     - Recipient email address
"""

import os
import json
import re
import sys
import time
import datetime
import requests
from huggingface_hub import HfApi

# ── Config ────────────────────────────────────────────────────────────────────

HF_TOKEN          = os.environ.get("HF_TOKEN")
NOTION_TOKEN      = os.environ.get("NOTION_TOKEN")
NOTION_PARENT_ID  = os.environ.get("NOTION_PARENT_PAGE_ID")
ANTHROPIC_KEY     = os.environ.get("ANTHROPIC_API_KEY")
SENDGRID_KEY      = os.environ.get("SENDGRID_API_KEY")
RECIPIENT_EMAIL   = os.environ.get("GMAIL_RECIPIENT", "dejager.sa@gmail.com")
SENDER_EMAIL      = os.environ.get("SENDER_EMAIL", "noreply-hf-intel@yourdomain.com")

SCAN_QUERIES = [
    "malware", "cybersecurity", "phishing", "exploit",
    "vulnerability", "ransomware", "pentest", "OSINT",
    "threat-intelligence", "red-team", "reverse-engineering",
]

REPO_TYPES = ["model", "dataset", "space"]

# Risk classification keywords
SUSPICIOUS_KEYWORDS = [
    "c2", "command-and-control", "zero-click", "zero_click",
    "malware source", "exploit deployment", "stealer", "infostealer",
    "botnet", "ransomware-as-a-service", "uncensored pentest",
    "abliterat", "jailbreak steering",
]

DUAL_USE_KEYWORDS = [
    "red-team", "redteam", "exploit", "pentest", "offensive",
    "uncensored", "payload", "c2-framework",
]

DEFENSIVE_KEYWORDS = [
    "detection", "defender", "blue-team", "soc", "dfir", "forensic",
    "incident-response", "yara", "sigma", "threat-intelligence",
    "vulnerability-scoring", "ids", "edr",
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def today() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

def classify(repo) -> str:
    combined = " ".join([
        (repo.id or ""),
        " ".join(repo.tags or []),
        (getattr(repo, "description", "") or ""),
    ]).lower()
    if any(k in combined for k in SUSPICIOUS_KEYWORDS):
        return "Suspicious"
    if any(k in combined for k in DUAL_USE_KEYWORDS):
        return "Dual-use"
    if any(k in combined for k in DEFENSIVE_KEYWORDS):
        return "Defensive"
    return "Research"

# ── HF Search ────────────────────────────────────────────────────────────────

def search_hf(since_hours: int = 2) -> list[dict]:
    api = HfApi(token=HF_TOKEN)
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=since_hours)
    found = {}

    for query in SCAN_QUERIES:
        for repo_type in REPO_TYPES:
            try:
                if repo_type == "model":
                    results = api.list_models(search=query, sort="lastModified",
                                              direction=-1, limit=30, token=HF_TOKEN)
                elif repo_type == "dataset":
                    results = api.list_datasets(search=query, sort="lastModified",
                                                direction=-1, limit=30, token=HF_TOKEN)
                else:
                    results = api.list_spaces(search=query, sort="lastModified",
                                              direction=-1, limit=30, token=HF_TOKEN)

                for repo in results:
                    last_mod = getattr(repo, "last_modified", None) or getattr(repo, "lastModified", None)
                    if last_mod is None:
                        continue
                    if isinstance(last_mod, str):
                        last_mod = datetime.datetime.fromisoformat(last_mod.replace("Z", "+00:00"))
                    if last_mod.tzinfo is None:
                        last_mod = last_mod.replace(tzinfo=datetime.timezone.utc)
                    if last_mod < cutoff:
                        continue
                    key = f"{repo_type}/{repo.id}"
                    if key not in found:
                        found[key] = {
                            "id": repo.id,
                            "type": repo_type,
                            "url": f"https://hf.co/{'datasets/' if repo_type == 'dataset' else 'spaces/' if repo_type == 'space' else ''}{repo.id}",
                            "tags": list(repo.tags or []),
                            "downloads": getattr(repo, "downloads", 0) or 0,
                            "likes": getattr(repo, "likes", 0) or 0,
                            "last_modified": str(last_mod),
                            "classification": classify(repo),
                            "matched_query": query,
                        }
            except Exception as e:
                print(f"Warning: search failed for {query}/{repo_type}: {e}", file=sys.stderr)
            time.sleep(0.3)  # rate limit

    return list(found.values())

# ── Claude synthesis ──────────────────────────────────────────────────────────

def synthesize_digest(repos: list[dict], run_number: int) -> str:
    if not ANTHROPIC_KEY:
        return _fallback_digest(repos, run_number)

    payload = {
        "model": "claude-3-5-sonnet-latest",
        "max_tokens": 4096,
        "messages": [{
            "role": "user",
            "content": (
                f"You are a security intelligence analyst. Today is {today()}. "
                f"This is hourly HF security scan run #{run_number}.\n\n"
                "Below is a JSON list of NEW or RECENTLY UPDATED Hugging Face repositories "
                "matching security-related queries in the past 2 hours.\n\n"
                f"```json\n{json.dumps(repos, indent=2)}\n```\n\n"
                "Write a concise intelligence digest in Markdown with these sections:\n"
                "1. **Executive Summary** (3 sentences max)\n"
                "2. **High-Signal Findings** (only items classified Suspicious or high-risk Dual-use)\n"
                "3. **Emerging Patterns** (brief bullet list)\n"
                "4. **Watchlist Items** (table: repo | type | classification | reason)\n"
                "5. **Noise / False Positives** (brief)\n"
                "6. **Recommended Actions** (numbered)\n\n"
                "Do NOT provide exploit steps, malware deployment details, "
                "persistence techniques, credential theft instructions, or payload details. "
                "Analyst-style, low-noise, high-signal output only."
            )
        }]
    }
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=payload,
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["content"][0]["text"]

def _fallback_digest(repos: list[dict], run_number: int) -> str:
    suspicious = [r for r in repos if r["classification"] == "Suspicious"]
    dual_use   = [r for r in repos if r["classification"] == "Dual-use"]
    other      = [r for r in repos if r["classification"] not in ("Suspicious", "Dual-use")]
    lines = [
        f"# HF Security Intelligence Digest — {today()} (Run #{run_number})",
        "",
        "## Executive Summary",
        f"Scan found {len(repos)} new/updated repositories in the past 2 hours. "
        f"{len(suspicious)} flagged as Suspicious, {len(dual_use)} as Dual-use.",
        "",
        "## High-Signal Findings",
    ]
    for r in suspicious + dual_use:
        lines.append(f"- **{r['id']}** [{r['type']}] — {r['classification']} — tags: {', '.join(r['tags'][:5])}")
    lines += ["", "## Other Findings"]
    for r in other:
        lines.append(f"- {r['id']} [{r['type']}]")
    return "\n".join(lines)

# ── Notion save ───────────────────────────────────────────────────────────────

def get_run_number() -> int:
    if not NOTION_TOKEN:
        return 1
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    payload = {
        "query": "HF Security Intelligence Digest",
        "filter": {"value": "page", "property": "object"},
        "page_size": 1,
    }
    resp = requests.post("https://api.notion.com/v1/search", headers=headers, json=payload, timeout=15)
    if resp.ok:
        results = resp.json().get("results", [])
        titles = []
        for r in results:
            title_prop = r.get("properties", {}).get("title")
            if isinstance(title_prop, dict):
                title_parts = title_prop.get("title", [])
                for t in title_parts:
                    titles.append(t.get("plain_text", ""))
        run_numbers = []
        for t in titles:
            m = re.search(r"Run #(\d+)", t)
            if m:
                run_numbers.append(int(m.group(1)))
        return max(run_numbers, default=0) + 1
    return 1

def save_to_notion(digest_md: str, run_number: int, repo_count: int) -> str | None:
    if not NOTION_TOKEN or not NOTION_PARENT_ID:
        print("No NOTION_TOKEN or NOTION_PARENT_PAGE_ID — skipping Notion save", file=sys.stderr)
        return None

    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    title = f"HF Security Intelligence Digest — {today()} (Run #{run_number})"

    # Split digest into 2000-char chunks for Notion paragraph blocks
    chunks = [digest_md[i:i+1990] for i in range(0, len(digest_md), 1990)]
    children = [
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": chunk}}]
            }
        }
        for chunk in chunks
    ]

    parent = {"type": "page_id", "page_id": NOTION_PARENT_ID}
    body = {
        "parent": parent,
        "properties": {
            "title": {"title": [{"type": "text", "text": {"content": title}}]}
        },
        "children": children,
    }

    resp = requests.post("https://api.notion.com/v1/pages", headers=headers, json=body, timeout=30)
    if resp.ok:
        page_url = resp.json().get("url")
        print(f"Notion page created: {page_url}")
        return page_url
    else:
        print(f"Notion error {resp.status_code}: {resp.text}", file=sys.stderr)
        return None

# ── Email delivery ────────────────────────────────────────────────────────────

def send_email(subject: str, html_body: str) -> None:
    if not SENDGRID_KEY or not RECIPIENT_EMAIL:
        print("No SENDGRID_API_KEY or GMAIL_RECIPIENT — skipping email", file=sys.stderr)
        return
    payload = {
        "personalizations": [{"to": [{"email": RECIPIENT_EMAIL}]}],
        "from": {"email": SENDER_EMAIL, "name": "HF Security Intel"},
        "subject": subject,
        "content": [{"type": "text/html", "value": html_body}],
    }
    try:
        resp = requests.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={"Authorization": f"Bearer {SENDGRID_KEY}", "Content-Type": "application/json"},
            json=payload,
            timeout=15,
        )
        if resp.status_code in (200, 202):
            print(f"Email sent to {RECIPIENT_EMAIL}")
        else:
            print(f"SendGrid error {resp.status_code}: {resp.text}", file=sys.stderr)
    except Exception as e:
        print(f"Failed to send email via SendGrid: {e}", file=sys.stderr)

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"[{utcnow()}] Starting HF security scan...")

    run_number = get_run_number()
    repos = search_hf(since_hours=2)
    print(f"Found {len(repos)} new/updated repositories")

    if not repos:
        print("No new repositories found — skipping digest.")
        return

    digest_md = synthesize_digest(repos, run_number)

    notion_url = save_to_notion(digest_md, run_number, len(repos))

    suspicious_count = sum(1 for r in repos if r["classification"] == "Suspicious")
    dual_use_count   = sum(1 for r in repos if r["classification"] == "Dual-use")

    subject = (
        f"🛡️ HF Security Intelligence Digest — {today()} | Run #{run_number} | "
        f"{suspicious_count} Critical, {dual_use_count} Dual-use"
    )

    notion_link = f'<p>Full report: <a href="{notion_url}">{notion_url}</a></p>' if notion_url else ""
    html_body = f"""
    <html><body style="font-family: Arial, sans-serif; max-width: 800px;">
    <div style="background:#1a1a2e;color:white;padding:15px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;">🛡️ HF Security Intelligence Digest</h2>
      <p style="margin:4px 0;opacity:.8;font-size:13px;">{today()} | Run #{run_number} |
         {len(repos)} repos scanned | {suspicious_count} critical | {dual_use_count} dual-use</p>
    </div>
    <div style="padding:15px;border:1px solid #ddd;border-top:none;">
      {notion_link}
      <pre style="white-space:pre-wrap;font-size:13px;background:#f8f8f8;padding:15px;border-radius:4px;">{digest_md[:8000]}</pre>
      <p style="font-size:11px;color:#999;">Automated scan — for defensive security monitoring only.</p>
    </div>
    </body></html>
    """
    send_email(subject, html_body)

    print(f"[{utcnow()}] Scan complete. Run #{run_number}, {len(repos)} repos.")

if __name__ == "__main__":
    main()
