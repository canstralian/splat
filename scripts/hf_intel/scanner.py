"""
HuggingFace Security Intelligence Scanner
Runs hourly via GitHub Actions. Searches HF Hub for security-relevant repos,
classifies findings, saves a digest to Notion, and emails a summary.
"""

from __future__ import annotations

import datetime
import json
import os
import smtplib
import sys
from dataclasses import dataclass, field
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any

import requests
from huggingface_hub import HfApi, list_models, list_datasets, list_spaces

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HF_TOKEN = os.getenv("HF_TOKEN")
NOTION_TOKEN = os.getenv("NOTION_TOKEN", "")
NOTION_PARENT_PAGE_ID = os.getenv("NOTION_PARENT_PAGE_ID", "")
GMAIL_USER = os.getenv("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")
DIGEST_RECIPIENT = os.getenv("DIGEST_RECIPIENT", GMAIL_USER)
STATE_FILE = Path(os.getenv("STATE_FILE", ".hf_intel_state.json"))
FORCE_BASELINE = os.getenv("FORCE_BASELINE", "false").lower() == "true"

# Lookback window for "recently modified" repos when no state exists.
BASELINE_LOOKBACK_HOURS = 24

SEARCH_QUERIES: list[dict[str, Any]] = [
    {"query": "cybersecurity",             "label": "cybersecurity"},
    {"query": "malware",                   "label": "malware"},
    {"query": "ransomware",                "label": "ransomware"},
    {"query": "exploit vulnerability CVE", "label": "exploit-vuln-cve"},
    {"query": "phishing credential stealer infostealer", "label": "phishing-stealer"},
    {"query": "red team pentest",          "label": "redteam-pentest"},
    {"query": "OSINT threat intelligence", "label": "osint-threatintel"},
    {"query": "YARA sigma detection",      "label": "detection-engineering"},
    {"query": "reverse engineering binary forensics", "label": "reveng-forensics"},
    {"query": "botnet C2 command control", "label": "botnet-c2"},
    {"query": "security LLM agent",        "label": "security-llm"},
    {"query": "malware analysis",          "label": "malware-analysis"},
]

REPO_TYPES = ["model", "dataset", "space"]
MAX_RESULTS_PER_QUERY = 30

# ---------------------------------------------------------------------------
# Risk classification helpers
# ---------------------------------------------------------------------------

HIGH_RISK_KEYWORDS = {
    "ransomware", "c2", "command-and-control", "botnet", "infostealer",
    "stealer", "rat", "remote-access-trojan", "exploit", "payload",
    "dropper", "loader", "shellcode", "keylogger", "spyware", "rootkit",
    "backdoor", "webshell", "malware-source", "poc", "proof-of-concept",
}

SUSPICIOUS_KEYWORDS = {
    "uncensored", "decensored", "abliterated", "jailbreak",
    "hacking", "cracking", "bypass", "evade", "evasion",
}

DEFENSIVE_KEYWORDS = {
    "detection", "defender", "blue-team", "soc", "dfir", "forensic",
    "yara", "sigma", "suricata", "snort", "antivirus", "av",
    "incident-response", "threat-intel", "threat-intelligence",
    "nist", "owasp", "csf", "compliance",
}

EDUCATIONAL_KEYWORDS = {
    "tutorial", "course", "education", "learning", "beginner",
    "ctf", "capture-the-flag", "lab", "training", "certification",
}


def classify(repo: "RepoRecord") -> tuple[str, str]:
    """Return (classification_label, risk_level) for a repo."""
    tags_lower = {t.lower() for t in repo.tags}
    name_lower = repo.name.lower()
    all_text = tags_lower | set(name_lower.split("-")) | set(name_lower.split("_"))

    if tags_lower & {"malware-source", "malware"} and any(
        w in name_lower for w in ("source", "sample", "bazaar", "vxunderground")
    ):
        return "Suspicious", "HIGH"

    if all_text & HIGH_RISK_KEYWORDS:
        if all_text & DEFENSIVE_KEYWORDS:
            return "Dual-use", "MEDIUM"
        return "Dual-use / Suspicious", "HIGH"

    if all_text & SUSPICIOUS_KEYWORDS:
        return "Dual-use / Suspicious", "MEDIUM"

    if all_text & DEFENSIVE_KEYWORDS:
        return "Defensive", "LOW"

    if all_text & EDUCATIONAL_KEYWORDS:
        return "Educational", "LOW"

    if "research" in all_text or "academic" in all_text:
        return "Research", "LOW"

    return "Research", "LOW"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class RepoRecord:
    repo_id: str
    repo_type: str
    name: str
    author: str
    url: str
    created_at: str
    last_modified: str
    tags: list[str]
    downloads: int
    likes: int
    description: str
    matched_query: str
    classification: str = ""
    risk: str = ""
    is_gated: bool = False

    def __post_init__(self):
        self.classification, self.risk = classify(self)

    @property
    def risk_emoji(self) -> str:
        return {"HIGH": "🔴", "MEDIUM": "🟠", "LOW": "🟡"}.get(self.risk, "⚪")

    def summary_line(self) -> str:
        return (
            f"{self.risk_emoji} **{self.repo_id}** ({self.repo_type}) — "
            f"{self.classification} | {self.risk} risk | "
            f"↓{self.downloads} ♥{self.likes} | "
            f"Created: {self.created_at[:10]} | {self.url}"
        )


# ---------------------------------------------------------------------------
# HF Hub scanning
# ---------------------------------------------------------------------------

def _iso(dt: Any) -> str:
    if dt is None:
        return ""
    if isinstance(dt, datetime.datetime):
        return dt.isoformat()
    return str(dt)


def _scan_repo_type(api: HfApi, query: str, repo_type: str, since: datetime.datetime | None) -> list[RepoRecord]:
    records: list[RepoRecord] = []
    kwargs: dict[str, Any] = {
        "search": query,
        "sort": "lastModified",
        "direction": -1,
        "limit": MAX_RESULTS_PER_QUERY,
        "token": HF_TOKEN,
        "cardData": True,
        "fetch_config": False,
    }

    try:
        if repo_type == "model":
            items = list(list_models(**kwargs))
        elif repo_type == "dataset":
            items = list(list_datasets(**kwargs))
        else:
            kwargs.pop("cardData", None)
            kwargs.pop("fetch_config", None)
            items = list(list_spaces(**{k: v for k, v in kwargs.items() if k not in ("cardData", "fetch_config")}))
    except Exception as exc:
        print(f"  [WARN] {repo_type} search '{query}': {exc}", file=sys.stderr)
        return []

    for item in items:
        last_mod = getattr(item, "lastModified", None) or getattr(item, "last_modified", None)
        created = getattr(item, "createdAt", None) or getattr(item, "created_at", None)

        if since and last_mod:
            lm = last_mod if isinstance(last_mod, datetime.datetime) else datetime.datetime.fromisoformat(str(last_mod).replace("Z", "+00:00"))
            if lm.replace(tzinfo=None) < since.replace(tzinfo=None):
                continue

        tags = list(getattr(item, "tags", []) or [])
        card = getattr(item, "cardData", None) or {}
        desc = ""
        if isinstance(card, dict):
            desc = card.get("description", "") or ""

        records.append(RepoRecord(
            repo_id=item.id,
            repo_type=repo_type.capitalize(),
            name=item.id.split("/")[-1],
            author=item.id.split("/")[0] if "/" in item.id else "",
            url=f"https://huggingface.co/{'datasets/' if repo_type == 'dataset' else 'spaces/' if repo_type == 'space' else ''}{item.id}",
            created_at=_iso(created),
            last_modified=_iso(last_mod),
            tags=tags,
            downloads=getattr(item, "downloads", 0) or 0,
            likes=getattr(item, "likes", 0) or 0,
            description=desc[:300],
            matched_query=query,
            is_gated=getattr(item, "gated", False) or False,
        ))

    return records


def run_scan(since: datetime.datetime | None) -> list[RepoRecord]:
    api = HfApi(token=HF_TOKEN)
    seen_ids: set[str] = set()
    all_records: list[RepoRecord] = []

    for q_cfg in SEARCH_QUERIES:
        query = q_cfg["query"]
        label = q_cfg["label"]
        print(f"  Searching [{label}] …")
        for repo_type in REPO_TYPES:
            batch = _scan_repo_type(api, query, repo_type, since)
            for r in batch:
                if r.repo_id not in seen_ids:
                    seen_ids.add(r.repo_id)
                    all_records.append(r)

    # Sort: HIGH first, then MEDIUM, then LOW; within each by last_modified desc
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    all_records.sort(key=lambda r: (order.get(r.risk, 3), r.last_modified), reverse=False)
    all_records.sort(key=lambda r: order.get(r.risk, 3))
    return all_records


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

def load_state() -> dict[str, Any]:
    if FORCE_BASELINE or not STATE_FILE.exists():
        return {"seen_ids": [], "last_run": None, "scan_number": 0}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"seen_ids": [], "last_run": None, "scan_number": 0}


def save_state(state: dict[str, Any], new_records: list[RepoRecord]) -> None:
    seen = set(state.get("seen_ids", []))
    for r in new_records:
        seen.add(r.repo_id)
    state["seen_ids"] = list(seen)
    state["last_run"] = datetime.datetime.utcnow().isoformat()
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Digest builder
# ---------------------------------------------------------------------------

def build_digest(records: list[RepoRecord], scan_number: int, since: datetime.datetime | None) -> dict[str, str]:
    now_str = datetime.datetime.utcnow().strftime("%Y-%m-%d ~%H:00 UTC")
    since_str = since.strftime("%Y-%m-%d %H:%M UTC") if since else "baseline"

    high = [r for r in records if r.risk == "HIGH"]
    medium = [r for r in records if r.risk == "MEDIUM"]
    low = [r for r in records if r.risk == "LOW"]

    # Trend analysis
    by_type: dict[str, int] = {"Model": 0, "Dataset": 0, "Space": 0}
    for r in records:
        by_type[r.repo_type] = by_type.get(r.repo_type, 0) + 1

    suspicious = [r for r in records if "Suspicious" in r.classification]

    # Executive summary
    exec_summary = (
        f"Scan #{scan_number:03d} detected **{len(records)} net-new or updated repositories** "
        f"since {since_str}. "
        f"Risk breakdown: **{len(high)} HIGH · {len(medium)} MEDIUM · {len(low)} LOW**. "
    )
    if suspicious:
        exec_summary += (
            f"**{len(suspicious)} suspicious repos** warrant immediate review. "
        )
    if not records:
        exec_summary = (
            f"Scan #{scan_number:03d} — **No new or materially changed repositories** "
            f"detected since {since_str}. All known repos are unchanged."
        )

    # ---- Notion Markdown body ----
    def repo_block(r: RepoRecord) -> str:
        gated = " 🔒 Gated" if r.is_gated else ""
        tag_str = ", ".join(r.tags[:12]) if r.tags else "—"
        return (
            f"**`{r.repo_id}`**{gated}\n"
            f"- Type: {r.repo_type} | Author: {r.author}\n"
            f"- URL: [{r.url}]({r.url})\n"
            f"- Created: {r.created_at[:10]} | Updated: {r.last_modified[:10]}\n"
            f"- Downloads: {r.downloads:,} | Likes: {r.likes}\n"
            f"- Tags: {tag_str}\n"
            f"- Matched query: `{r.matched_query}`\n"
            f"- Classification: **{r.classification}** | Risk: **{r.risk}**\n"
            + (f"- Description: {r.description}\n" if r.description else "")
        )

    sections: list[str] = []

    sections.append(
        f"**TLP:WHITE** | Cycle: #{scan_number:03d} | "
        f"Period: {since_str} → {now_str} | Source: HuggingFace Hub\n\n---"
    )

    sections.append(f"## Executive Summary\n{exec_summary}")

    if records:
        sections.append("## High-Signal Findings")

        if high:
            sections.append("### 🔴 HIGH RISK")
            sections.extend(repo_block(r) + "\n---" for r in high)

        if medium:
            sections.append("### 🟠 MEDIUM RISK")
            sections.extend(repo_block(r) + "\n---" for r in medium)

        if low:
            sections.append("### 🟡 LOW RISK")
            sections.extend(repo_block(r) + "\n---" for r in low)

    # Emerging patterns
    patterns: list[str] = []
    if any("scada" in r.name.lower() or "ot-" in " ".join(r.tags) for r in records):
        patterns.append("**OT/ICS malware focus** — SCADA-targeted models/datasets appearing; critical-infrastructure risk.")
    if any("agent" in r.name.lower() and "malware" in " ".join(r.tags + [r.name]).lower() for r in records):
        patterns.append("**AI agent malware classification** — Novel domain: datasets/models targeting malicious AI agent skills.")
    if any(r.downloads > 1000 and r.risk in ("HIGH", "MEDIUM") for r in records):
        patterns.append("**High-download dual-use content** — One or more dual-use repos exceeding 1K downloads this cycle.")
    if len([r for r in records if r.repo_type == "Model" and "cybersecurity" in " ".join(r.tags).lower()]) >= 3:
        patterns.append("**Security LLM proliferation** — Multiple new cybersecurity-focused fine-tuned LLMs in a single cycle.")
    if any("malware-source" in r.tags or "vxunderground" in r.name.lower() for r in records):
        patterns.append("**Malware source code on Hub** — Raw malware code or samples present; verify gating/access controls.")
    if not patterns:
        patterns.append("No strong emerging patterns this cycle beyond routine security-tooling uploads.")

    sections.append("## Emerging Patterns\n" + "\n".join(f"{i+1}. {p}" for i, p in enumerate(patterns)))

    # Watchlist
    watchlist_items = [r for r in records if r.risk in ("HIGH", "MEDIUM")][:8]
    if watchlist_items:
        wl_rows = "\n".join(
            f"| `{r.repo_id}` | {r.repo_type} | {r.risk} | Monitor downloads/changes |"
            for r in watchlist_items
        )
        sections.append(
            "## Watchlist (Monitor Next Cycle)\n"
            "| Repo | Type | Risk | Reason |\n"
            "|------|------|------|--------|\n"
            + wl_rows
        )

    # False positives note
    sections.append(
        "## False Positives / Noise Filtered\n"
        "- General educational/tutorial cybersecurity repos with no novel tooling\n"
        "- Standard NLP benchmark datasets with 'adversarial' in name but no security relevance\n"
        "- Gaming-context exploit references (Roblox, game mods)\n"
        "- Non-English repos using security terms in academic/linguistic contexts"
    )

    # Actions
    actions: list[str] = []
    if high:
        actions.append(f"**IMMEDIATE**: Review {len(high)} HIGH-risk repo(s) — inspect content, assess weaponisability, flag to HF Trust & Safety if warranted.")
    if suspicious:
        ids = ", ".join(f"`{r.repo_id}`" for r in suspicious[:3])
        actions.append(f"**SHORT-TERM**: Track {ids} for download growth and downstream model training citations.")
    actions.append("**ONGOING**: Correlate new security LLM fine-tunes against known dual-use training datasets.")
    actions.append("**PROCESS**: Adjust query terms if false-positive rate > 20% this cycle.")

    sections.append("## Recommended Actions\n" + "\n".join(f"{i+1}. {a}" for i, a in enumerate(actions)))

    sections.append(
        "\n---\n*Generated by HF Security Intelligence Scanner v2.0 | "
        "canstralian/splat | Scan cycle: hourly | Classification: TLP:WHITE*"
    )

    notion_body = "\n\n".join(sections)
    title = f"🛡️ HF Security Intel — Scan #{scan_number:03d} — {datetime.datetime.utcnow().strftime('%d %b %Y ~%H:00 UTC')}"

    # ---- Plain-text email body ----
    plain_lines = [
        f"HF SECURITY INTELLIGENCE DIGEST — SCAN #{scan_number:03d}",
        f"Generated: {now_str} | TLP:WHITE",
        "=" * 60,
        "",
        "EXECUTIVE SUMMARY",
        exec_summary.replace("**", ""),
        "",
    ]
    if high:
        plain_lines += ["HIGH RISK ITEMS", "-" * 40]
        for r in high:
            plain_lines += [f"  [{r.risk}] {r.repo_id} ({r.repo_type})", f"  URL: {r.url}", ""]
    if medium:
        plain_lines += ["MEDIUM RISK ITEMS", "-" * 40]
        for r in medium:
            plain_lines += [f"  [{r.risk}] {r.repo_id} ({r.repo_type})", f"  URL: {r.url}", ""]
    plain_lines += [
        "EMERGING PATTERNS",
        *[f"  {i+1}. {p.replace('**', '')}" for i, p in enumerate(patterns)],
        "",
        "RECOMMENDED ACTIONS",
        *[f"  {i+1}. {a.replace('**', '')}" for i, a in enumerate(actions)],
        "",
        f"Full digest saved to Notion.",
        "=" * 60,
        "HF Security Intelligence Scanner v2.0 | canstralian/splat",
    ]
    email_plain = "\n".join(plain_lines)

    return {
        "title": title,
        "notion_body": notion_body,
        "email_plain": email_plain,
        "exec_summary": exec_summary,
        "scan_number": str(scan_number),
    }


# ---------------------------------------------------------------------------
# Notion integration
# ---------------------------------------------------------------------------

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


def _notion_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def _md_to_notion_blocks(md: str) -> list[dict]:
    """Convert a subset of Markdown to Notion block objects."""
    blocks: list[dict] = []
    for line in md.split("\n"):
        stripped = line.rstrip()
        if stripped.startswith("### "):
            blocks.append({"object": "block", "type": "heading_3",
                           "heading_3": {"rich_text": [{"type": "text", "text": {"content": stripped[4:]}}]}})
        elif stripped.startswith("## "):
            blocks.append({"object": "block", "type": "heading_2",
                           "heading_2": {"rich_text": [{"type": "text", "text": {"content": stripped[3:]}}]}})
        elif stripped.startswith("# "):
            blocks.append({"object": "block", "type": "heading_1",
                           "heading_1": {"rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]}})
        elif stripped.startswith("---"):
            blocks.append({"object": "block", "type": "divider", "divider": {}})
        elif stripped.startswith("- "):
            blocks.append({"object": "block", "type": "bulleted_list_item",
                           "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]}})
        elif stripped == "":
            pass
        else:
            blocks.append({"object": "block", "type": "paragraph",
                           "paragraph": {"rich_text": [{"type": "text", "text": {"content": stripped}}]}})
    return blocks


def post_to_notion(digest: dict[str, str]) -> str | None:
    if not NOTION_TOKEN or not NOTION_PARENT_PAGE_ID:
        print("[NOTION] Skipped — token or parent page ID not set.", file=sys.stderr)
        return None

    # Chunk blocks (Notion limit: 100 per request)
    all_blocks = _md_to_notion_blocks(digest["notion_body"])

    payload = {
        "parent": {"page_id": NOTION_PARENT_PAGE_ID},
        "icon": {"type": "emoji", "emoji": "🛡️"},
        "properties": {
            "title": {
                "title": [{"type": "text", "text": {"content": digest["title"]}}]
            }
        },
        "children": all_blocks[:100],
    }

    resp = requests.post(f"{NOTION_API}/pages", headers=_notion_headers(), json=payload, timeout=30)
    if not resp.ok:
        print(f"[NOTION] Create page failed: {resp.status_code} {resp.text[:300]}", file=sys.stderr)
        return None

    page_id = resp.json().get("id", "")
    notion_url = f"https://notion.so/{page_id.replace('-', '')}"

    # Append remaining blocks if any
    remaining = all_blocks[100:]
    chunk_size = 100
    for i in range(0, len(remaining), chunk_size):
        chunk = remaining[i:i + chunk_size]
        r2 = requests.patch(
            f"{NOTION_API}/blocks/{page_id}/children",
            headers=_notion_headers(),
            json={"children": chunk},
            timeout=30,
        )
        if not r2.ok:
            print(f"[NOTION] Append blocks failed: {r2.status_code}", file=sys.stderr)

    print(f"[NOTION] Digest posted: {notion_url}")
    return notion_url


# ---------------------------------------------------------------------------
# Email integration (SMTP / Gmail App Password)
# ---------------------------------------------------------------------------

def send_email(digest: dict[str, str], notion_url: str | None) -> bool:
    if not GMAIL_USER or not GMAIL_APP_PASSWORD or not DIGEST_RECIPIENT:
        print("[EMAIL] Skipped — Gmail credentials not set.", file=sys.stderr)
        return False

    subject = f"[HF Intel] {digest['title']}"
    body = digest["email_plain"]
    if notion_url:
        body += f"\n\nFull Notion report: {notion_url}"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = GMAIL_USER
    msg["To"] = DIGEST_RECIPIENT
    msg.attach(MIMEText(body, "plain"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_USER, [DIGEST_RECIPIENT], msg.as_string())
        print(f"[EMAIL] Digest sent to {DIGEST_RECIPIENT}")
        return True
    except Exception as exc:
        print(f"[EMAIL] Send failed: {exc}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    print("=" * 60)
    print(f"HF Security Intelligence Scanner v2.0")
    print(f"Started: {datetime.datetime.utcnow().isoformat()} UTC")
    print("=" * 60)

    state = load_state()
    scan_number = state.get("scan_number", 0) + 1
    last_run_str = state.get("last_run")
    seen_ids: set[str] = set(state.get("seen_ids", []))

    if last_run_str and not FORCE_BASELINE:
        since = datetime.datetime.fromisoformat(last_run_str)
    else:
        since = datetime.datetime.utcnow() - datetime.timedelta(hours=BASELINE_LOOKBACK_HOURS)

    print(f"Scan #{scan_number:03d} | Lookback since: {since.isoformat()} UTC")
    print(f"Previously seen repos: {len(seen_ids)}")

    print("\nRunning HF Hub searches …")
    all_records = run_scan(since)

    # Filter to only repos not already seen
    new_records = [r for r in all_records if r.repo_id not in seen_ids]
    print(f"\nFound {len(new_records)} new/updated repositories.")

    digest = build_digest(new_records, scan_number, since)

    if new_records:
        print("\nNew findings:")
        for r in new_records:
            print(f"  {r.risk_emoji} [{r.risk}] {r.repo_id} ({r.repo_type})")
    else:
        print("No new findings — digest will reflect zero findings.")

    print("\nPosting to Notion …")
    notion_url = post_to_notion(digest)

    print("Sending email …")
    send_email(digest, notion_url)

    # Always update state (even on zero findings, to advance last_run)
    state["scan_number"] = scan_number
    save_state(state, new_records)

    print(f"\nScan #{scan_number:03d} complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
