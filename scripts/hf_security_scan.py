#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Runs hourly, saves digest to Notion, sends summary via Gmail draft.

Required environment variables:
  HF_TOKEN          - Hugging Face API token (for higher rate limits)
  NOTION_TOKEN      - Notion integration token
  NOTION_PARENT_PAGE_ID - Notion page ID where digests are created
  GMAIL_CREDS_JSON  - Base64-encoded Gmail service-account credentials JSON
  ALERT_EMAIL       - Recipient email for digest drafts
"""

import os
import json
import base64
import datetime
import re
import sys
from dataclasses import dataclass, field
from typing import Optional

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HF_TOKEN = os.environ.get("HF_TOKEN", "")
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
NOTION_PARENT_PAGE_ID = os.environ.get("NOTION_PARENT_PAGE_ID", "")
GMAIL_CREDS_JSON = os.environ.get("GMAIL_CREDS_JSON", "")
ALERT_EMAIL = os.environ.get("ALERT_EMAIL", "dejager.sa@gmail.com")

HF_API = "https://huggingface.co/api"
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"

SEARCH_TERMS = [
    "cybersecurity", "malware", "phishing", "ransomware",
    "exploit", "osint", "vulnerability", "pentest",
    "yara", "sigma", "infostealer", "botnet", "c2",
    "threat-intelligence", "dfir", "red-team",
]

REPO_TYPES = ["model", "dataset", "space"]

# Suspicious name/tag patterns (case-insensitive)
SUSPICIOUS_PATTERNS = [
    r"c2[\-_]", r"command[\-_]control", r"zero[\-_]click",
    r"ransomware[\-_]simul", r"uncensored.*pentest", r"pentest.*uncensored",
    r"malware[\-_]source", r"exploit[\-_]deploy", r"payload[\-_]gen",
    r"stager", r"shellcode", r"dropper", r"loader.*malware",
    r"stealer[\-_]source", r"rat[\-_]builder", r"botnet[\-_]panel",
]

# Dual-use indicators
DUAL_USE_TAGS = {
    "exploit", "red-team", "redteam", "c2", "pentest",
    "offensive", "zero-day", "zeroday", "infostealer",
    "credential-theft", "payload", "shellcode",
}


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class RepoRecord:
    id: str
    repo_type: str
    url: str
    author: str
    created_at: str
    last_modified: str
    tags: list[str]
    downloads: int
    likes: int
    summary: str = ""
    classification: str = "Unknown"
    risk_level: str = "Low"
    match_reason: str = ""
    query: str = ""


# ---------------------------------------------------------------------------
# HF Hub search
# ---------------------------------------------------------------------------

def hf_headers() -> dict:
    h = {"Accept": "application/json"}
    if HF_TOKEN:
        h["Authorization"] = f"Bearer {HF_TOKEN}"
    return h


def search_hf(query: str, repo_type: str, limit: int = 20) -> list[dict]:
    endpoint = {
        "model": f"{HF_API}/models",
        "dataset": f"{HF_API}/datasets",
        "space": f"{HF_API}/spaces",
    }[repo_type]

    params = {
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": limit,
        "full": "true",
    }
    try:
        r = requests.get(endpoint, params=params, headers=hf_headers(), timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[WARN] HF search failed ({repo_type}, {query}): {e}", file=sys.stderr)
        return []


def repo_id(item: dict, repo_type: str) -> str:
    return item.get("id") or item.get("modelId") or item.get("repoId") or item.get("_id", "")


def repo_url(item: dict, repo_type: str) -> str:
    rid = repo_id(item, repo_type)
    prefix = {"model": "", "dataset": "datasets/", "space": "spaces/"}[repo_type]
    return f"https://huggingface.co/{prefix}{rid}"


def extract_tags(item: dict) -> list[str]:
    tags = item.get("tags", []) or []
    pipeline = item.get("pipeline_tag") or ""
    if pipeline and pipeline not in tags:
        tags = [pipeline] + list(tags)
    return [str(t).lower() for t in tags]


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

def classify(name: str, tags: list[str], summary: str) -> tuple[str, str, str]:
    """Returns (classification, risk_level, reason)"""
    name_lower = name.lower()
    combined = name_lower + " " + " ".join(tags) + " " + summary.lower()

    # Suspicious
    for pat in SUSPICIOUS_PATTERNS:
        if re.search(pat, combined, re.IGNORECASE):
            return "Suspicious", "High", f"Matched suspicious pattern: `{pat}`"

    # Dual-use
    for tag in DUAL_USE_TAGS:
        if tag in tags or tag in name_lower:
            return "Dual-use", "Medium", f"Dual-use tag/name: `{tag}`"

    # Defensive signals
    defensive_keywords = [
        "detection", "classifier", "defensive", "monitor", "soc",
        "dfir", "incident-response", "threat-intel", "alert", "scanner",
        "antivirus", "ids", "ips", "nist", "owasp",
    ]
    for kw in defensive_keywords:
        if kw in combined:
            return "Defensive", "Low", f"Defensive keyword: `{kw}`"

    # Research/educational
    research_keywords = ["benchmark", "dataset", "evaluation", "research", "paper", "survey"]
    for kw in research_keywords:
        if kw in combined:
            return "Research", "Low", f"Research keyword: `{kw}`"

    return "Educational", "Informational", "General security/educational content"


# ---------------------------------------------------------------------------
# Delta detection (compare with last Notion digest)
# ---------------------------------------------------------------------------

def fetch_last_digest_ids() -> set[str]:
    """Retrieve repo IDs mentioned in the most recent Notion digest page."""
    if not NOTION_TOKEN or not NOTION_PARENT_PAGE_ID:
        return set()
    try:
        headers = {
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
        }
        # Search for most recent HF Security Intelligence Digest page
        r = requests.post(
            f"{NOTION_API}/search",
            headers=headers,
            json={
                "query": "HF Security Intelligence Digest",
                "sort": {"direction": "descending", "timestamp": "last_edited_time"},
                "page_size": 1,
            },
            timeout=20,
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return set()
        page_id = results[0]["id"]
        # Retrieve page blocks to extract repo IDs from URLs
        br = requests.get(
            f"{NOTION_API}/blocks/{page_id}/children?page_size=100",
            headers=headers,
            timeout=20,
        )
        br.raise_for_status()
        blocks = br.json().get("results", [])
        ids: set[str] = set()
        for block in blocks:
            text = json.dumps(block)
            # Extract HF repo IDs from URLs in the page
            for m in re.finditer(r"huggingface\.co/(?:datasets/|spaces/)?([^/\s\"]+/[^/\s\"]+)", text):
                ids.add(m.group(1).strip("/"))
        return ids
    except Exception as e:
        print(f"[WARN] Could not fetch previous digest: {e}", file=sys.stderr)
        return set()


# ---------------------------------------------------------------------------
# Full scan
# ---------------------------------------------------------------------------

def run_scan(lookback_hours: int = 2) -> list[RepoRecord]:
    seen: set[str] = set()
    records: list[RepoRecord] = []
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=lookback_hours)
    cutoff_iso = cutoff.isoformat()

    prev_ids = fetch_last_digest_ids()

    for query in SEARCH_TERMS:
        for repo_type in REPO_TYPES:
            items = search_hf(query, repo_type, limit=20)
            for item in items:
                rid = repo_id(item, repo_type)
                if not rid or rid in seen:
                    continue
                seen.add(rid)

                last_mod = item.get("lastModified") or item.get("updatedAt") or ""
                created = item.get("createdAt") or ""

                # Only include repos modified since the cutoff OR not seen in last digest
                if last_mod and last_mod < cutoff_iso and rid in prev_ids:
                    continue

                tags = extract_tags(item)
                name = rid.split("/")[-1] if "/" in rid else rid
                summary = item.get("cardData", {}).get("summary", "") if isinstance(item.get("cardData"), dict) else ""

                classification, risk, reason = classify(rid, tags, summary)

                records.append(RepoRecord(
                    id=rid,
                    repo_type=repo_type,
                    url=repo_url(item, repo_type),
                    author=item.get("author") or rid.split("/")[0],
                    created_at=created,
                    last_modified=last_mod,
                    tags=tags[:10],
                    downloads=item.get("downloads", 0) or 0,
                    likes=item.get("likes", 0) or 0,
                    summary=summary[:200],
                    classification=classification,
                    risk_level=risk,
                    match_reason=reason,
                    query=query,
                ))

    # Sort: Suspicious first, then by last_modified desc
    priority = {"Suspicious": 0, "Dual-use": 1, "Research": 2, "Defensive": 3, "Educational": 4, "Unknown": 5}
    records.sort(key=lambda r: (priority.get(r.classification, 5), -(r.downloads + r.likes * 10)))
    return records


# ---------------------------------------------------------------------------
# Digest builder
# ---------------------------------------------------------------------------

def build_digest(records: list[RepoRecord], scan_number: int) -> dict:
    now = datetime.datetime.utcnow()
    date_str = now.strftime("%Y-%m-%d %H:%M")

    buckets: dict[str, list[RepoRecord]] = {
        "Suspicious": [], "Dual-use": [], "Research": [],
        "Defensive": [], "Educational": [],
    }
    for r in records:
        buckets.setdefault(r.classification, []).append(r)

    suspicious = buckets["Suspicious"]
    dual_use = buckets["Dual-use"]
    research = buckets["Research"]
    defensive = buckets["Defensive"]

    subject = (
        f"[HF SecIntel] Digest #{scan_number:03d} — {now.strftime('%Y-%m-%d')} | "
        f"{len(suspicious)} Suspicious · {len(dual_use)} Dual-Use · "
        f"{len(research) + len(defensive)} Notable"
    )

    def row(r: RepoRecord) -> str:
        tags_str = ", ".join(r.tags[:5]) if r.tags else "—"
        return (
            f"| [{r.id}]({r.url}) | {r.repo_type.capitalize()} | "
            f"{r.author} | {r.last_modified[:10]} | {r.risk_level} | "
            f"{r.match_reason} |"
        )

    md_lines = [
        f"# HF Security Intelligence Digest",
        f"**Date:** {date_str} UTC | **Scan #{scan_number:03d}** | "
        f"**Repos reviewed:** {len(records)} new/updated",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
        f"Scan #{scan_number:03d} identified **{len(records)} new or materially updated** "
        f"security-related repositories since the previous scan. "
        f"**{len(suspicious)} suspicious**, **{len(dual_use)} dual-use**, "
        f"**{len(research)} research**, **{len(defensive)} defensive**.",
        "",
    ]

    for section, label, emoji in [
        ("Suspicious", "Suspicious — Investigate", "🔴"),
        ("Dual-use", "Dual-Use — Monitor", "🟠"),
        ("Research", "Research — Notable", "🟡"),
        ("Defensive", "Defensive — High Value", "🟢"),
    ]:
        items = buckets.get(section, [])
        if not items:
            continue
        md_lines += [
            f"## {emoji} {label}",
            "",
            "| Repository | Type | Author | Updated | Risk | Match Reason |",
            "|---|---|---|---|---|---|",
        ]
        for r in items[:15]:
            md_lines.append(row(r))
        md_lines.append("")

    md_lines += [
        "## Scan Metadata",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Scan date | {date_str} UTC |",
        f"| Queries | {', '.join(SEARCH_TERMS[:8])}... |",
        f"| Total new/updated | {len(records)} |",
        f"| Suspicious | {len(suspicious)} |",
        f"| Dual-use | {len(dual_use)} |",
        f"| Research | {len(research)} |",
        f"| Defensive | {len(defensive)} |",
        "",
        "*Automated HF Security Intelligence Workflow — do not act on suspicious findings without human analyst review.*",
    ]

    return {
        "title": f"HF Security Intelligence Digest — {date_str}",
        "subject": subject,
        "markdown": "\n".join(md_lines),
        "suspicious": suspicious,
        "dual_use": dual_use,
        "records": records,
        "date_str": date_str,
        "scan_number": scan_number,
    }


# ---------------------------------------------------------------------------
# Notion output
# ---------------------------------------------------------------------------

def save_to_notion(digest: dict) -> Optional[str]:
    if not NOTION_TOKEN or not NOTION_PARENT_PAGE_ID:
        print("[WARN] NOTION_TOKEN or NOTION_PARENT_PAGE_ID not set — skipping Notion save.", file=sys.stderr)
        return None

    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }

    # Break markdown into Notion paragraph blocks (simplified)
    paragraphs = []
    for line in digest["markdown"].split("\n"):
        paragraphs.append({
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": line[:2000]}}]
            },
        })

    payload = {
        "parent": {"page_id": NOTION_PARENT_PAGE_ID},
        "properties": {
            "title": {
                "title": [{"type": "text", "text": {"content": digest["title"]}}]
            }
        },
        "children": paragraphs[:100],
    }

    try:
        r = requests.post(f"{NOTION_API}/pages", headers=headers, json=payload, timeout=30)
        r.raise_for_status()
        page_url = r.json().get("url", "")
        print(f"[OK] Notion page created: {page_url}")
        return page_url
    except Exception as e:
        print(f"[ERROR] Notion save failed: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Gmail draft via Gmail API
# ---------------------------------------------------------------------------

def send_gmail_draft(digest: dict) -> bool:
    if not GMAIL_CREDS_JSON:
        print("[WARN] GMAIL_CREDS_JSON not set — skipping Gmail draft.", file=sys.stderr)
        return False

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        import email.mime.multipart
        import email.mime.text

        creds_data = json.loads(base64.b64decode(GMAIL_CREDS_JSON))
        creds = service_account.Credentials.from_service_account_info(
            creds_data,
            scopes=["https://www.googleapis.com/auth/gmail.compose"],
        ).with_subject(ALERT_EMAIL)

        service = build("gmail", "v1", credentials=creds)

        suspicious_html = "".join(
            f"<li><a href='{r.url}'>{r.id}</a> — {r.match_reason}</li>"
            for r in digest["suspicious"][:10]
        )
        dual_use_html = "".join(
            f"<li><a href='{r.url}'>{r.id}</a> — {r.match_reason}</li>"
            for r in digest["dual_use"][:10]
        )

        html_body = f"""
<h2>HF Security Intelligence Digest #{digest['scan_number']:03d}</h2>
<p><strong>Date:</strong> {digest['date_str']} UTC &nbsp;|&nbsp;
<strong>New/Updated repos:</strong> {len(digest['records'])}</p>
<hr>
<h3>🔴 Suspicious ({len(digest['suspicious'])})</h3>
<ul>{suspicious_html or '<li>None this cycle</li>'}</ul>
<h3>🟠 Dual-Use ({len(digest['dual_use'])})</h3>
<ul>{dual_use_html or '<li>None this cycle</li>'}</ul>
<hr>
<p><em>Full structured digest saved to Notion.
Automated scan — human analyst review required for actionable findings.</em></p>
"""

        msg = email.mime.multipart.MIMEMultipart("alternative")
        msg["Subject"] = digest["subject"]
        msg["To"] = ALERT_EMAIL
        msg.attach(email.mime.text.MIMEText(html_body, "html"))

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        service.users().drafts().create(
            userId="me", body={"message": {"raw": raw}}
        ).execute()
        print(f"[OK] Gmail draft created for {ALERT_EMAIL}")
        return True

    except ImportError:
        print("[WARN] google-auth not installed — skipping Gmail draft.", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[ERROR] Gmail draft failed: {e}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Scan number tracking (simple file-based counter)
# ---------------------------------------------------------------------------

COUNTER_FILE = "/tmp/hf_scan_counter.txt"


def get_scan_number() -> int:
    try:
        with open(COUNTER_FILE) as f:
            return int(f.read().strip()) + 1
    except Exception:
        return 1


def save_scan_number(n: int) -> None:
    try:
        with open(COUNTER_FILE, "w") as f:
            f.write(str(n))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="HF Security Intelligence Scanner")
    parser.add_argument("--lookback-hours", type=int, default=2,
                        help="Hours to look back for new/updated repos (default: 2)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print digest without saving to Notion or Gmail")
    args = parser.parse_args()

    print(f"[{datetime.datetime.utcnow().isoformat()}] Starting HF security scan "
          f"(lookback={args.lookback_hours}h)...")

    scan_number = get_scan_number()
    records = run_scan(lookback_hours=args.lookback_hours)

    print(f"[INFO] Found {len(records)} new/updated security repos.")

    if not records:
        print("[INFO] No new repositories — skipping digest creation.")
        save_scan_number(scan_number)
        return

    digest = build_digest(records, scan_number)

    if args.dry_run:
        print("\n" + "=" * 60)
        print(digest["markdown"])
        print("=" * 60)
    else:
        notion_url = save_to_notion(digest)
        send_gmail_draft(digest)

    save_scan_number(scan_number)
    print(f"[{datetime.datetime.utcnow().isoformat()}] Scan #{scan_number:03d} complete.")


if __name__ == "__main__":
    main()
