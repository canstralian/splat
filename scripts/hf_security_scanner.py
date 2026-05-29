#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Scans HF Hub for security-relevant repositories and generates structured intelligence digests.
"""

import json
import os
import re
import smtplib
import sys
import time
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HF_API_BASE = "https://huggingface.co/api"
STATE_FILE = Path(__file__).parent / "scanner_state.json"

SECURITY_QUERIES = [
    "cybersecurity",
    "malware",
    "ransomware",
    "exploit",
    "phishing",
    "osint",
    "penetration testing",
    "red team",
    "vulnerability",
    "reverse engineering",
    "threat intelligence",
    "yara",
    "sigma",
    "forensic",
    "stealer",
    "botnet",
    "CVE",
    "malware analysis",
    "detection engineering",
]

SECURITY_TAGS = [
    "cybersecurity", "malware", "ransomware", "exploit", "phishing",
    "osint", "red-team", "pentest", "yara", "sigma", "reverse-engineering",
    "vulnerability", "c2", "stealer", "botnet", "infostealer", "cve",
    "malware-analysis", "forensic", "detection-engineering", "threat-intelligence",
    "offensive-security", "defensive-security", "infosec", "dfir", "soc",
    "penetration-testing", "blue-team", "network-security", "intrusion-detection",
]

# Classification rules: (tag/keyword patterns -> category)
CLASSIFICATION_MAP = {
    "Suspicious": [
        r"\bheretic\b", r"\buncensored\b", r"\bdecensored\b", r"\babliterat",
        r"\bstealer\b", r"\binfostealer\b", r"\bbotnet\b", r"\bc2\b",
        r"\bransomware source\b", r"\bmalware source\b", r"\bpayload\b",
        r"\bexfiltrat", r"\bbypass\b", r"\bevasion\b",
    ],
    "Dual-use": [
        r"\bpenetration.testing\b", r"\boffensive.security\b", r"\bred.team",
        r"\bexploit\b", r"\bcve\b", r"\bvulnerabilit", r"\breverse.engineer",
        r"\bhacking\b", r"\bpentest\b",
    ],
    "Research": [
        r"\bmalware.analysis\b", r"\bmalware.detection\b", r"\bforensic",
        r"\bdfir\b", r"\bbenchmark\b", r"\bdataset\b.*malware",
        r"\bsamples?\b", r"\banalysis\b",
    ],
    "Defensive": [
        r"\bdetection\b", r"\bblue.team\b", r"\bsoc\b", r"\bsiem\b",
        r"\byara\b", r"\bsigma\b", r"\bdefensive\b", r"\bids\b",
        r"\bintrusion.detection\b", r"\bthreat.intelligence\b", r"\bdfir\b",
    ],
    "Educational": [
        r"\beducational\b", r"\blearning\b", r"\bcourse\b", r"\btutorial\b",
        r"\btraining\b", r"\bqa.bot\b", r"\bchatbot\b", r"\bllm\b",
    ],
}

RISK_SCORES = {
    "Suspicious": "HIGH",
    "Dual-use": "MEDIUM-HIGH",
    "Research": "MEDIUM",
    "Defensive": "LOW",
    "Educational": "LOW",
}


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"last_run": None, "seen_ids": []}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Hugging Face API
# ---------------------------------------------------------------------------

def _hf_headers() -> dict:
    token = os.environ.get("HF_TOKEN")
    return {"Authorization": f"Bearer {token}"} if token else {}


def search_hf(query: str, repo_type: str, limit: int = 50, sort: str = "lastModified") -> list[dict]:
    """Search HF Hub for repositories of a given type."""
    endpoint_map = {
        "model": f"{HF_API_BASE}/models",
        "dataset": f"{HF_API_BASE}/datasets",
        "space": f"{HF_API_BASE}/spaces",
    }
    url = endpoint_map[repo_type]
    params = {
        "search": query,
        "sort": sort,
        "direction": -1,
        "limit": limit,
        "full": True,
    }
    try:
        resp = requests.get(url, params=params, headers=_hf_headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"[WARN] HF API error for {repo_type}/{query}: {e}", file=sys.stderr)
        return []


def collect_security_repos(since: Optional[datetime], limit_per_query: int = 30) -> list[dict]:
    """Collect all security-relevant repos across queries and types, deduplicating by ID."""
    seen = set()
    results = []

    for query in SECURITY_QUERIES:
        for repo_type in ("model", "dataset", "space"):
            raw = search_hf(query, repo_type, limit=limit_per_query)
            for item in raw:
                repo_id = item.get("id") or item.get("modelId") or item.get("_id", "")
                if repo_id in seen:
                    continue

                # Filter by modification time if we have a baseline
                if since:
                    last_mod_str = item.get("lastModified") or item.get("updatedAt", "")
                    if last_mod_str:
                        try:
                            last_mod = datetime.fromisoformat(last_mod_str.replace("Z", "+00:00"))
                            if last_mod < since:
                                continue
                        except Exception:
                            pass

                seen.add(repo_id)
                item["_repo_type"] = repo_type
                results.append(item)

            time.sleep(0.3)  # polite rate limiting

    return results


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _text_for_classification(item: dict) -> str:
    parts = [
        item.get("id", ""),
        " ".join(item.get("tags", [])),
        item.get("description", "") or "",
        item.get("cardData", {}).get("description", "") if isinstance(item.get("cardData"), dict) else "",
    ]
    return " ".join(parts).lower()


def classify(item: dict) -> str:
    text = _text_for_classification(item)
    for category, patterns in CLASSIFICATION_MAP.items():
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return category
    return "Research"  # default


def risk_level(category: str) -> str:
    return RISK_SCORES.get(category, "MEDIUM")


# ---------------------------------------------------------------------------
# Digest generation
# ---------------------------------------------------------------------------

def build_finding(item: dict) -> dict:
    repo_type = item.get("_repo_type", "model")
    repo_id = item.get("id") or item.get("modelId") or ""
    author = repo_id.split("/")[0] if "/" in repo_id else item.get("author", "unknown")
    name = repo_id.split("/")[1] if "/" in repo_id else repo_id

    tags = item.get("tags", [])
    created = item.get("createdAt") or item.get("created_at", "")
    updated = item.get("lastModified") or item.get("updatedAt", "")
    downloads = item.get("downloads", 0) or 0
    likes = item.get("likes", 0) or 0

    # Matched query terms
    matched_tags = [t for t in tags if t.lower() in SECURITY_TAGS]

    category = classify(item)

    url_base = {"model": "https://hf.co", "dataset": "https://hf.co/datasets", "space": "https://hf.co/spaces"}
    url = f"{url_base.get(repo_type, 'https://hf.co')}/{repo_id}"

    # Brief description from tags
    summary = f"{repo_type.capitalize()} by {author}. Tags: {', '.join(tags[:8]) or 'none'}."
    if downloads > 0:
        summary += f" Downloads: {downloads:,}."

    return {
        "name": name,
        "full_id": repo_id,
        "type": repo_type.capitalize(),
        "url": url,
        "author": author,
        "created": created[:10] if created else "unknown",
        "updated": updated[:10] if updated else "unknown",
        "tags": tags[:15],
        "matched_tags": matched_tags,
        "summary": summary,
        "category": category,
        "risk": risk_level(category),
        "downloads": downloads,
        "likes": likes,
    }


def generate_digest(findings: list[dict], scan_time: datetime, scan_window_hours: int) -> str:
    if not findings:
        return f"# HF Security Intelligence Digest — {scan_time.strftime('%Y-%m-%d %H:%M UTC')}\n\nNo new security-relevant repositories detected in this scan window.\n"

    by_category: dict[str, list] = {}
    for f in findings:
        by_category.setdefault(f["category"], []).append(f)

    high_signal = [f for f in findings if f["risk"] in ("HIGH", "MEDIUM-HIGH")]
    suspicious = by_category.get("Suspicious", [])
    dual_use = by_category.get("Dual-use", [])
    defensive = by_category.get("Defensive", [])
    research = by_category.get("Research", [])
    educational = by_category.get("Educational", [])

    total = len(findings)
    window_label = f"last {scan_window_hours}h" if scan_window_hours < 24 else "last 24h"

    lines = [
        f"# HF Security Intelligence Digest",
        f"**Scan Time:** {scan_time.strftime('%Y-%m-%d %H:%M UTC')}",
        f"**Window:** {window_label}",
        f"**Total New/Updated:** {total} repositories",
        f"**High-Signal Findings:** {len(high_signal)}",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
        f"This scan identified **{total}** security-relevant repositories on Hugging Face Hub "
        f"created or modified in the {window_label}. "
        f"**{len(suspicious)}** classified as Suspicious, "
        f"**{len(dual_use)}** Dual-use, "
        f"**{len(defensive)}** Defensive, "
        f"**{len(research)}** Research, "
        f"**{len(educational)}** Educational.",
        "",
    ]

    if suspicious:
        lines += [
            "### Key Concerns",
            "",
        ]
        for f in suspicious[:5]:
            lines.append(f"- **{f['full_id']}** — {f['summary']} [Risk: {f['risk']}]")
        lines.append("")

    lines += [
        "---",
        "",
        "## High-Signal Findings",
        "",
    ]

    if not high_signal:
        lines.append("_No high-signal findings in this window._\n")
    else:
        for f in high_signal[:20]:
            lines += [
                f"### [{f['full_id']}]({f['url']})",
                f"- **Type:** {f['type']}  |  **Author:** {f['author']}",
                f"- **Created:** {f['created']}  |  **Updated:** {f['updated']}",
                f"- **Tags:** `{'`, `'.join(f['tags'][:8])}`",
                f"- **Matched On:** `{'`, `'.join(f['matched_tags']) or 'name/description'}`",
                f"- **Summary:** {f['summary']}",
                f"- **Category:** {f['category']}  |  **Risk:** `{f['risk']}`",
                f"- **Engagement:** {f['downloads']:,} downloads, {f['likes']} likes",
                "",
            ]

    lines += [
        "---",
        "",
        "## Emerging Patterns",
        "",
        _emerging_patterns(findings),
        "",
        "---",
        "",
        "## Watchlist Items",
        "",
    ]

    watchlist = [f for f in findings if f["downloads"] > 500 or f["likes"] > 3]
    if watchlist:
        for f in watchlist[:10]:
            lines.append(f"- **{f['full_id']}** ({f['type']}) — {f['downloads']:,} dl / {f['likes']} likes — [{f['url']}]({f['url']})")
    else:
        lines.append("_No trending items exceeded thresholds this window._")

    lines += [
        "",
        "---",
        "",
        "## Possible False Positives / Noise",
        "",
        "The following may be noise based on minimal metadata or low engagement:",
        "",
    ]

    noise = [f for f in educational + research if f["downloads"] < 5 and f["likes"] == 0]
    for f in noise[:8]:
        lines.append(f"- {f['full_id']} — 0 downloads, no metadata description")

    lines += [
        "",
        "---",
        "",
        "## Recommended Follow-Up Actions",
        "",
        "1. **Investigate Suspicious repos** for actual payload/tooling content via manual review.",
        "2. **Track Dual-use LLMs** tagged with `offensive-security`, `red-team`, `abliteration` — monitor for community uptake.",
        "3. **Review high-download malware datasets** for potential abuse in downstream fine-tuning pipelines.",
        "4. **Flag `heretic`/`uncensored` security models** to internal red team for alignment testing.",
        "5. **Monitor newly created accounts** with multiple security repos — potential coordinated upload pattern.",
        "",
        "---",
        f"_Generated by HF Security Scanner · {scan_time.strftime('%Y-%m-%d %H:%M UTC')}_",
    ]

    return "\n".join(lines)


def _emerging_patterns(findings: list[dict]) -> str:
    tag_counts: dict[str, int] = {}
    for f in findings:
        for t in f["matched_tags"]:
            tag_counts[t] = tag_counts.get(t, 0) + 1

    top_tags = sorted(tag_counts.items(), key=lambda x: -x[1])[:8]

    # Check for security LLM trend
    sec_llms = [f for f in findings if f["type"] == "Model" and any(
        t in f["tags"] for t in ["cybersecurity", "offensive-security", "red-team", "pentest"]
    )]
    malware_datasets = [f for f in findings if f["type"] == "Dataset" and "malware" in " ".join(f["tags"]).lower()]

    parts = []
    if sec_llms:
        parts.append(f"- **Security-focused LLMs** ({len(sec_llms)} new): Continued growth of fine-tuned models explicitly targeting offensive/defensive security use cases.")
    if malware_datasets:
        parts.append(f"- **Malware datasets** ({len(malware_datasets)} new): Active upload of malware samples, CAPE traces, and PE-file datasets for training detection models.")
    if top_tags:
        tag_str = ", ".join(f"`{t}` ({c})" for t, c in top_tags)
        parts.append(f"- **Top matched tags this window:** {tag_str}")

    return "\n".join(parts) if parts else "_No distinct emerging patterns detected._"


# ---------------------------------------------------------------------------
# Notion
# ---------------------------------------------------------------------------

def post_to_notion(digest_md: str, scan_time: datetime, total_findings: int):
    token = os.environ.get("NOTION_TOKEN")
    page_id = os.environ.get("NOTION_PAGE_ID")
    if not token or not page_id:
        print("[INFO] NOTION_TOKEN or NOTION_PAGE_ID not set — skipping Notion upload.", file=sys.stderr)
        return

    title = f"HF Security Digest — {scan_time.strftime('%Y-%m-%d %H:%M UTC')} ({total_findings} findings)"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }

    # Build block content from markdown (simplified chunking)
    blocks = _md_to_notion_blocks(digest_md)

    payload = {
        "parent": {"page_id": page_id},
        "properties": {
            "title": {"title": [{"text": {"content": title}}]}
        },
        "children": blocks[:100],  # Notion API limit per request
    }

    try:
        resp = requests.post("https://api.notion.com/v1/pages", json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        page_url = resp.json().get("url", "")
        print(f"[INFO] Notion page created: {page_url}")
    except Exception as e:
        print(f"[WARN] Notion upload failed: {e}", file=sys.stderr)


def _md_to_notion_blocks(md: str) -> list[dict]:
    blocks = []
    for line in md.split("\n"):
        if line.startswith("## "):
            blocks.append({"object": "block", "type": "heading_2", "heading_2": {"rich_text": [{"text": {"content": line[3:]}}]}})
        elif line.startswith("### "):
            blocks.append({"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"text": {"content": line[4:]}}]}})
        elif line.startswith("# "):
            blocks.append({"object": "block", "type": "heading_1", "heading_1": {"rich_text": [{"text": {"content": line[2:]}}]}})
        elif line.startswith("- "):
            blocks.append({"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"text": {"content": line[2:200]}}]}})
        elif line.strip() == "---":
            blocks.append({"object": "block", "type": "divider", "divider": {}})
        elif line.strip():
            blocks.append({"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": line[:2000]}}]}})
    return blocks


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

def send_email(digest_md: str, scan_time: datetime, total_findings: int):
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")
    recipient = os.environ.get("RECIPIENT_EMAIL", smtp_user)

    if not smtp_user or not smtp_pass:
        print("[INFO] SMTP credentials not set — skipping email.", file=sys.stderr)
        return

    subject = f"[HF Security Intel] {total_findings} findings — {scan_time.strftime('%Y-%m-%d %H:%M UTC')}"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = recipient

    msg.attach(MIMEText(digest_md, "plain"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.ehlo()
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, [recipient], msg.as_string())
        print(f"[INFO] Email sent to {recipient}")
    except Exception as e:
        print(f"[WARN] Email send failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    scan_time = datetime.now(timezone.utc)
    state = load_state()

    # Determine scan window
    last_run_str = state.get("last_run")
    if last_run_str:
        last_run = datetime.fromisoformat(last_run_str)
        scan_window_hours = max(1, int((scan_time - last_run).total_seconds() / 3600) + 1)
        since = last_run - timedelta(minutes=5)  # small buffer
    else:
        since = scan_time - timedelta(hours=24)
        scan_window_hours = 24

    print(f"[INFO] Scanning HF Hub since {since.isoformat()} ({scan_window_hours}h window)...")

    raw_items = collect_security_repos(since=since, limit_per_query=30)
    print(f"[INFO] Collected {len(raw_items)} candidate repositories.")

    # Filter out already-seen IDs
    seen_ids = set(state.get("seen_ids", []))
    new_items = [i for i in raw_items if (i.get("id") or "") not in seen_ids]
    print(f"[INFO] {len(new_items)} new/unseen repositories after deduplication.")

    findings = [build_finding(item) for item in new_items]

    digest = generate_digest(findings, scan_time, scan_window_hours)

    # Output digest to stdout / file
    output_path = Path(os.environ.get("DIGEST_OUTPUT", "/tmp/hf_security_digest.md"))
    output_path.write_text(digest)
    print(f"[INFO] Digest written to {output_path}")
    print(digest[:500] + "..." if len(digest) > 500 else digest)

    # Post to Notion
    post_to_notion(digest, scan_time, len(findings))

    # Send email
    send_email(digest, scan_time, len(findings))

    # Update state
    new_seen = list(seen_ids | {(i.get("id") or "") for i in new_items})
    # Keep only last 5000 IDs to avoid unbounded growth
    state["last_run"] = scan_time.isoformat()
    state["seen_ids"] = new_seen[-5000:]
    save_state(state)

    print(f"[INFO] Scan complete. {len(findings)} findings processed.")


if __name__ == "__main__":
    main()
