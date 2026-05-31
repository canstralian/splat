"""
Hugging Face Security Intelligence Scanner
Runs on a schedule, classifies new/updated security-relevant HF repos,
saves a digest to Notion, and emails a summary via Gmail SMTP.

Required environment variables:
  HF_TOKEN         — HuggingFace API token (for authenticated search)
  NOTION_TOKEN     — Notion integration token
  NOTION_PARENT_PAGE_ID — Notion page ID where digests are created
  GMAIL_USER       — Gmail address (sender)
  GMAIL_APP_PASS   — Gmail App Password (16-char, no spaces)
  DIGEST_EMAIL     — Recipient email address

Optional:
  SCAN_LOOKBACK_HOURS — Hours of history to consider (default: 1)
  STATE_FILE          — Path to JSON file tracking last-seen repo timestamps
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

import requests

# ── Config ────────────────────────────────────────────────────────────────────
HF_TOKEN          = os.environ.get("HF_TOKEN", "")
NOTION_TOKEN      = os.environ.get("NOTION_TOKEN", "")
NOTION_PARENT     = os.environ.get("NOTION_PARENT_PAGE_ID", "")
GMAIL_USER        = os.environ.get("GMAIL_USER", "")
GMAIL_PASS        = os.environ.get("GMAIL_APP_PASS", "")
DIGEST_EMAIL      = os.environ.get("DIGEST_EMAIL", "dejager.sa@gmail.com")
LOOKBACK_HOURS    = int(os.environ.get("SCAN_LOOKBACK_HOURS", "1"))
STATE_FILE        = Path(os.environ.get("STATE_FILE", "/tmp/hf_scan_state.json"))

QUERIES = [
    "malware", "cybersecurity", "exploit", "phishing",
    "osint", "ransomware", "infostealer", "botnet",
    "red-team", "vulnerability",
]
REPO_TYPES = ["model", "dataset", "space"]
SORT       = "lastModified"
LIMIT      = 25

RISK_KEYWORDS = {
    "HIGH": [
        "source code", "malware source", "malware sample", "cape sandbox",
        "payload", "c2", "command and control", "stealer", "backdoor",
        "keylogger", "exploit kit", "phishing kit",
    ],
    "MEDIUM": [
        "exploit", "red-team", "pentest", "offensive", "zero-day",
        "credential", "botnet", "infostealer",
    ],
}

DEFENSIVE_KEYWORDS = [
    "detection", "defender", "defense", "blue-team", "soc", "dfir",
    "incident-response", "threat-hunting", "yara", "sigma", "firewall",
    "ids", "ips", "edr", "siem", "forensic",
]

NOISE_PATTERNS = [
    r"\broblox\b", r"\bgaming\b", r"\bexploit[eé]es?\b",  # French "exploitées"
    r"\bpoker\b", r"\breinforcement.learning\b", r"\bmulti.armed.bandit\b",
]


# ── HuggingFace helpers ────────────────────────────────────────────────────────

def hf_search(query: str, repo_type: str) -> list[dict]:
    """Call HuggingFace Hub search API."""
    headers = {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}
    endpoint = {
        "model":   "https://huggingface.co/api/models",
        "dataset": "https://huggingface.co/api/datasets",
        "space":   "https://huggingface.co/api/spaces",
    }[repo_type]
    params = {"search": query, "sort": SORT, "limit": LIMIT, "full": "true"}
    try:
        r = requests.get(endpoint, headers=headers, params=params, timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[WARN] HF search failed ({query}/{repo_type}): {e}", file=sys.stderr)
        return []


def is_noise(repo: dict) -> bool:
    text = " ".join([
        repo.get("id", ""), repo.get("modelId", ""),
        " ".join(repo.get("tags", [])),
    ]).lower()
    return any(re.search(p, text, re.I) for p in NOISE_PATTERNS)


def classify(repo: dict) -> tuple[str, str]:
    """Return (category, risk_level)."""
    text = " ".join([
        repo.get("id", ""), repo.get("modelId", ""),
        repo.get("description", ""),
        " ".join(repo.get("tags", [])),
    ]).lower()

    for level, kws in RISK_KEYWORDS.items():
        if any(kw in text for kw in kws):
            return "Suspicious", level

    if any(kw in text for kw in DEFENSIVE_KEYWORDS):
        return "Defensive", "LOW"

    if any(k in text for k in ["research", "academic", "paper", "arxiv", "benchmark"]):
        return "Research", "LOW"

    if any(k in text for k in ["education", "learn", "tutorial", "course"]):
        return "Educational", "LOW"

    return "Dual-use", "MEDIUM"


# ── State tracking ─────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"seen": {}}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def is_new(repo: dict, state: dict, cutoff: datetime) -> bool:
    rid = repo.get("id") or repo.get("modelId", "")
    last_modified = repo.get("lastModified") or repo.get("updatedAt", "")
    if not last_modified:
        return False
    try:
        ts = datetime.fromisoformat(last_modified.rstrip("Z")).replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    seen_ts = state["seen"].get(rid)
    if seen_ts:
        try:
            prev = datetime.fromisoformat(seen_ts).replace(tzinfo=timezone.utc)
            if ts <= prev:
                return False
        except ValueError:
            pass
    return ts >= cutoff


# ── Scan ───────────────────────────────────────────────────────────────────────

def run_scan() -> list[dict]:
    state   = load_state()
    cutoff  = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    seen    = state.setdefault("seen", {})
    results = []
    processed: set[str] = set()

    for query in QUERIES:
        for repo_type in REPO_TYPES:
            for repo in hf_search(query, repo_type):
                rid = repo.get("id") or repo.get("modelId", "")
                if not rid or rid in processed:
                    continue
                if is_noise(repo):
                    continue
                if not is_new(repo, state, cutoff):
                    continue
                processed.add(rid)

                category, risk = classify(repo)
                author = repo.get("author") or rid.split("/")[0]
                lm = repo.get("lastModified") or repo.get("updatedAt", "")
                url_base = {
                    "model":   "https://hf.co/",
                    "dataset": "https://hf.co/datasets/",
                    "space":   "https://hf.co/spaces/",
                }[repo_type]

                results.append({
                    "id":         rid,
                    "type":       repo_type.capitalize(),
                    "url":        url_base + rid,
                    "author":     author,
                    "updated":    lm,
                    "tags":       repo.get("tags", [])[:8],
                    "downloads":  repo.get("downloads", 0),
                    "likes":      repo.get("likes", 0),
                    "category":   category,
                    "risk":       risk,
                    "query":      query,
                })
                seen[rid] = lm

    save_state(state)
    results.sort(key=lambda r: ({"HIGH": 0, "MEDIUM": 1, "LOW": 2}.get(r["risk"], 3),
                                 r.get("downloads", 0) * -1))
    return results


# ── Digest formatting ──────────────────────────────────────────────────────────

def build_digest(findings: list[dict], run_ts: datetime) -> tuple[str, str]:
    date_str  = run_ts.strftime("%Y-%m-%d %H:%M UTC")
    high      = [f for f in findings if f["risk"] == "HIGH"]
    medium    = [f for f in findings if f["risk"] == "MEDIUM"]
    defensive = [f for f in findings if f["category"] == "Defensive"]
    n         = len(findings)

    def repo_block(f: str) -> str:
        r = f
        tags = ", ".join(r["tags"][:5]) if r["tags"] else "—"
        return (
            f"- **{r['id']}** ({r['type']}) — {r['category']} | Risk: {r['risk']}\n"
            f"  Author: {r['author']} | Updated: {r['updated'][:10]} | "
            f"Downloads: {r.get('downloads',0)} | Tags: {tags}\n"
            f"  URL: {r['url']}\n"
        )

    md = f"""# HF Security Intelligence Digest — {date_str}

> **Classification:** TLP:WHITE | **Scan window:** last {LOOKBACK_HOURS}h | **New findings:** {n}
> Queries: {", ".join(QUERIES)}

---

## Executive Summary

**{n} new or materially updated repositories** identified in the past {LOOKBACK_HOURS} hour(s).
{len(high)} HIGH-risk · {len(medium)} MEDIUM (dual-use) · {len(defensive)} Defensive.

---

## High-Signal Findings

### 🔴 Suspicious / High-Risk ({len(high)})
{"".join(repo_block(f) for f in high) or "_None this cycle._"}

### 🟡 Dual-Use / Medium ({len(medium)})
{"".join(repo_block(f) for f in medium) or "_None this cycle._"}

### 🟢 Notable Defensive ({len(defensive)})
{"".join(repo_block(f) for f in defensive[:5]) or "_None this cycle._"}

---

## All New Findings ({n})

{"".join(repo_block(f) for f in findings) or "_No new findings this cycle._"}

---

## Recommended Follow-Up Actions

{"- Investigate: " + ", ".join(f["id"] for f in high) if high else "- No immediate action required this cycle."}
- Continue monitoring: exploitintel, exploitbench, PatoFlamejanteTV, jescy525
- Next scan: {(run_ts + timedelta(hours=LOOKBACK_HOURS)).strftime("%Y-%m-%d %H:%M UTC")}
"""

    subject = f"[HF Security Intel] {date_str} | {n} new findings"
    return md, subject


def build_html(findings: list[dict], run_ts: datetime) -> str:
    date_str = run_ts.strftime("%Y-%m-%d %H:%M UTC")
    high     = [f for f in findings if f["risk"] == "HIGH"]
    n        = len(findings)

    rows = ""
    risk_colors = {"HIGH": "#f85149", "MEDIUM": "#d1922b", "LOW": "#3fb950"}
    for f in findings[:30]:
        color = risk_colors.get(f["risk"], "#8b949e")
        rows += (
            f'<tr><td style="padding:6px;border:1px solid #30363d;color:#58a6ff;">'
            f'<a href="{f["url"]}" style="color:#58a6ff;">{f["id"]}</a></td>'
            f'<td style="padding:6px;border:1px solid #30363d;color:#c9d1d9;">{f["type"]}</td>'
            f'<td style="padding:6px;border:1px solid #30363d;">'
            f'<span style="background:{color};color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;">'
            f'{f["risk"]}</span></td>'
            f'<td style="padding:6px;border:1px solid #30363d;color:#c9d1d9;">{f["category"]}</td>'
            f'<td style="padding:6px;border:1px solid #30363d;color:#8b949e;">{f["updated"][:10]}</td>'
            f'<td style="padding:6px;border:1px solid #30363d;color:#c9d1d9;">{f.get("downloads",0)}</td>'
            f'</tr>'
        )

    actions = "<br>".join(f"• Investigate: <a href='{f['url']}' style='color:#58a6ff;'>{f['id']}</a>" for f in high) or "No immediate action required this cycle."

    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:'Courier New',monospace;background:#0d1117;color:#c9d1d9;padding:20px;max-width:900px;margin:0 auto;">
<div style="border:1px solid #30363d;border-radius:8px;padding:20px;background:#161b22;">
  <div style="border-left:4px solid #58a6ff;padding-left:16px;margin-bottom:20px;">
    <h1 style="color:#58a6ff;font-size:18px;margin:0 0 4px 0;">🛡️ HF SECURITY INTELLIGENCE DIGEST</h1>
    <div style="color:#8b949e;font-size:13px;">{date_str} · {n} new findings · TLP:WHITE</div>
  </div>
  <div style="background:#21262d;border-radius:6px;padding:14px;margin-bottom:20px;">
    <strong style="color:#f0f6fc;">Summary:</strong>
    <span style="color:#c9d1d9;"> {n} new/updated security repos · {len(high)} HIGH-risk · Lookback: {LOOKBACK_HOURS}h</span>
  </div>
  {"<div style='background:#1c1117;border:1px solid #f85149;border-radius:6px;padding:12px;margin-bottom:16px;'><strong style='color:#f85149;'>⚠ HIGH-RISK ITEMS</strong><br>" + actions + "</div>" if high else ""}
  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;">
    <tr style="background:#21262d;">
      <th style="padding:8px;border:1px solid #30363d;color:#f0f6fc;text-align:left;">Repository</th>
      <th style="padding:8px;border:1px solid #30363d;color:#f0f6fc;text-align:left;">Type</th>
      <th style="padding:8px;border:1px solid #30363d;color:#f0f6fc;text-align:left;">Risk</th>
      <th style="padding:8px;border:1px solid #30363d;color:#f0f6fc;text-align:left;">Category</th>
      <th style="padding:8px;border:1px solid #30363d;color:#f0f6fc;text-align:left;">Updated</th>
      <th style="padding:8px;border:1px solid #30363d;color:#f0f6fc;text-align:left;">DLs</th>
    </tr>
    {rows or '<tr><td colspan="6" style="padding:12px;text-align:center;color:#8b949e;">No new findings this cycle.</td></tr>'}
  </table>
  <div style="border-top:1px solid #30363d;padding-top:10px;font-size:11px;color:#8b949e;">
    Queries: {" · ".join(QUERIES)} · Next: {(run_ts + timedelta(hours=LOOKBACK_HOURS)).strftime("%H:%M UTC")}
  </div>
</div></body></html>"""


# ── Notion output ──────────────────────────────────────────────────────────────

def post_to_notion(title: str, markdown_body: str) -> None:
    if not NOTION_TOKEN or not NOTION_PARENT:
        print("[WARN] Notion credentials not set — skipping Notion upload", file=sys.stderr)
        return

    blocks: list[dict] = []
    for line in markdown_body.split("\n"):
        if line.startswith("# "):
            blocks.append({"object":"block","type":"heading_1",
                           "heading_1":{"rich_text":[{"type":"text","text":{"content":line[2:]}}]}})
        elif line.startswith("## "):
            blocks.append({"object":"block","type":"heading_2",
                           "heading_2":{"rich_text":[{"type":"text","text":{"content":line[3:]}}]}})
        elif line.startswith("### "):
            blocks.append({"object":"block","type":"heading_3",
                           "heading_3":{"rich_text":[{"type":"text","text":{"content":line[4:]}}]}})
        elif line.startswith("- "):
            blocks.append({"object":"block","type":"bulleted_list_item",
                           "bulleted_list_item":{"rich_text":[{"type":"text","text":{"content":line[2:]}}]}})
        elif line.strip():
            blocks.append({"object":"block","type":"paragraph",
                           "paragraph":{"rich_text":[{"type":"text","text":{"content":line}}]}})
        if len(blocks) >= 90:
            break

    payload = {
        "parent":     {"type":"page_id","page_id":NOTION_PARENT},
        "properties": {"title":{"title":[{"type":"text","text":{"content":title}}]}},
        "children":   blocks,
    }
    try:
        r = requests.post(
            "https://api.notion.com/v1/pages",
            headers={"Authorization":f"Bearer {NOTION_TOKEN}",
                     "Notion-Version":"2022-06-28",
                     "Content-Type":"application/json"},
            json=payload, timeout=20,
        )
        r.raise_for_status()
        print(f"[OK] Notion page created: {r.json().get('url','')}")
    except Exception as e:
        print(f"[ERR] Notion: {e}", file=sys.stderr)


# ── Gmail SMTP output ──────────────────────────────────────────────────────────

def send_email(subject: str, html_body: str, text_body: str) -> None:
    if not GMAIL_USER or not GMAIL_PASS:
        print("[WARN] Gmail credentials not set — skipping email", file=sys.stderr)
        return
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = GMAIL_USER
    msg["To"]      = DIGEST_EMAIL
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(GMAIL_USER, GMAIL_PASS)
            smtp.sendmail(GMAIL_USER, DIGEST_EMAIL, msg.as_string())
        print(f"[OK] Email sent to {DIGEST_EMAIL}")
    except Exception as e:
        print(f"[ERR] Gmail: {e}", file=sys.stderr)


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    run_ts = datetime.now(timezone.utc)
    print(f"[{run_ts.strftime('%Y-%m-%d %H:%M UTC')}] Starting HF security scan...")

    findings = run_scan()
    print(f"[INFO] {len(findings)} new/updated security repos found")

    if not findings:
        print("[INFO] No new findings — skipping Notion/email output")
        return

    md_body, subject = build_digest(findings, run_ts)
    html_body        = build_html(findings, run_ts)
    title            = f"HF Security Intel — {run_ts.strftime('%Y-%m-%d %H:%M UTC')}"

    post_to_notion(title, md_body)
    send_email(subject, html_body, md_body)
    print("[DONE] Digest complete.")


if __name__ == "__main__":
    main()
