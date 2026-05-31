#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Runs hourly via GitHub Actions to scan for new/updated security-related
repositories across Models, Datasets, and Spaces.
"""

import os
import json
import re
import smtplib
import sys
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests

# ── Configuration ─────────────────────────────────────────────────────────────
NOTION_TOKEN  = os.environ.get("NOTION_TOKEN", "")
NOTION_PAGE_ID = os.environ.get("NOTION_PARENT_PAGE_ID", "")  # parent page for reports
GMAIL_USER    = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")
RECIPIENT     = os.environ.get("REPORT_RECIPIENT", "")
HF_TOKEN      = os.environ.get("HF_TOKEN", "")

# Tags to sweep (single-word queries that HF search handles well)
SECURITY_QUERIES = [
    "cybersecurity", "malware", "ransomware", "phishing",
    "exploit", "pentest", "osint", "stealer",
    "red-team", "threat-intelligence", "forensic", "vulnerability",
]

REPO_TYPES = ["model", "dataset", "space"]

# Risk keywords that escalate a repo's classification
CRITICAL_KW   = ["zero-click", "c2", "command-and-control", "stealer", "botnet",
                  "infostealer", "darkweb", "darknet", "payload", "ransomware-source"]
HIGH_KW       = ["uncensored", "abliterated", "heretic", "jailbreak", "harmful",
                 "exploit-db", "malware-source", "venomx"]
DUAL_USE_KW   = ["red-team", "offensive-security", "pentest", "exploit", "bypass",
                 "uncensored", "abliterat"]
DEFENSIVE_KW  = ["detection", "defensive", "soc", "dfir", "cti", "threat-intel",
                 "incident-response", "yara", "sigma", "classifier", "dataset"]

HOURS_LOOKBACK = 1  # only surface repos modified in the last N hours
RUN_NUMBER_FILE = "/tmp/hf_scan_run_number.txt"

# ── Helpers ────────────────────────────────────────────────────────────────────

def get_run_number() -> int:
    gha_run = os.environ.get("GITHUB_RUN_NUMBER")
    if gha_run:
        try:
            return int(gha_run)
        except ValueError:
            pass
    try:
        with open(RUN_NUMBER_FILE) as f:
            return int(f.read().strip()) + 1
    except Exception:
        return 2  # baseline was run #1


def save_run_number(n: int):
    with open(RUN_NUMBER_FILE, "w") as f:
        f.write(str(n))


def hf_search(query: str, repo_type: str, sort: str = "lastModified", limit: int = 30) -> list:
    headers = {}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"

    endpoint_map = {
        "model":   "https://huggingface.co/api/models",
        "dataset": "https://huggingface.co/api/datasets",
        "space":   "https://huggingface.co/api/spaces",
    }
    url = endpoint_map[repo_type]
    params = {
        "search": query,
        "sort": sort,
        "limit": limit,
        "full": "false",
    }
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  [warn] HF API error for {repo_type}/{query}: {e}", file=sys.stderr)
        return []


def is_recent(repo: dict, hours: int) -> bool:
    ts = repo.get("lastModified") or repo.get("createdAt", "")
    if not ts:
        return False
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt >= datetime.now(timezone.utc) - timedelta(hours=hours)
    except Exception:
        return False


def classify(repo: dict) -> str:
    blob = json.dumps(repo).lower()
    name = (repo.get("id") or repo.get("modelId") or "").lower()
    tags_val = repo.get("tags")
    tags = " ".join(str(t) for t in tags_val if t is not None).lower() if isinstance(tags_val, list) else ""
    desc = (repo.get("cardData", {}) or {}).get("description", "") if isinstance(repo.get("cardData"), dict) else ""
    combined = f"{name} {tags} {desc} {blob[:400]}"

    if any(k in combined for k in CRITICAL_KW):
        return "Suspicious/Critical"
    if any(k in combined for k in HIGH_KW):
        return "Suspicious/High"
    if any(k in combined for k in DUAL_USE_KW):
        return "Dual-use"
    if any(k in combined for k in DEFENSIVE_KW):
        return "Defensive"
    return "Research/Educational"


def risk_emoji(classification: str) -> str:
    return {"Suspicious/Critical": "🔴", "Suspicious/High": "🟠",
            "Dual-use": "🟡", "Defensive": "🟢", "Research/Educational": "🔵"}.get(classification, "⚪")


def repo_url(repo: dict, repo_type: str) -> str:
    rid = repo.get("id") or repo.get("modelId") or repo.get("name") or "unknown"
    prefix = {"model": "https://hf.co/", "dataset": "https://hf.co/datasets/",
               "space": "https://hf.co/spaces/"}.get(repo_type, "https://hf.co/")
    return prefix + rid


# ── Main Scan ──────────────────────────────────────────────────────────────────

def scan() -> list:
    seen_ids: set = set()
    findings: list = []

    for query in SECURITY_QUERIES:
        for rt in REPO_TYPES:
            repos = hf_search(query, rt, sort="lastModified", limit=30)
            if not isinstance(repos, list):
                continue
            for r in repos:
                rid = r.get("id") or r.get("modelId") or r.get("name") or ""
                if not rid or rid in seen_ids:
                    continue
                if not is_recent(r, HOURS_LOOKBACK):
                    continue
                seen_ids.add(rid)
                cls = classify(r)
                findings.append({
                    "id": rid,
                    "type": rt.capitalize(),
                    "url": repo_url(r, rt),
                    "author": rid.split("/")[0] if "/" in rid else "unknown",
                    "updated": r.get("lastModified") or r.get("createdAt", ""),
                    "tags": r.get("tags") or [],
                    "downloads": r.get("downloads", 0),
                    "likes": r.get("likes", 0),
                    "classification": cls,
                    "query_match": query,
                })

    # sort by risk then downloads
    order = ["Suspicious/Critical", "Suspicious/High", "Dual-use", "Research/Educational", "Defensive"]
    findings.sort(key=lambda x: (order.index(x["classification"]) if x["classification"] in order else 99,
                                  -x.get("downloads", 0)))
    return findings


# ── Digest Builder ─────────────────────────────────────────────────────────────

def build_digest(findings: list, run_number: int) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    tier1 = [f for f in findings if f["classification"].startswith("Suspicious")]
    tier2 = [f for f in findings if f["classification"] == "Dual-use"]
    defensive = [f for f in findings if f["classification"] in ("Defensive", "Research/Educational")]

    exec_summary = (
        f"Delta scan for the past {HOURS_LOOKBACK}h found {len(findings)} new/updated "
        f"security-related repositories on Hugging Face Hub. "
        f"{len(tier1)} flagged as suspicious, {len(tier2)} dual-use, "
        f"{len(defensive)} defensive/research."
    )

    if not findings:
        exec_summary = (
            f"No new or materially changed security repositories detected in the past {HOURS_LOOKBACK}h. "
            "Low-noise cycle — no action required."
        )

    return {
        "title": f"HF Security Digest — {date} — Run #{run_number}",
        "date": date,
        "timestamp": now,
        "run_number": run_number,
        "total": len(findings),
        "tier1_count": len(tier1),
        "tier2_count": len(tier2),
        "defensive_count": len(defensive),
        "exec_summary": exec_summary,
        "tier1": tier1,
        "tier2": tier2,
        "defensive": defensive,
    }


# ── Notion ─────────────────────────────────────────────────────────────────────

def _strip_inline_md(text: str) -> str:
    """Remove common inline Markdown so raw syntax isn't visible in Notion."""
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)        # **bold**
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text) # [label](url) → label
    text = re.sub(r"_(.+?)_", r"\1", text)               # _italic_
    return text


def _notion_block(block_type: str, text: str) -> dict:
    """Return a single Notion block dict with multiple rich_text elements (<=2000 chars each)."""
    text = text or " "
    rich_text = [
        {"type": "text", "text": {"content": text[i : i + 2000]}}
        for i in range(0, len(text), 2000)
    ]
    return {
        "object": "block",
        "type": block_type,
        block_type: {"rich_text": rich_text},
    }


def markdown_to_notion_blocks(md: str) -> list:
    """Convert a Markdown string to a flat list of Notion block objects.

    Handles: ## headings, ### headings, --- dividers, | tables |,
    - bullet items, and plain paragraphs.  All rich_text strings are
    capped at 2000 characters as required by the Notion API.
    """
    blocks = []
    for raw_line in md.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("## "):
            blocks.append(_notion_block("heading_2", line[3:].strip()))
        elif line.startswith("### "):
            blocks.append(_notion_block("heading_3", line[4:].strip()))
        elif re.match(r"^-{3,}$", line):
            blocks.append({"object": "block", "type": "divider", "divider": {}})
        elif re.match(r"^\|[\s\-|]+\|$", line):
            # Table separator row — skip
            continue
        elif line.startswith("|") and line.endswith("|"):
            # Table data row → plain paragraph
            cells = [c.strip() for c in line.strip("|").split("|")]
            blocks.append(_notion_block("paragraph", " | ".join(cells)))
        elif line.startswith("- "):
            blocks.append(_notion_block("bulleted_list_item", _strip_inline_md(line[2:])))
        else:
            blocks.append(_notion_block("paragraph", _strip_inline_md(line)))
    return blocks


def _notion_append_blocks(page_id: str, blocks: list, headers: dict):
    """Append blocks to an existing Notion page in batches of 100."""
    for i in range(0, len(blocks), 100):
        batch = blocks[i : i + 100]
        r = requests.patch(
            f"https://api.notion.com/v1/blocks/{page_id}/children",
            headers=headers,
            json={"children": batch},
            timeout=20,
        )
        if not r.ok:
            print(f"[notion] Append error {r.status_code}: {r.text[:300]}", file=sys.stderr)
            return


def post_to_notion(digest: dict):
    if not NOTION_TOKEN or not NOTION_PAGE_ID:
        print("[skip] NOTION_TOKEN or NOTION_PARENT_PAGE_ID not set", file=sys.stderr)
        return

    meta_rows = [
        f"| Timestamp | {digest['timestamp']} |",
        f"| Run | #{digest['run_number']} |",
        f"| Lookback window | {HOURS_LOOKBACK}h |",
        f"| Total new/updated | {digest['total']} |",
        f"| Tier 1 (Suspicious) | {digest['tier1_count']} |",
        f"| Tier 2 (Dual-use) | {digest['tier2_count']} |",
        f"| Defensive/Research | {digest['defensive_count']} |",
    ]

    def finding_lines(items: list) -> list:
        if not items:
            return ["- None this cycle."]
        lines = []
        for f in items:
            emoji = risk_emoji(f["classification"])
            tag_str = ", ".join(f["tags"][:6]) if f["tags"] else "—"
            lines.append(
                f"- {emoji} {f['id']} ({f['url']}) "
                f"({f['type']}) · {f['classification']} · "
                f"DL:{f.get('downloads', 0)} · {f['query_match']} · tags: {tag_str}"
            )
        return lines

    md_sections = [
        "## Scan Metadata",
        "| Field | Value |",
        "|-------|-------|",
        *meta_rows,
        "---",
        "## Executive Summary",
        digest["exec_summary"],
        "---",
        "## Tier 1 — Suspicious Findings",
        *finding_lines(digest["tier1"]),
        "---",
        "## Tier 2 — Dual-Use / Elevated",
        *finding_lines(digest["tier2"]),
        "---",
        "## Defensive / Research",
        *finding_lines(digest["defensive"]),
        "---",
        "Auto-generated by hf_security_scanner.py · canstralian/splat",
    ]

    all_blocks = markdown_to_notion_blocks("\n".join(md_sections))

    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }

    # Notion allows at most 100 children on page creation; append the rest after.
    first_batch = all_blocks[:100]
    remainder   = all_blocks[100:]

    page_body: dict = {
        "parent": {"page_id": NOTION_PAGE_ID},
        "properties": {
            "title": {
                "title": [{"type": "text", "text": {"content": digest["title"]}}]
            }
        },
        "children": first_batch,
    }

    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=headers,
        json=page_body,
        timeout=20,
    )
    if not r.ok:
        print(f"[notion] Error {r.status_code}: {r.text[:300]}", file=sys.stderr)
        return

    page_id  = r.json().get("id", "")
    page_url = r.json().get("url", "")
    print(f"[notion] Page created: {page_url}")

    if remainder and page_id:
        _notion_append_blocks(page_id, remainder, headers)
        print(f"[notion] Appended {len(remainder)} additional blocks")


# ── Gmail ──────────────────────────────────────────────────────────────────────

def send_email(digest: dict):
    if not GMAIL_USER or not GMAIL_APP_PASS or not RECIPIENT:
        print("[skip] GMAIL_USER, GMAIL_APP_PASSWORD, or REPORT_RECIPIENT not set", file=sys.stderr)
        return

    subject = digest["title"]

    if digest["total"] == 0:
        plain = (
            f"HF Security Scanner — {digest['timestamp']}\n\n"
            "No new or updated security repositories detected this cycle.\n\n"
            "Low-noise run — no action required."
        )
        html = f"<p>{plain}</p>"
    else:
        def section(items, label):
            if not items:
                return f"<p><b>{label}:</b> None this cycle.</p>"
            rows = "".join(
                f"<tr><td>{risk_emoji(f['classification'])}</td>"
                f"<td><a href='{f['url']}'>{f['id']}</a></td>"
                f"<td>{f['type']}</td>"
                f"<td>{f['classification']}</td>"
                f"<td>{f.get('downloads',0)}</td></tr>"
                for f in items
            )
            return (
                f"<h3>{label}</h3>"
                f"<table border='1' cellpadding='4' style='border-collapse:collapse;font-size:12px'>"
                f"<tr><th></th><th>Repo</th><th>Type</th><th>Class</th><th>DL</th></tr>"
                f"{rows}</table>"
            )

        html = f"""<html><body style='font-family:Arial,sans-serif;max-width:900px'>
<h2 style='background:#0f172a;color:#f8fafc;padding:12px 16px;border-radius:6px'>{subject}</h2>
<p>{digest['exec_summary']}</p>
{section(digest['tier1'], '🔴🟠 Tier 1 — Suspicious')}
{section(digest['tier2'], '🟡 Tier 2 — Dual-Use')}
{section(digest['defensive'][:10], '🟢 Defensive / Research (top 10)')}
<hr><p style='color:#888;font-size:11px'>Generated by hf_security_scanner.py | canstralian/splat</p>
</body></html>"""
        plain = f"{subject}\n\n{digest['exec_summary']}\n\nSee HTML version for full table."

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = GMAIL_USER
    msg["To"]      = RECIPIENT
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as server:
            server.login(GMAIL_USER, GMAIL_APP_PASS)
            server.sendmail(GMAIL_USER, RECIPIENT, msg.as_string())
        print(f"[email] Sent to {RECIPIENT}")
    except Exception as e:
        print(f"[email] Error: {e}", file=sys.stderr)


# ── Entry Point ────────────────────────────────────────────────────────────────

def main():
    run_number = get_run_number()
    print(f"[scan] Starting run #{run_number} at {datetime.now(timezone.utc).isoformat()}")
    print(f"[scan] Lookback window: {HOURS_LOOKBACK}h | Queries: {len(SECURITY_QUERIES)} | Types: {REPO_TYPES}")

    findings = scan()
    print(f"[scan] {len(findings)} new/updated repos found")

    digest = build_digest(findings, run_number)
    post_to_notion(digest)
    send_email(digest)
    save_run_number(run_number)

    # Print summary for GHA logs
    print(f"\n=== Run #{run_number} Summary ===")
    print(f"Total findings: {digest['total']}")
    print(f"Tier 1 (suspicious): {digest['tier1_count']}")
    print(f"Tier 2 (dual-use):   {digest['tier2_count']}")
    print(f"Defensive/Research:  {digest['defensive_count']}")
    if digest["tier1"]:
        print("\nTier 1 items:")
        for f in digest["tier1"]:
            print(f"  {risk_emoji(f['classification'])} {f['id']} ({f['type']}) — {f['url']}")


if __name__ == "__main__":
    main()
