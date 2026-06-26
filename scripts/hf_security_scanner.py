"""
HF Security Intelligence Scanner
Runs hourly via GitHub Actions. Searches Hugging Face for security-domain
repositories, diffs against the previous run, classifies findings, posts
a digest to Notion, and emails a summary.
"""

import json
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import requests
from dateutil import parser as dateutil_parser
from huggingface_hub import HfApi

# ── Configuration ────────────────────────────────────────────────────────────

STATE_FILE = Path(__file__).parent / ".scan_state.json"

SEARCH_TERMS = [
    "cybersecurity",
    "malware",
    "exploit",
    "phishing",
    "ransomware",
    "osint",
    "pentest",
    "stealer",
    "botnet",
    "forensic",
    "vulnerability",
    "yara",
    "sigma",
    "c2",
]

REPO_TYPES = ["model", "dataset", "space"]
RESULTS_PER_TERM = 20

# Tags/keywords that trigger classification upgrades
SUSPICIOUS_SIGNALS = {
    "c2", "stealer", "infostealer", "keylogger", "rats",
    "botnet", "cryptojacking", "backdoor", "rootkit",
    "exploit-kit", "spyware", "ransomware-as-a-service",
}
DEFENSIVE_SIGNALS = {
    "dfir", "incident-response", "detection-engineering",
    "threat-hunting", "siem", "soc", "intrusion-detection",
    "defensive-security", "malware-analysis", "forensic",
    "yara", "sigma", "honeypot", "sandboxing",
}
EDUCATIONAL_SIGNALS = {
    "instruction-tuning", "fine-tuned", "benchmark",
    "ctf", "training-data", "academic",
}
RESEARCH_SIGNALS = {
    "arxiv", "paper", "academic-project", "research",
    "dataset", "benchmark", "analysis",
}


# ── HF Search ────────────────────────────────────────────────────────────────

def search_hf(api: HfApi) -> dict[str, dict]:
    """Search all configured terms and repo types. Returns {repo_id: metadata}."""
    found: dict[str, dict] = {}
    for term in SEARCH_TERMS:
        for rtype in REPO_TYPES:
            try:
                if rtype == "model":
                    results = api.list_models(
                        search=term,
                        limit=RESULTS_PER_TERM,
                        sort="lastModified",
                        direction=-1,
                        full=True,
                        cardData=True,
                    )
                elif rtype == "dataset":
                    results = api.list_datasets(
                        search=term,
                        limit=RESULTS_PER_TERM,
                        sort="lastModified",
                        direction=-1,
                        full=True,
                        cardData=True,
                    )
                else:
                    results = api.list_spaces(
                        search=term,
                        limit=RESULTS_PER_TERM,
                        sort="lastModified",
                        direction=-1,
                        full=True,
                        cardData=True,
                    )

                for repo in results:
                    repo_id = repo.id
                    key = f"{rtype}/{repo_id}"
                    if key in found:
                        found[key]["matched_terms"].add(term)
                        continue

                    tags = list(getattr(repo, "tags", []) or [])
                    found[key] = {
                        "id": repo_id,
                        "type": rtype,
                        "author": repo.author or repo_id.split("/")[0],
                        "url": f"https://hf.co{'/' if not repo_id.startswith('/') else ''}"
                               + (f"{'datasets/' if rtype == 'dataset' else 'spaces/' if rtype == 'space' else ''}{repo_id}"),
                        "created_at": str(getattr(repo, "created_at", "") or ""),
                        "last_modified": str(getattr(repo, "last_modified", "") or ""),
                        "downloads": getattr(repo, "downloads", 0) or 0,
                        "likes": getattr(repo, "likes", 0) or 0,
                        "tags": tags,
                        "matched_terms": {term},
                        "gated": bool(getattr(repo, "gated", False)),
                    }
            except Exception as exc:
                print(f"[WARN] search({term}, {rtype}): {exc}", file=sys.stderr)

    # Convert sets to lists for JSON serialisation
    for meta in found.values():
        meta["matched_terms"] = sorted(meta["matched_terms"])

    return found


# ── State management ──────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"seen": {}, "run_count": 0, "last_run": ""}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── Classification ────────────────────────────────────────────────────────────

def classify(repo: dict) -> tuple[str, str]:
    """Returns (classification_label, risk_level)."""
    import re
    tag_set = {t.lower() for t in repo["tags"]}
    tag_set.update(t.lower() for t in repo["matched_terms"])
    name_lower = repo["id"].lower()

    suspicious = bool(
        tag_set & SUSPICIOUS_SIGNALS or
        any(re.search(rf"\b{re.escape(s)}\b", name_lower) for s in SUSPICIOUS_SIGNALS)
    )
    defensive = bool(tag_set & DEFENSIVE_SIGNALS)
    educational = bool(tag_set & EDUCATIONAL_SIGNALS)
    research = bool(tag_set & RESEARCH_SIGNALS)

    if repo["gated"] and not defensive and not educational:
        label = "Suspicious"
        risk = "HIGH" if suspicious else "MEDIUM"
    elif suspicious:
        label = "Suspicious" if not defensive else "Dual-use"
        risk = "HIGH"
    elif defensive:
        label = "Defensive"
        risk = "LOW"
    elif educational:
        label = "Educational"
        risk = "LOW"
    elif research:
        label = "Research"
        risk = "LOW-MEDIUM"
    else:
        label = "Dual-use"
        risk = "MEDIUM"

    # Elevate risk for large download counts on malware/exploit repos
    if repo["downloads"] > 2000 and label in ("Suspicious", "Dual-use"):
        risk = "HIGH"

    return label, risk


# ── Diff ──────────────────────────────────────────────────────────────────────

def compute_diff(current: dict, seen: dict) -> tuple[list, list]:
    """Returns (new_repos, updated_repos) as lists of metadata dicts."""
    new_repos, updated_repos = [], []
    for repo_id, meta in current.items():
        if repo_id not in seen:
            new_repos.append(meta)
        else:
            prev = seen[repo_id]
            if meta["last_modified"] != prev.get("last_modified", ""):
                updated_repos.append(meta)
    return new_repos, updated_repos


# ── Digest builder ────────────────────────────────────────────────────────────

def build_digest(new_repos: list, updated_repos: list, run_num: int) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    classified_new = [(r, *classify(r)) for r in new_repos]
    classified_upd = [(r, *classify(r)) for r in updated_repos]

    high_signal = [
        (r, lbl, risk) for r, lbl, risk in (classified_new + classified_upd)
        if risk in ("HIGH", "MEDIUM-HIGH")
    ]
    watchlist = [
        (r, lbl, risk) for r, lbl, risk in (classified_new + classified_upd)
        if risk in ("HIGH", "MEDIUM-HIGH", "MEDIUM")
    ]

    return {
        "title": f"HF Security Intelligence Digest — {date_str} (Run #{run_num:03d})",
        "scan_time": now,
        "run_number": run_num,
        "total_new": len(new_repos),
        "total_updated": len(updated_repos),
        "high_signal": high_signal,
        "watchlist": watchlist,
        "classified_new": classified_new,
        "classified_upd": classified_upd,
    }


# ── Notion ────────────────────────────────────────────────────────────────────

NOTION_VERSION = "2022-06-28"


def _notion_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
    }


def _risk_emoji(risk: str) -> str:
    return {"HIGH": "🔴", "MEDIUM-HIGH": "🟠", "MEDIUM": "🟡",
            "LOW-MEDIUM": "🔵", "LOW": "🟢"}.get(risk, "⚪")


def _repo_row(r: dict, lbl: str, risk: str) -> str:
    return (
        f"| [{r['id']}]({r['url']}) | {r['type'].capitalize()} "
        f"| {r['author']} | {r['last_modified'][:10]} "
        f"| {lbl} | {_risk_emoji(risk)} {risk} |"
    )


def build_notion_content(d: dict) -> str:
    lines = [
        f"**Scan Time:** {d['scan_time']}  |  "
        f"**New repos:** {d['total_new']}  |  "
        f"**Updated:** {d['total_updated']}\n",
        "---\n",
        "## Executive Summary\n",
    ]

    if not d["total_new"] and not d["total_updated"]:
        lines.append("No new or materially changed repositories since the previous scan.\n")
    else:
        lines.append(
            f"Detected **{d['total_new']} new** and **{d['total_updated']} updated** "
            "security-domain repositories on Hugging Face.\n"
        )

    if d["high_signal"]:
        lines += [
            "\n## High-Signal Findings\n",
            "| Repository | Type | Author | Modified | Classification | Risk |\n",
            "|---|---|---|---|---|---|\n",
        ]
        for r, lbl, risk in sorted(d["high_signal"], key=lambda x: x[2], reverse=True):
            lines.append(_repo_row(r, lbl, risk) + "\n")

    if d["watchlist"]:
        lines += [
            "\n## Watchlist\n",
            "| Repository | Type | Author | Modified | Classification | Risk |\n",
            "|---|---|---|---|---|---|\n",
        ]
        for r, lbl, risk in sorted(d["watchlist"], key=lambda x: x[2], reverse=True):
            lines.append(_repo_row(r, lbl, risk) + "\n")

    if d["classified_new"]:
        lines += [
            "\n## All New Repositories\n",
            "| Repository | Type | Classification | Risk | Downloads | Tags |\n",
            "|---|---|---|---|---|---|\n",
        ]
        for r, lbl, risk in sorted(d["classified_new"],
                                   key=lambda x: x[2], reverse=True):
            tag_str = ", ".join(r["tags"][:5])
            lines.append(
                f"| [{r['id']}]({r['url']}) | {r['type'].capitalize()} "
                f"| {lbl} | {_risk_emoji(risk)} {risk} "
                f"| {r['downloads']:,} | {tag_str} |\n"
            )

    if d["classified_upd"]:
        lines += [
            "\n## Updated Repositories\n",
            "| Repository | Type | Classification | Risk | Downloads |\n",
            "|---|---|---|---|---|\n",
        ]
        for r, lbl, risk in sorted(d["classified_upd"],
                                   key=lambda x: x[2], reverse=True):
            lines.append(
                f"| [{r['id']}]({r['url']}) | {r['type'].capitalize()} "
                f"| {lbl} | {_risk_emoji(risk)} {risk} | {r['downloads']:,} |\n"
            )

    lines += [
        "\n---\n",
        f"*Automated scan — queries: {', '.join(SEARCH_TERMS[:8])} …*\n",
    ]
    return "".join(lines)


def post_to_notion(digest: dict, api_key: str, parent_page_id: str) -> str | None:
    content = build_notion_content(digest)
    payload = {
        "parent": {"type": "page_id", "page_id": parent_page_id},
        "properties": {
            "title": [{"type": "text", "text": {"content": digest["title"]}}]
        },
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": content[:2000]}}]
                },
            }
        ],
    }
    resp = requests.post(
        "https://api.notion.com/v1/pages",
        headers=_notion_headers(api_key),
        json=payload,
        timeout=30,
    )
    if resp.ok:
        return resp.json().get("url")
    print(f"[WARN] Notion API error {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
    return None


# ── Email ─────────────────────────────────────────────────────────────────────

def _risk_badge(risk: str) -> str:
    colours = {
        "HIGH": "#d73a49",
        "MEDIUM-HIGH": "#e36209",
        "MEDIUM": "#e3a008",
        "LOW-MEDIUM": "#0366d6",
        "LOW": "#28a745",
    }
    c = colours.get(risk, "#586069")
    return (
        f'<span style="background:{c}20;color:{c};border:1px solid {c};'
        f'border-radius:4px;padding:2px 6px;font-size:11px;font-weight:bold">'
        f"{risk}</span>"
    )


def build_email_html(digest: dict, notion_url: str | None) -> str:
    rows = ""
    for r, lbl, risk in sorted(
        digest["high_signal"] or digest["watchlist"],
        key=lambda x: x[2], reverse=True
    )[:15]:
        rows += (
            f"<tr><td><a href='{r['url']}'>{r['id']}</a></td>"
            f"<td>{r['type'].capitalize()}</td>"
            f"<td>{lbl}</td>"
            f"<td>{_risk_badge(risk)}</td>"
            f"<td>{r['downloads']:,}</td></tr>"
        )

    notion_link = f"<p><a href='{notion_url}'>View full digest in Notion →</a></p>" if notion_url else ""

    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body{{font-family:Arial,sans-serif;max-width:750px;margin:0 auto;padding:20px;color:#1a1a1a;background:#f4f4f4}}
.hdr{{background:#0d1117;color:#fff;padding:20px;border-radius:8px;margin-bottom:16px}}
.hdr h1{{margin:0;font-size:18px;color:#58a6ff}}
.hdr p{{margin:4px 0 0;color:#8b949e;font-size:12px}}
.sec{{background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:18px;margin-bottom:14px}}
.sec h2{{margin:0 0 10px;font-size:14px;border-bottom:1px solid #e1e4e8;padding-bottom:6px}}
table{{width:100%;border-collapse:collapse;font-size:12px}}
th{{background:#f6f8fa;text-align:left;padding:7px;border-bottom:2px solid #e1e4e8}}
td{{padding:6px 7px;border-bottom:1px solid #f0f0f0;vertical-align:top}}
a{{color:#0366d6;text-decoration:none}}
.stat{{display:inline-block;background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:10px 16px;margin:4px;text-align:center}}
.stat .n{{font-size:22px;font-weight:bold;color:#0d1117}}
.stat .l{{font-size:11px;color:#586069}}
</style></head><body>
<div class="hdr">
  <h1>🛡️ HF Security Intelligence Digest — Run #{digest['run_number']:03d}</h1>
  <p>Scan: {digest['scan_time']} &nbsp;|&nbsp; Queries: {len(SEARCH_TERMS)} terms × 3 repo types</p>
</div>

<div class="sec">
  <h2>📊 This Run</h2>
  <div class="stat"><div class="n">{digest['total_new']}</div><div class="l">New Repos</div></div>
  <div class="stat"><div class="n">{digest['total_updated']}</div><div class="l">Updated Repos</div></div>
  <div class="stat"><div class="n">{len(digest['high_signal'])}</div><div class="l">High Signal</div></div>
  <div class="stat"><div class="n">{len(digest['watchlist'])}</div><div class="l">Watchlist Items</div></div>
</div>

<div class="sec">
  <h2>🔍 High-Signal / Watchlist Findings</h2>
  {'<p style="color:#586069;font-size:13px">No high-signal findings this run.</p>' if not (digest["high_signal"] or digest["watchlist"]) else f"""
  <table>
    <tr><th>Repository</th><th>Type</th><th>Class.</th><th>Risk</th><th>DLs</th></tr>
    {rows}
  </table>"""}
  {notion_link}
</div>

<div class="sec" style="font-size:12px;color:#586069">
  <p>Automated scan via GitHub Actions (canstralian/splat). Next run in ~1 hour.</p>
  <p>To unsubscribe or adjust alert thresholds, modify <code>scripts/hf_security_scanner.py</code>.</p>
</div>
</body></html>"""


def send_email(digest: dict, notion_url: str | None) -> None:
    sender = os.environ.get("GMAIL_SENDER", "")
    password = os.environ.get("GMAIL_APP_PASSWORD", "")
    recipient = os.environ.get("DIGEST_RECIPIENT", sender)

    if not sender or not password:
        print("[INFO] GMAIL_SENDER/GMAIL_APP_PASSWORD not set — skipping email.", file=sys.stderr)
        return

    subject = (
        f"🛡️ HF Security Digest #{digest['run_number']:03d} — "
        f"{digest['total_new']} new, {len(digest['high_signal'])} high-signal"
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient

    plain = (
        f"HF Security Intelligence Digest — Run #{digest['run_number']:03d}\n"
        f"Scan: {digest['scan_time']}\n\n"
        f"New repos: {digest['total_new']}\n"
        f"Updated repos: {digest['total_updated']}\n"
        f"High-signal findings: {len(digest['high_signal'])}\n\n"
        + (f"Notion: {notion_url}\n" if notion_url else "")
    )
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(build_email_html(digest, notion_url), "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(sender, password)
            smtp.sendmail(sender, recipient, msg.as_string())
        print("[INFO] Email sent.")
    except Exception as exc:
        print(f"[WARN] Email failed: {exc}", file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    hf_token = os.environ.get("HF_TOKEN")
    notion_key = os.environ.get("NOTION_API_KEY")
    notion_parent = os.environ.get("NOTION_PARENT_PAGE_ID")

    api = HfApi(token=hf_token)

    print("[INFO] Starting HF security scan …")
    current = search_hf(api)
    print(f"[INFO] Found {len(current)} total repos across all queries.")

    state = load_state()
    run_num = state["run_count"] + 1
    seen = state["seen"]

    new_repos, updated_repos = compute_diff(current, seen)
    print(f"[INFO] New: {len(new_repos)}, Updated: {len(updated_repos)}")

    digest = build_digest(new_repos, updated_repos, run_num)

    notion_url = None
    if notion_key and notion_parent and (new_repos or updated_repos):
        print("[INFO] Posting to Notion …")
        notion_url = post_to_notion(digest, notion_key, notion_parent)
        if notion_url:
            print(f"[INFO] Notion page: {notion_url}")
    elif not (new_repos or updated_repos):
        print("[INFO] No changes — skipping Notion and email.")

    if new_repos or updated_repos:
        send_email(digest, notion_url)

    # Persist state
    state["seen"] = {**seen, **current}
    state["run_count"] = run_num
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    print(f"[INFO] Run #{run_num} complete. State saved.")


if __name__ == "__main__":
    main()
