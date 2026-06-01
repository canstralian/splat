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
    """
    Determine the run number for this scan.
    
    Checks the GITHUB_RUN_NUMBER environment variable first and returns it if it is a valid integer. If not present or invalid, attempts to read RUN_NUMBER_FILE, increment that stored value by 1, and return the result. If both methods fail, returns 2.
    
    Returns:
        run_number (int): The resolved run number.
    """
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
    """
    Persist the provided run number to the configured run-number file.
    
    Parameters:
        n (int): Run number to write; the file will be overwritten with the decimal representation of this integer.
    """
    with open(RUN_NUMBER_FILE, "w") as f:
        f.write(str(n))


def hf_search(query: str, repo_type: str, sort: str = "lastModified", limit: int = 30) -> list:
    """
    Search the Hugging Face Hub for repositories matching a text query and repository type.
    
    Parameters:
    	query (str): Search string sent to the Hugging Face search endpoint.
    	repo_type (str): One of "model", "dataset", or "space" selecting the HF API endpoint.
    	sort (str): Field to sort results by (default: "lastModified").
    	limit (int): Maximum number of results to request (default: 30).
    
    Returns:
    	list: Parsed JSON array of repository entries returned by the HF API; returns an empty list if the request fails or an error occurs.
    
    Notes:
    	If the environment variable `HF_TOKEN` is set, an Authorization header using that token will be included.
    """
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
    """
    Determine whether a repository's lastModified or createdAt timestamp is within the past `hours` hours.
    
    Checks the repository dictionary for `lastModified` or `createdAt` (expected in ISO 8601 format, e.g. "2023-05-01T12:34:56Z") and compares it to the current UTC time minus `hours`.
    
    Parameters:
        repo (dict): Repository metadata containing `lastModified` or `createdAt` timestamp strings.
        hours (int): Number of hours to look back.
    
    Returns:
        bool: `true` if the repository's timestamp is greater than or equal to (now UTC - `hours`), `false` otherwise.
    """
    ts = repo.get("lastModified") or repo.get("createdAt", "")
    if not ts:
        return False
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt >= datetime.now(timezone.utc) - timedelta(hours=hours)
    except Exception:
        return False


def classify(repo: dict) -> str:
    """
    Assigns a risk classification to a Hugging Face repository by matching predefined keyword groups against its metadata.
    
    Checks the repository's identifier, tags, card description, and a truncated JSON serialization (case-insensitive) for keywords and returns the highest-severity matching tier in this precedence: Suspicious/Critical, Suspicious/High, Dual-use, Defensive, otherwise Research/Educational.
    
    Parameters:
        repo (dict): Repository metadata as returned by the Hugging Face API.
    
    Returns:
        str: One of "Suspicious/Critical", "Suspicious/High", "Dual-use", "Defensive", or "Research/Educational" indicating the assigned risk tier.
    """
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
    """
    Map a classification label to a single emoji representing its risk tier.
    
    Parameters:
    	classification (str): Classification label, e.g. "Suspicious/Critical", "Suspicious/High", "Dual-use", "Defensive", or "Research/Educational".
    
    Returns:
    	emoji (str): The emoji for the classification — `🔴` for "Suspicious/Critical", `🟠` for "Suspicious/High", `🟡` for "Dual-use", `🟢` for "Defensive", `🔵` for "Research/Educational", or `⚪` if the label is unrecognized.
    """
    return {"Suspicious/Critical": "🔴", "Suspicious/High": "🟠",
            "Dual-use": "🟡", "Defensive": "🟢", "Research/Educational": "🔵"}.get(classification, "⚪")


def repo_url(repo: dict, repo_type: str) -> str:
    """
    Constructs the Hugging Face URL for a repository entry based on its identifier and type.
    
    Parameters:
        repo (dict): Repository metadata; uses `id`, `modelId`, or `name` (in that order) as the identifier.
        repo_type (str): One of `"model"`, `"dataset"`, or `"space"` to determine the URL path.
    
    Returns:
        url (str): Full HF URL for the repository (e.g., `https://hf.co/<id>`, `https://hf.co/datasets/<id>`, or `https://hf.co/spaces/<id>`). If no identifier is found, returns a URL ending with `unknown`.
    """
    rid = repo.get("id") or repo.get("modelId") or repo.get("name") or "unknown"
    prefix = {"model": "https://hf.co/", "dataset": "https://hf.co/datasets/",
               "space": "https://hf.co/spaces/"}.get(repo_type, "https://hf.co/")
    return prefix + rid


# ── Main Scan ──────────────────────────────────────────────────────────────────

def scan() -> list:
    """
    Scan the Hugging Face Hub for recent repositories matching configured security queries and return classified, deduplicated findings.
    
    Searches Models, Datasets, and Spaces for each keyword in SECURITY_QUERIES, filters results to items updated within the configured lookback window, deduplicates by repository identifier, classifies each hit by risk tier, and sorts the final list by classification severity and descending download count. Each finding dictionary contains the keys:
    - `id`: repository identifier (e.g., "owner/name")
    - `type`: one of "Model", "Dataset", or "Space"
    - `url`: full repository URL
    - `author`: owner portion of the identifier or "unknown"
    - `updated`: timestamp from `lastModified` or `createdAt`
    - `tags`: list of repository tags (may be empty)
    - `downloads`: download count (integer, default 0)
    - `likes`: like count (integer, default 0)
    - `classification`: classification string assigned by `classify`
    - `query_match`: the security query that produced the hit
    
    Returns:
        list: A list of finding dictionaries sorted by risk tier (highest severity first) and then by downloads descending.
    """
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
    """
    Builds a digest summary and categorized lists from scan findings for inclusion in reports.
    
    Parameters:
        findings (list): List of finding dictionaries produced by scan(), each expected to include keys such as
            "id", "type", "url", "author", "updated", "tags", "downloads", "likes", and "classification".
        run_number (int): Monotonic run identifier to include in the digest title.
    
    Returns:
        dict: A digest containing:
            - "title" (str): Human-friendly title including date and run number.
            - "date" (str): Date string (YYYY-MM-DD) for the digest.
            - "timestamp" (str): UTC timestamp for when the digest was built.
            - "run_number" (int): Echo of the provided run number.
            - "total" (int): Total number of findings.
            - "tier1_count" (int): Count of findings classified as Suspicious (tier 1).
            - "tier2_count" (int): Count of findings classified as Dual-use (tier 2).
            - "defensive_count" (int): Count of findings classified as Defensive or Research/Educational.
            - "exec_summary" (str): Short human-readable executive summary of counts and scan outcome.
            - "tier1" (list): List of findings in tier 1 (classifications starting with "Suspicious").
            - "tier2" (list): List of findings in tier 2 (classification == "Dual-use").
            - "defensive" (list): List of defensive/research findings (classifications "Defensive" or "Research/Educational").
    """
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
    """
    Strip common inline Markdown (bold, italic, and links) from a string.
    
    This removes `**bold**`, `_italic_`, and `[label](url)` patterns so the visible text remains without inline Markdown syntax.
    
    Parameters:
        text (str): Input string that may contain inline Markdown.
    
    Returns:
        str: The input with inline Markdown constructs replaced by their plain-text content.
    """
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)        # **bold**
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text) # [label](url) → label
    text = re.sub(r"_(.+?)_", r"\1", text)               # _italic_
    return text


def _notion_block(block_type: str, text: str) -> dict:
    """
    Create a Notion block payload for the given block type where the provided text is split into rich_text elements of up to 2000 characters.
    
    Parameters:
        block_type (str): Notion block type (e.g., "paragraph", "heading_2").
        text (str): Text content to include in the block; if falsy, a single space is used.
    
    Returns:
        notion_block (dict): A dict representing a Notion block with `object: "block"`, a `type` key set to `block_type`, and a `rich_text` array under the block type containing one entry per 2000-character segment.
    """
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
    """
    Convert a Markdown string into a flat list of Notion block objects.
    
    Supports line-based conversions:
    - "## " → heading_2
    - "### " → heading_3
    - lines of three or more dashes (---) → divider
    - pipe-delimited rows ("| cell | cell |") → paragraph (cells joined by " | "); table separator rows like "| --- |" are skipped
    - "- " bullet lines → bulleted_list_item (inline Markdown is stripped)
    - other non-empty lines → paragraph (inline Markdown is stripped)
    
    Rich text in each block is split into chunks of up to 2000 characters to comply with the Notion API.
    
    Parameters:
        md (str): Markdown source to convert.
    
    Returns:
        list: A list of Notion block dictionaries suitable for use in Notion API requests.
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
    """
    Append a list of Notion blocks to a page in batches of up to 100.
    
    Stops on the first failed batch and logs the HTTP status and a truncated response body to stderr.
    
    Parameters:
        page_id (str): ID of the Notion page (block) whose children will be appended.
        blocks (list): Sequence of Notion block payloads to append.
        headers (dict): HTTP headers to include with each request (e.g., authorization and Notion version).
    """
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
    """
    Create a Notion page containing the provided scan digest and append additional content if needed.
    
    Creates a new page under the configured Notion parent page using the digest title and converts the digest content into Notion blocks. If the initial creation includes only the first 100 blocks, the remainder are appended to the created page. If Notion credentials or parent page ID are not configured, the function logs a skip and returns without performing network calls. HTTP errors from the Notion API are logged and cause the function to stop further processing.
    
    Parameters:
        digest (dict): A digest produced by build_digest with the following expected keys:
            - title (str): Page title.
            - timestamp (str): Human-readable timestamp for metadata.
            - run_number (int): Scan run identifier.
            - total (int): Total number of findings.
            - tier1_count (int), tier2_count (int), defensive_count (int): counts per tier.
            - exec_summary (str): Executive summary text.
            - tier1 (list), tier2 (list), defensive (list): lists of finding dicts where each finding may include:
                - id (str), url (str), type (str), classification (str), downloads (int), query_match (str), tags (list).
    """
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
        """
        Format a list of finding dictionaries into Markdown list lines suitable for report output.
        
        Parameters:
            items (list): Sequence of finding dictionaries. Each dictionary is expected to contain at least:
                - "id" (str): repository identifier
                - "url" (str): link to the repository
                - "type" (str): repository type (e.g., "Model", "Dataset", "Space")
                - "classification" (str): classification label used to select an emoji
                - "query_match" (str): the query that produced the hit
                - "tags" (list): list of tag strings (may be empty)
                - "downloads" (int, optional): download count
        
        Returns:
            list: A list of Markdown-formatted list item strings. If `items` is empty, returns a single-item list:
            "- None this cycle."
        """
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
    """
    Send the provided digest as a multipart (plain + HTML) email via Gmail SMTP.
    
    If required Gmail environment variables (sender user, app password, or recipient) are not set, the function logs a skip message and returns without sending. When the digest contains no findings, the message contains a brief no-findings notice; otherwise the HTML part includes an executive summary and tables for Tier 1, Tier 2, and the top 10 defensive/research items.
    
    Parameters:
        digest (dict): Digest produced by build_digest with keys used here:
            - "title": subject line for the email
            - "total": total number of findings (int)
            - "timestamp": human-readable scan timestamp
            - "exec_summary": short executive summary text
            - "tier1": list of finding dicts for Suspicious findings
            - "tier2": list of finding dicts for Dual-use findings
            - "defensive": list of finding dicts for Defensive/Research findings
    
    Side effects:
        Sends an email via smtp.gmail.com using GMAIL_USER, GMAIL_APP_PASS, and RECIPIENT.
        Prints success or error messages to stdout/stderr.
    """
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
            """
            Render an HTML section for a list of findings with a heading and table, or a short "none this cycle" paragraph when empty.
            
            Parameters:
                items (list[dict]): Sequence of finding records. Each record is expected to contain at least the keys:
                    - `id`: repository identifier shown as link text
                    - `url`: repository URL used for the link
                    - `type`: repository type label (e.g., "Model", "Dataset", "Space")
                    - `classification`: classification string used for display and for mapping to an emoji
                    - `downloads` (optional): integer download count
                label (str): Heading text for the section (e.g., "Tier 1 — Suspicious Findings").
            
            Returns:
                str: HTML fragment containing either a paragraph indicating no items or an H3 heading followed by a bordered HTML table
                     with columns for emoji, repo link, type, classification, and download count.
            """
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
    """
    Orchestrates a full Hugging Face security scan run and publishes the resulting digest.
    
    Performs a single scan cycle: determines the run number, discovers recent HF repositories matching configured queries, builds an aggregated digest, posts the digest to Notion (if configured), sends the digest via Gmail (if configured), persists the run number, and prints concise execution and summary logs for CI.
    """
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
