#!/usr/bin/env python3
"""
Hugging Face Security Intelligence Scanner
Hourly digest: scans HF for new/updated security repos, classifies them,
saves to Notion, emails summary.

Required env vars (set as GitHub Actions secrets):
  NOTION_TOKEN         Notion integration token (secret_...)
  GMAIL_USER           Gmail sender address
  GMAIL_APP_PASSWORD   Gmail 16-char app password
  RECIPIENT_EMAIL      Digest recipient (optional, defaults below)
  HF_TOKEN             HF token for authenticated searches (optional but recommended)
"""

import os
import smtplib
import sys
import json
import requests
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

try:
    from huggingface_hub import HfApi
except ImportError:
    print("ERROR: huggingface_hub not installed. Run: pip install huggingface_hub")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────

NOTION_TOKEN   = os.environ.get("NOTION_TOKEN", "")
GMAIL_USER     = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")
RECIPIENT      = os.environ.get("RECIPIENT_EMAIL", "dejager.sa@gmail.com")
HF_TOKEN       = os.environ.get("HF_TOKEN", None)

LOOKBACK_MINUTES = int(os.environ.get("LOOKBACK_MINUTES", "65"))  # 5-min buffer for clock skew

SECURITY_QUERIES = [
    "cybersecurity", "malware", "exploit", "phishing",
    "vulnerability", "ransomware", "OSINT", "red team pentest",
    "threat intelligence", "CVE", "reverse engineering",
    "YARA SIGMA", "botnet stealer infostealer",
    "detection engineering", "c2 command control",
]

# Risk scoring: highest match wins
RISK_KEYWORDS = {
    "CRITICAL": ["c2", "zero-click", "exploit-deploy", "command-control", "botnet-c2"],
    "HIGH":     ["heretic", "abliterat", "uncensor", "malwaresource", "vxunderground",
                 "exploit-db-ex", "ransomware-kit", "stealer", "rat ", " rat-"],
    "MEDIUM":   ["red-team", "redteam", "pentest", "offensive-security", "infostealer",
                 "phishing", "exploit", "botnet", "ransomware", "malware"],
    "LOW":      ["detection", "defensive", "soc", "dfir", "blue-team",
                 "incident-response", "threat-hunting", "sigma", "yara",
                 "vulnerability-scanner", "cve-classifier"],
}

CLASS_KEYWORDS = {
    "suspicious":  ["heretic", "abliterat", "uncensor", "c2", "exploit-deploy",
                    "malwaresource", "zero-click", "payload-builder"],
    "dual-use":    ["red-team", "redteam", "pentest", "offensive-security",
                    "infostealer", "stealer", "exploit", "c2-framework"],
    "defensive":   ["detection", "defensive", "soc", "dfir", "blue-team",
                    "incident-response", "threat-hunting", "sigma", "yara"],
    "research":    ["dataset", "benchmark", "analysis", "research", "academic", "arxiv"],
    "educational": ["tutorial", "course", "awareness", "ctf", "training"],
}

# ── Classification helpers ────────────────────────────────────────────────────

def classify(tags: list, name: str) -> str:
    combined = " ".join(list(tags) + [name]).lower()
    for cat, kws in CLASS_KEYWORDS.items():
        if any(k in combined for k in kws):
            return cat
    return "educational"


def risk_level(tags: list, name: str) -> str:
    combined = " ".join(list(tags) + [name]).lower()
    for level, kws in RISK_KEYWORDS.items():
        if any(k in combined for k in kws):
            return level
    return "LOW"


# ── HF Scanner ────────────────────────────────────────────────────────────────

def scan_hf(cutoff: datetime) -> list[dict]:
    api = HfApi(token=HF_TOKEN)
    findings: list[dict] = []
    seen: set[str] = set()

    for query in SECURITY_QUERIES:
        for repo_type in ("model", "dataset", "space"):
            try:
                if repo_type == "model":
                    items = list(api.list_models(search=query, sort="lastModified", limit=30))
                elif repo_type == "dataset":
                    items = list(api.list_datasets(search=query, sort="lastModified", limit=30))
                else:
                    items = list(api.list_spaces(search=query, sort="lastModified", limit=30))

                for item in items:
                    rid = item.id
                    if rid in seen:
                        continue

                    lm = getattr(item, "lastModified", None) or getattr(item, "last_modified", None)
                    if lm is None:
                        continue
                    if isinstance(lm, str):
                        lm = datetime.fromisoformat(lm.replace("Z", "+00:00"))
                    if lm.tzinfo is None:
                        lm = lm.replace(tzinfo=timezone.utc)
                    if lm < cutoff:
                        break  # results are sorted newest-first

                    seen.add(rid)
                    tags = list(getattr(item, "tags", []) or [])
                    cat  = classify(tags, rid)
                    risk = risk_level(tags, rid)

                    findings.append({
                        "id":       rid,
                        "type":     repo_type.capitalize(),
                        "url":      f"https://hf.co/{'datasets/' if repo_type == 'dataset' else ''}{rid}",
                        "author":   rid.split("/")[0],
                        "last_mod": lm.strftime("%Y-%m-%d %H:%M UTC"),
                        "tags":     tags[:8],
                        "dl":       getattr(item, "downloads", 0) or 0,
                        "likes":    getattr(item, "likes", 0) or 0,
                        "cat":      cat,
                        "risk":     risk,
                    })

            except Exception as e:
                print(f"[WARN] {repo_type}/{query}: {e}", file=sys.stderr)

    order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    findings.sort(key=lambda x: (order.get(x["risk"], 9), -x["dl"]))
    return findings


# ── Notion ────────────────────────────────────────────────────────────────────

def save_to_notion(findings: list[dict], run_ts: str) -> None:
    if not NOTION_TOKEN:
        print("[SKIP] NOTION_TOKEN not configured")
        return

    high   = [f for f in findings if f["risk"] in ("CRITICAL", "HIGH")]
    lines  = [f"Scan: {run_ts} | Total: {len(findings)} | Critical/High: {len(high)}", ""]
    for f in findings[:50]:
        lines.append(
            f"[{f['risk']}] {f['id']} ({f['type']}) | {f['cat']} | "
            f"DL:{f['dl']} | Tags: {','.join(f['tags'][:4])} | {f['url']}"
        )
    content = "\n".join(lines)[:1990]

    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }
    payload = {
        "parent": {"type": "workspace", "workspace": True},
        "properties": {
            "title": {"title": [{"text": {"content": f"HF Security Digest – {run_ts}"}}]}
        },
        "children": [
            {
                "object": "block", "type": "callout",
                "callout": {
                    "icon": {"type": "emoji", "emoji": "🛡️"},
                    "rich_text": [{"type": "text", "text": {
                        "content": f"Total: {len(findings)} repos | Critical/High: {len(high)} | {run_ts}"
                    }}]
                }
            },
            {
                "object": "block", "type": "code",
                "code": {
                    "language": "markdown",
                    "rich_text": [{"type": "text", "text": {"content": content}}]
                }
            },
        ],
    }

    r = requests.post("https://api.notion.com/v1/pages", headers=headers,
                      json=payload, timeout=15)
    if r.ok:
        print(f"[Notion] Created page: {r.json().get('id')}")
    else:
        print(f"[Notion] Error {r.status_code}: {r.text[:200]}", file=sys.stderr)


# ── Email ─────────────────────────────────────────────────────────────────────

RISK_COLORS = {
    "CRITICAL": ("#ff7b72", "#1a0a09"),
    "HIGH":     ("#f0883e", "#1a1209"),
    "MEDIUM":   ("#e3b341", "#1a1800"),
    "LOW":      ("#3fb950", "#161b22"),
}

def send_email(findings: list[dict], run_ts: str) -> None:
    if not GMAIL_USER or not GMAIL_APP_PASS:
        print("[SKIP] Gmail credentials not configured")
        return

    high = [f for f in findings if f["risk"] in ("CRITICAL", "HIGH")]

    rows = ""
    for f in findings[:35]:
        fc, bg = RISK_COLORS.get(f["risk"], ("#c9d1d9", "#161b22"))
        rows += (
            f"<tr style='background:{bg}'>"
            f"<td style='padding:5px;border:1px solid #30363d;color:{fc}'>{f['risk']}</td>"
            f"<td style='padding:5px;border:1px solid #30363d'>"
            f"<a href='{f['url']}' style='color:#58a6ff'>{f['id']}</a></td>"
            f"<td style='padding:5px;border:1px solid #30363d;color:#8b949e'>{f['type']}</td>"
            f"<td style='padding:5px;border:1px solid #30363d;color:#c9d1d9'>{f['cat']}</td>"
            f"<td style='padding:5px;border:1px solid #30363d;color:#8b949e'>{f['dl']:,}</td>"
            f"</tr>"
        )

    html = f"""<html><body style='font-family:Arial,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px;max-width:900px'>
<h2 style='color:#58a6ff;margin-bottom:4px'>&#128737; HF Security Intel &mdash; {run_ts}</h2>
<p style='color:#8b949e;margin-top:0'>
  Total new/updated: <strong style='color:#c9d1d9'>{len(findings)}</strong> &nbsp;|&nbsp;
  Critical/High: <strong style='color:#ff7b72'>{len(high)}</strong>
</p>
<table style='width:100%;border-collapse:collapse;font-size:12px'>
<tr style='background:#21262d'>
  <th style='padding:6px;border:1px solid #30363d;color:#8b949e;text-align:left'>Risk</th>
  <th style='padding:6px;border:1px solid #30363d;color:#8b949e;text-align:left'>Repository</th>
  <th style='padding:6px;border:1px solid #30363d;color:#8b949e;text-align:left'>Type</th>
  <th style='padding:6px;border:1px solid #30363d;color:#8b949e;text-align:left'>Category</th>
  <th style='padding:6px;border:1px solid #30363d;color:#8b949e;text-align:left'>Downloads</th>
</tr>
{rows}
</table>
<p style='color:#484f58;font-size:10px;margin-top:16px'>
  Automated HF Security Scanner &middot; {run_ts} &middot; canstralian/splat
</p>
</body></html>"""

    plain = (
        f"HF Security Intel – {run_ts}\n"
        f"Total: {len(findings)} | Critical/High: {len(high)}\n\n"
        + "\n".join(f"[{f['risk']}] {f['id']} | {f['cat']} | DL:{f['dl']} | {f['url']}"
                    for f in findings[:35])
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"🛡️ HF Security Intel – {run_ts} | {len(findings)} findings ({len(high)} high)"
    msg["From"]    = GMAIL_USER
    msg["To"]      = RECIPIENT
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html,  "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as srv:
            srv.login(GMAIL_USER, GMAIL_APP_PASS)
            srv.sendmail(GMAIL_USER, RECIPIENT, msg.as_string())
        print(f"[Email] Sent to {RECIPIENT}")
    except Exception as e:
        print(f"[Email] Failed: {e}", file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=LOOKBACK_MINUTES)
    run_ts = now.strftime("%Y-%m-%d %H:%M UTC")

    print(f"[START] {run_ts}")
    print(f"[INFO]  Scanning repos modified since {cutoff.strftime('%Y-%m-%d %H:%M UTC')}")

    findings = scan_hf(cutoff)
    print(f"[FOUND] {len(findings)} new/updated security repos")

    if not findings:
        print("[DONE]  Nothing new this hour – digest skipped")
        return

    # Emit JSON summary for GH Actions annotations
    high = [f for f in findings if f["risk"] in ("CRITICAL", "HIGH")]
    if high:
        print(f"::warning title=High-Risk Findings::{len(high)} Critical/High repos detected this hour")
    print(json.dumps({"run_ts": run_ts, "total": len(findings), "high": len(high)}, indent=2))

    save_to_notion(findings, run_ts)
    send_email(findings, run_ts)
    print(f"[DONE]  Digest complete – {len(findings)} findings")


if __name__ == "__main__":
    main()
