#!/usr/bin/env python3
"""
HF Security Intelligence Scanner
Scans Hugging Face Hub hourly for security-relevant repositories.

Required environment variables:
  HF_TOKEN               - Hugging Face API token (optional but increases rate limits)
  NOTION_TOKEN           - Notion integration token
  NOTION_PARENT_PAGE_ID  - Notion page ID to nest reports under
  GMAIL_USER             - Gmail address (e.g. you@gmail.com)
  GMAIL_APP_PASSWORD     - Gmail App Password (not account password)
  RECIPIENT_EMAIL        - Report delivery address
  FORCE_REPORT           - 'true' to send email/Notion even with no new findings
"""

from __future__ import annotations

import json
import os
import re
import smtplib
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any

import requests

# ── Config ────────────────────────────────────────────────────────────────────

HF_API = "https://huggingface.co/api"
HF_TOKEN = os.getenv("HF_TOKEN", "")
NOTION_TOKEN = os.getenv("NOTION_TOKEN", "")
NOTION_PARENT_PAGE_ID = os.getenv("NOTION_PARENT_PAGE_ID", "")
GMAIL_USER = os.getenv("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")
RECIPIENT_EMAIL = os.getenv("RECIPIENT_EMAIL", "")
FORCE_REPORT = os.getenv("FORCE_REPORT", "false").lower() == "true"

SCRIPTS_DIR = Path(__file__).parent
STATE_FILE = SCRIPTS_DIR / "scan_state.json"
DIGEST_FILE = SCRIPTS_DIR / "latest_digest.md"

SECURITY_QUERIES: list[str] = [
    "malware",
    "ransomware",
    "exploit",
    "phishing",
    "osint",
    "threat-intelligence",
    "red-team",
    "pentest",
    "yara",
    "sigma",
    "reverse-engineering",
    "vulnerability",
    "c2",
    "stealer",
    "botnet",
    "infostealer",
    "CVE",
    "malware-analysis",
    "forensic",
    "detection-engineering",
    "cybersecurity",
    "intrusion-detection",
    "shellcode",
    "rootkit",
    "backdoor",
    "keylogger",
    "trojan",
    "spyware",
    "cryptojacking",
    "APT",
    "incident-response",
]

SUSPICIOUS_TERMS = frozenset({
    "stealer", "infostealer", "c2", "botnet", "ransomware", "backdoor",
    "rootkit", "shellcode", "keylogger", "trojan", "worm", "spyware",
    "cryptojacking", "dropper", "loader", "stager",
})

DUAL_USE_TERMS = frozenset({
    "exploit", "red-team", "redteam", "offensive", "pentest", "bypass",
    "evasion", "obfuscation", "payload", "post-exploitation",
})

DEFENSIVE_TERMS = frozenset({
    "detection", "defender", "scanner", "monitor", "siem", "forensic",
    "incident-response", "blue-team", "threat-hunting", "ids", "ips", "edr",
    "soc", "yara", "sigma", "detection-engineering", "antivirus",
})

HF_HEADERS: dict[str, str] = (
    {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}
)


# ── HF API ────────────────────────────────────────────────────────────────────

def hf_search(query: str, repo_type: str, limit: int = 40) -> list[dict]:
    url = f"{HF_API}/{repo_type}s"
    params: dict[str, Any] = {
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": limit,
        "full": True,
    }
    try:
        r = requests.get(url, headers=HF_HEADERS, params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[WARN] HF {repo_type}s search '{query}': {e}", file=sys.stderr)
        return []


def fetch_all_security_repos() -> list[dict]:
    seen_ids: set[str] = set()
    results: list[dict] = []

    for repo_type in ("model", "dataset", "space"):
        for query in SECURITY_QUERIES:
            for repo in hf_search(query, repo_type):
                rid = (
                    repo.get("id")
                    or repo.get("modelId")
                    or repo.get("name", "")
                )
                full_id = f"{repo_type}/{rid}"
                if full_id not in seen_ids:
                    seen_ids.add(full_id)
                    repo["_type"] = repo_type
                    repo["_full_id"] = full_id
                    results.append(repo)

    return results


# ── Classification ────────────────────────────────────────────────────────────

def _corpus(repo: dict) -> str:
    tags = " ".join(repo.get("tags", [])).lower()
    rid = (repo.get("id") or repo.get("modelId") or repo.get("name", "")).lower()
    card = (repo.get("cardData") or {}).get("description", "").lower()
    return f"{rid} {tags} {card}"


def classify(repo: dict) -> str:
    c = _corpus(repo)
    susp = sum(1 for t in SUSPICIOUS_TERMS if t in c)
    dual = sum(1 for t in DUAL_USE_TERMS if t in c)
    defen = sum(1 for t in DEFENSIVE_TERMS if t in c)

    if susp >= 3:
        return "Suspicious"
    if susp >= 1 and defen == 0:
        return "Dual-use" if dual or susp else "Suspicious"
    if dual >= 2 and defen == 0:
        return "Dual-use"
    if defen >= 2:
        return "Defensive"
    if any(kw in c for kw in ("research", "academic", "paper", "benchmark")):
        return "Research"
    return "Educational"


def estimate_risk(repo: dict, classification: str) -> str:
    downloads = repo.get("downloads", 0) or 0
    likes = repo.get("likes", 0) or 0

    if classification == "Suspicious":
        return "HIGH"
    if classification == "Dual-use":
        return "HIGH" if (downloads > 30 or likes > 5) else "MEDIUM"
    if downloads > 500 or likes > 15:
        return "MEDIUM"
    return "LOW"


# ── State ─────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"seen": {}, "last_run": None}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, default=str))


def filter_new_or_changed(repos: list[dict], state: dict) -> list[dict]:
    seen = state.get("seen", {})
    return [
        r for r in repos
        if r["_full_id"] not in seen
        or seen[r["_full_id"]] != r.get("lastModified", "")
    ]


# ── Entry builder ─────────────────────────────────────────────────────────────

def build_entry(repo: dict) -> dict:
    repo_type = repo.get("_type", "unknown")
    rid = repo.get("id") or repo.get("modelId") or repo.get("name", "")
    author = rid.split("/")[0] if "/" in rid else "unknown"
    prefix = {"model": "", "dataset": "datasets/", "space": "spaces/"}.get(repo_type, "")
    classification = classify(repo)

    return {
        "full_id": rid,
        "name": rid.split("/")[-1],
        "type": repo_type.capitalize(),
        "url": f"https://huggingface.co/{prefix}{rid}",
        "author": author,
        "created": (repo.get("createdAt") or "")[:10],
        "modified": (repo.get("lastModified") or "")[:10],
        "tags": repo.get("tags", []),
        "classification": classification,
        "risk": estimate_risk(repo, classification),
        "downloads": repo.get("downloads", 0) or 0,
        "likes": repo.get("likes", 0) or 0,
        "trending_score": repo.get("trendingScore", 0) or 0,
    }


# ── Digest ────────────────────────────────────────────────────────────────────

def detect_patterns(entries: list[dict]) -> list[str]:
    patterns = []
    corpus = " ".join(
        e["full_id"] + " " + " ".join(e["tags"]) for e in entries
    ).lower()

    checks = [
        ("agent" in corpus and "skill" in corpus,
         "AI agent-skill malware classification datasets emerging (novel threat surface)"),
        ("scada" in corpus or "ot-malware" in corpus or "ics" in corpus,
         "OT/SCADA malware detection tooling increasing"),
        ("steering" in corpus or "bypass" in corpus or "abliterator" in corpus,
         "LLM safety-bypass/jailbreak steering datasets active"),
        ("cape" in corpus,
         "CAPE sandbox dynamic analysis data sharing active; large sample dumps present"),
        (sum(1 for e in entries if e["type"] == "Space") > 5,
         "High volume of new security-themed HF Spaces (possible course/competition activity)"),
        ("africa" in corpus,
         "Africa-region CTI/threat data emerging as new data source"),
        (sum(1 for e in entries if e["risk"] == "HIGH") > 3,
         f"Elevated HIGH-risk count this cycle: {sum(1 for e in entries if e['risk'] == 'HIGH')} items"),
    ]

    for condition, message in checks:
        if condition:
            patterns.append(message)

    return patterns


def generate_digest(entries: list[dict], scan_time: str, total: int) -> dict:
    by_risk: dict[str, list[dict]] = {"HIGH": [], "MEDIUM": [], "LOW": []}
    by_class: dict[str, list[dict]] = {}
    for e in entries:
        by_risk[e["risk"]].append(e)
        by_class.setdefault(e["classification"], []).append(e)

    # Sort high-signal by downloads+likes desc
    high_signal = sorted(
        by_risk["HIGH"] + by_risk["MEDIUM"],
        key=lambda e: e["downloads"] + e["likes"] * 5,
        reverse=True,
    )

    return {
        "scan_time": scan_time,
        "total_scanned": total,
        "new_or_changed": len(entries),
        "high_signal": high_signal,
        "by_risk": by_risk,
        "by_class": by_class,
        "patterns": detect_patterns(entries),
        "watchlist": [
            e for e in by_class.get("Suspicious", []) + by_class.get("Dual-use", [])
            if e["downloads"] > 10 or e["likes"] > 2
        ],
        "noise": by_class.get("Educational", []),
    }


# ── Rendering ─────────────────────────────────────────────────────────────────

def _entry_block(e: dict, idx: int | None = None) -> list[str]:
    prefix = f"{idx}. " if idx is not None else "- "
    lines = [
        f"{prefix}**[{e['full_id']}]({e['url']})** ({e['type']})",
        f"   - Classification: `{e['classification']}` | Risk: `{e['risk']}`",
        f"   - Author: `{e['author']}` | Created: {e['created']} | Updated: {e['modified']}",
        f"   - Downloads: {e['downloads']} | Likes: {e['likes']}",
    ]
    if e["tags"]:
        lines.append(f"   - Tags: {', '.join(e['tags'][:10])}")
    return lines


def render_markdown(digest: dict) -> str:
    d = digest
    hr = len(d["by_risk"]["HIGH"])
    mr = len(d["by_risk"]["MEDIUM"])
    lr = len(d["by_risk"]["LOW"])
    susp = len(d["by_class"].get("Suspicious", []))
    dual = len(d["by_class"].get("Dual-use", []))
    defen = len(d["by_class"].get("Defensive", []))
    res = len(d["by_class"].get("Research", []))
    edu = len(d["by_class"].get("Educational", []))

    lines: list[str] = [
        f"# HF Security Intelligence Digest",
        f"**Scan time:** {d['scan_time']}  ",
        f"**Repos scanned this cycle:** {d['total_scanned']} total | {d['new_or_changed']} new/changed",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
        (
            f"Hourly scan of Hugging Face Hub processed **{d['total_scanned']}** "
            f"security-relevant repositories across Models, Datasets, and Spaces. "
            f"**{d['new_or_changed']}** were new or materially updated since the previous run."
        ),
        "",
        f"| Risk Level | Count | Classification | Count |",
        f"|------------|-------|----------------|-------|",
        f"| 🔴 HIGH | {hr} | Suspicious | {susp} |",
        f"| 🟡 MEDIUM | {mr} | Dual-use | {dual} |",
        f"| 🟢 LOW | {lr} | Defensive | {defen} |",
        f"| — | — | Research | {res} |",
        f"| — | — | Educational | {edu} |",
        "",
    ]

    # High-signal findings
    if d["high_signal"]:
        lines += ["## High-Signal Findings", ""]
        for i, e in enumerate(d["high_signal"][:12], 1):
            lines += _entry_block(e, i)
            lines.append("")
    else:
        lines += ["## High-Signal Findings", "", "_No high or medium risk findings this cycle._", ""]

    # Emerging patterns
    if d["patterns"]:
        lines += ["## Emerging Patterns", ""]
        for p in d["patterns"]:
            lines.append(f"- {p}")
        lines.append("")

    # Watchlist
    if d["watchlist"]:
        lines += ["## Watchlist Items", ""]
        for e in d["watchlist"][:10]:
            lines += _entry_block(e)
            lines.append("")
    else:
        lines += ["## Watchlist Items", "", "_No new watchlist items this cycle._", ""]

    # Noise
    if d["noise"]:
        lines += [
            "## Possible False Positives / Noise",
            "",
            f"- {len(d['noise'])} repositories classified as **Educational** "
            f"(likely student projects or course assignments — low operational risk).",
            "",
        ]

    # Actions
    lines += [
        "## Recommended Follow-Up Actions",
        "",
        "1. Review all HIGH-risk items manually and verify against prior intelligence",
        "2. Report confirmed policy violations to HF Trust & Safety: https://huggingface.co/contact",
        "3. Cross-reference suspicious authors against known threat actor namespaces",
        "4. Add confirmed dual-use LLMs to organisational blocklist if required",
        "5. Next automated scan scheduled in 1 hour",
    ]

    return "\n".join(lines)


def render_html(markdown: str) -> str:
    h = markdown
    h = re.sub(r"^## (.+)$", r"<h2>\1</h2>", h, flags=re.MULTILINE)
    h = re.sub(r"^# (.+)$", r"<h1>\1</h1>", h, flags=re.MULTILINE)
    h = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", h)
    h = re.sub(r"`(.+?)`", r"<code>\1</code>", h)
    h = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', h)
    h = re.sub(r"^- (.+)$", r"<li>\1</li>", h, flags=re.MULTILINE)
    h = h.replace("\n\n", "<br><br>").replace("\n", "<br>")
    return (
        "<html><body style='font-family:Arial,sans-serif;max-width:900px;"
        "margin:0 auto;padding:20px'>"
        + h
        + "</body></html>"
    )


# ── Notion integration ────────────────────────────────────────────────────────

def _notion_rich_text(text: str) -> dict:
    return {"type": "text", "text": {"content": text[:2000]}}


def _parse_markdown_to_blocks(md: str) -> list[dict]:
    blocks: list[dict] = []
    for line in md.splitlines():
        stripped = line.strip()
        if not stripped or stripped == "---":
            continue
        if stripped.startswith("# "):
            blocks.append({"object": "block", "type": "heading_1",
                           "heading_1": {"rich_text": [_notion_rich_text(stripped[2:])]}})
        elif stripped.startswith("## "):
            blocks.append({"object": "block", "type": "heading_2",
                           "heading_2": {"rich_text": [_notion_rich_text(stripped[3:])]}})
        elif stripped.startswith("### "):
            blocks.append({"object": "block", "type": "heading_3",
                           "heading_3": {"rich_text": [_notion_rich_text(stripped[4:])]}})
        elif stripped.startswith("- ") or stripped.startswith("* "):
            blocks.append({"object": "block", "type": "bulleted_list_item",
                           "bulleted_list_item": {"rich_text": [_notion_rich_text(stripped[2:])]}})
        elif re.match(r"^\d+\. ", stripped):
            content = re.sub(r"^\d+\. ", "", stripped)
            blocks.append({"object": "block", "type": "numbered_list_item",
                           "numbered_list_item": {"rich_text": [_notion_rich_text(content)]}})
        elif stripped.startswith("|"):
            blocks.append({"object": "block", "type": "paragraph",
                           "paragraph": {"rich_text": [_notion_rich_text(stripped)]}})
        else:
            blocks.append({"object": "block", "type": "paragraph",
                           "paragraph": {"rich_text": [_notion_rich_text(stripped)]}})

    return blocks[:95]  # Notion max children per request


def post_to_notion(md: str, title: str) -> bool:
    if not NOTION_TOKEN or not NOTION_PARENT_PAGE_ID:
        print("[SKIP] Notion: credentials not set", file=sys.stderr)
        return False

    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }
    payload = {
        "parent": {"page_id": NOTION_PARENT_PAGE_ID},
        "properties": {
            "title": {"title": [_notion_rich_text(title)]}
        },
        "children": _parse_markdown_to_blocks(md),
    }

    try:
        r = requests.post(
            "https://api.notion.com/v1/pages",
            headers=headers,
            json=payload,
            timeout=30,
        )
        if r.status_code in (200, 201):
            page_url = r.json().get("url", "")
            print(f"[OK] Notion page created: {page_url}")
            return True
        print(f"[WARN] Notion {r.status_code}: {r.text[:300]}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[ERROR] Notion: {e}", file=sys.stderr)
        return False


# ── Email ─────────────────────────────────────────────────────────────────────

def send_email(subject: str, text: str, html: str) -> bool:
    if not all([GMAIL_USER, GMAIL_APP_PASSWORD, RECIPIENT_EMAIL]):
        print("[SKIP] Email: credentials not set", file=sys.stderr)
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = GMAIL_USER
    msg["To"] = RECIPIENT_EMAIL
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_USER, [RECIPIENT_EMAIL], msg.as_string())
        print(f"[OK] Email sent to {RECIPIENT_EMAIL}")
        return True
    except Exception as e:
        print(f"[ERROR] Email: {e}", file=sys.stderr)
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    scan_time = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"[START] HF Security Scanner — {scan_time}", flush=True)

    state = load_state()
    print(
        f"[STATE] Last run: {state.get('last_run', 'never')} | "
        f"Known repos: {len(state.get('seen', {}))}",
        flush=True,
    )

    print("[SCAN] Fetching HF repositories...", flush=True)
    all_repos = fetch_all_security_repos()
    print(f"[SCAN] {len(all_repos)} unique security repos found", flush=True)

    new_or_changed = filter_new_or_changed(all_repos, state)
    print(f"[SCAN] {len(new_or_changed)} new or changed since last run", flush=True)

    entries = [build_entry(r) for r in new_or_changed]
    digest = generate_digest(entries, scan_time, len(all_repos))
    md = render_markdown(digest)
    html = render_html(md)

    # Always print to stdout (captured in GH Actions logs)
    print("\n" + md + "\n", flush=True)

    # Write artifact
    DIGEST_FILE.write_text(md)

    first_run = state.get("last_run") is None
    has_signal = bool(digest["high_signal"] or digest["watchlist"])
    should_report = has_signal or first_run or FORCE_REPORT

    if should_report:
        hr_count = len(digest["by_risk"]["HIGH"])
        mr_count = len(digest["by_risk"]["MEDIUM"])
        notion_title = f"HF SecIntel — {scan_time}"
        post_to_notion(md, notion_title)

        subject = (
            f"[HF SecIntel] {len(entries)} new findings"
            f" | {hr_count} HIGH · {mr_count} MED"
            f" | {scan_time}"
        )
        send_email(subject, md, html)
    else:
        print("[INFO] No high/medium signal this cycle — skipping Notion/email", flush=True)

    # Update state
    for repo in all_repos:
        state["seen"][repo["_full_id"]] = repo.get("lastModified", "")
    state["last_run"] = scan_time
    save_state(state)

    print(
        f"[DONE] State saved — {len(state['seen'])} repos tracked. "
        f"Next run in ~1 hour.",
        flush=True,
    )


if __name__ == "__main__":
    main()
