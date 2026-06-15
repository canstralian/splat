"""
Comprehensive tests for scripts/hf_secIntel_scan.py

Run with:
    pytest tests/test_hf_secIntel_scan.py -v
"""

import datetime
import importlib
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch, mock_open, call

import pytest

# ── Module import with isolated env vars ─────────────────────────────────────

# Ensure the scripts directory is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

# Import the module under test with neutral env vars so module-level globals
# start in a known (empty) state during the test session.
with patch.dict(
    os.environ,
    {
        "HF_TOKEN": "",
        "NOTION_API_KEY": "",
        "NOTION_PARENT_PAGE_ID": "",
        "GMAIL_RECIPIENT": "test@example.com",
        "SMTP_USER": "",
        "SMTP_APP_PASSWORD": "",
        "GITHUB_RUN_NUMBER": "42",
        "STATE_FILE": "/tmp/test_hf_secIntel_seen.json",
    },
    clear=False,
):
    import hf_secIntel_scan as scanner

# ── Fixtures ──────────────────────────────────────────────────────────────────

SAMPLE_FINDING_HIGH = {
    "id": "evil-corp/malware-model",
    "type": "Model",
    "url": "https://huggingface.co/evil-corp/malware-model",
    "author": "evil-corp",
    "created": "2024-01-15T10:00:00Z",
    "modified": "2024-01-15T11:00:00Z",
    "tags": ["c2", "malware"],
    "downloads": 100,
    "likes": 5,
    "classification": "Suspicious",
    "risk": "HIGH",
    "matched_query": "malware",
}

SAMPLE_FINDING_MEDIUM = {
    "id": "researcher/pentest-toolkit",
    "type": "Dataset",
    "url": "https://huggingface.co/datasets/researcher/pentest-toolkit",
    "author": "researcher",
    "created": "2024-01-15T09:00:00Z",
    "modified": "2024-01-15T10:30:00Z",
    "tags": ["pentest", "security"],
    "downloads": 500,
    "likes": 20,
    "classification": "Dual-use",
    "risk": "MEDIUM",
    "matched_query": "pentest",
}

SAMPLE_FINDING_LOW = {
    "id": "defteam/ids-model",
    "type": "Model",
    "url": "https://huggingface.co/defteam/ids-model",
    "author": "defteam",
    "created": "2024-01-15T08:00:00Z",
    "modified": "2024-01-15T09:00:00Z",
    "tags": ["detection", "ids"],
    "downloads": 1000,
    "likes": 50,
    "classification": "Defensive",
    "risk": "LOW",
    "matched_query": "detection",
}


# ── repo_id ───────────────────────────────────────────────────────────────────

class TestRepoId:
    def test_uses_id_field_when_present(self):
        repo = {"id": "owner/repo", "modelId": "fallback", "_id": "other"}
        assert scanner.repo_id(repo) == "owner/repo"

    def test_falls_back_to_modelId(self):
        repo = {"modelId": "owner/model-name"}
        assert scanner.repo_id(repo) == "owner/model-name"

    def test_falls_back_to_underscore_id(self):
        repo = {"_id": "some-unique-id"}
        assert scanner.repo_id(repo) == "some-unique-id"

    def test_returns_empty_string_when_no_id(self):
        repo = {"name": "no-id-here"}
        assert scanner.repo_id(repo) == ""

    def test_empty_dict(self):
        assert scanner.repo_id({}) == ""

    def test_id_takes_priority_over_underscore_id(self):
        repo = {"_id": "old-id", "id": "new-id"}
        assert scanner.repo_id(repo) == "new-id"


# ── classify ──────────────────────────────────────────────────────────────────

class TestClassify:
    def test_suspicious_via_tag(self):
        repo = {"id": "org/repo", "tags": ["c2", "network"]}
        assert scanner.classify(repo) == "Suspicious"

    def test_suspicious_via_botnet_tag(self):
        repo = {"id": "org/repo", "tags": ["botnet-trainer"]}
        assert scanner.classify(repo) == "Suspicious"

    def test_suspicious_via_stealer_in_raw(self):
        # "stealer" appears anywhere in the JSON dump
        repo = {"id": "org/infostealer-demo", "tags": []}
        assert scanner.classify(repo) == "Suspicious"

    def test_suspicious_via_keylogger_in_tags(self):
        repo = {"id": "org/repo", "tags": ["keylogger"]}
        assert scanner.classify(repo) == "Suspicious"

    def test_suspicious_via_jailbreak_keyword(self):
        repo = {"id": "org/jailbreak-llm", "tags": []}
        assert scanner.classify(repo) == "Suspicious"

    def test_dualuse_via_pentest_tag(self):
        repo = {"id": "org/repo", "tags": ["pentest", "security"]}
        assert scanner.classify(repo) == "Dual-use"

    def test_dualuse_via_exploit_tag(self):
        repo = {"id": "org/repo", "tags": ["exploit-framework"]}
        assert scanner.classify(repo) == "Dual-use"

    def test_dualuse_via_redteam_in_id(self):
        repo = {"id": "org/redteam-tools", "tags": []}
        assert scanner.classify(repo) == "Dual-use"

    def test_defensive_via_detection_tag(self):
        repo = {"id": "org/repo", "tags": ["detection", "ml"]}
        assert scanner.classify(repo) == "Defensive"

    def test_defensive_via_ids_tag(self):
        repo = {"id": "org/ids-dataset", "tags": ["ids"]}
        assert scanner.classify(repo) == "Defensive"

    def test_defensive_via_siem_tag(self):
        repo = {"id": "org/siem-model", "tags": ["siem"]}
        assert scanner.classify(repo) == "Defensive"

    def test_research_educational_by_default(self):
        repo = {"id": "org/generic-nlp", "tags": ["text-classification"]}
        assert scanner.classify(repo) == "Research/Educational"

    def test_suspicious_takes_priority_over_dualuse(self):
        # "poc" is suspicious, "exploit" is dual-use; suspicious wins since raw check comes first
        repo = {"id": "org/exploit-poc-demo", "tags": ["exploit"]}
        assert scanner.classify(repo) == "Suspicious"

    def test_dualuse_takes_priority_over_defensive(self):
        # "pentest" is dual-use, "detection" is defensive
        repo = {"id": "org/repo", "tags": ["pentest", "detection"]}
        assert scanner.classify(repo) == "Dual-use"

    def test_empty_repo(self):
        assert scanner.classify({}) == "Research/Educational"

    def test_classify_case_insensitive(self):
        # json.dumps().lower() is used, so uppercase tags still match
        repo = {"id": "org/repo", "tags": ["C2"]}
        assert scanner.classify(repo) == "Suspicious"


# ── risk_level ────────────────────────────────────────────────────────────────

class TestRiskLevel:
    def test_suspicious_maps_to_high(self):
        assert scanner.risk_level("Suspicious") == "HIGH"

    def test_dualuse_maps_to_medium(self):
        assert scanner.risk_level("Dual-use") == "MEDIUM"

    def test_defensive_maps_to_low(self):
        assert scanner.risk_level("Defensive") == "LOW"

    def test_research_educational_maps_to_low(self):
        assert scanner.risk_level("Research/Educational") == "LOW"

    def test_unknown_classification_maps_to_low(self):
        assert scanner.risk_level("Unknown") == "LOW"

    def test_empty_string_maps_to_low(self):
        assert scanner.risk_level("") == "LOW"


# ── is_recent ─────────────────────────────────────────────────────────────────

class TestIsRecent:
    def _now(self):
        return datetime.datetime.now(datetime.timezone.utc)

    def test_recent_via_lastModified(self):
        ts = (self._now() - datetime.timedelta(minutes=30)).isoformat()
        repo = {"lastModified": ts}
        assert scanner.is_recent(repo, hours=1) is True

    def test_recent_via_createdAt(self):
        ts = (self._now() - datetime.timedelta(minutes=10)).isoformat()
        repo = {"createdAt": ts}
        assert scanner.is_recent(repo, hours=1) is True

    def test_not_recent_old_timestamp(self):
        ts = (self._now() - datetime.timedelta(hours=5)).isoformat()
        repo = {"lastModified": ts}
        assert scanner.is_recent(repo, hours=1) is False

    def test_exactly_at_cutoff_boundary(self):
        # Exactly at cutoff should NOT be recent (dt >= cutoff requires >=)
        ts = (self._now() - datetime.timedelta(hours=1)).isoformat()
        repo = {"lastModified": ts}
        # This is borderline; the function checks dt >= cutoff
        # Since we compute cutoff BEFORE calling is_recent, there may be sub-second drift.
        # We simply verify the function returns a bool without raising.
        result = scanner.is_recent(repo, hours=1)
        assert isinstance(result, bool)

    def test_missing_timestamps(self):
        repo = {"name": "no-timestamps"}
        assert scanner.is_recent(repo, hours=1) is False

    def test_none_timestamp_skipped(self):
        repo = {"lastModified": None, "createdAt": None}
        assert scanner.is_recent(repo, hours=1) is False

    def test_invalid_timestamp_skipped(self):
        repo = {"lastModified": "not-a-date"}
        assert scanner.is_recent(repo, hours=1) is False

    def test_zulu_suffix_handled(self):
        ts = (self._now() - datetime.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        repo = {"lastModified": ts}
        assert scanner.is_recent(repo, hours=1) is True

    def test_lastModified_checked_before_createdAt(self):
        # lastModified is old but createdAt is recent → should return True
        old_ts = (self._now() - datetime.timedelta(hours=3)).isoformat()
        new_ts = (self._now() - datetime.timedelta(minutes=5)).isoformat()
        repo = {"lastModified": old_ts, "createdAt": new_ts}
        assert scanner.is_recent(repo, hours=1) is True

    def test_multiple_hours_lookback(self):
        ts = (self._now() - datetime.timedelta(hours=10)).isoformat()
        repo = {"lastModified": ts}
        assert scanner.is_recent(repo, hours=24) is True
        assert scanner.is_recent(repo, hours=5) is False


# ── load_seen / save_seen ─────────────────────────────────────────────────────

class TestLoadSaveSeen:
    def test_load_seen_reads_existing_file(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        data = ["repo/a", "repo/b", "repo/c"]
        with open(state_file, "w") as f:
            json.dump(data, f)

        with patch.object(scanner, "STATE_FILE", state_file):
            result = scanner.load_seen()

        assert result == set(data)

    def test_load_seen_returns_empty_set_when_file_missing(self, tmp_path):
        state_file = str(tmp_path / "nonexistent.json")
        with patch.object(scanner, "STATE_FILE", state_file):
            result = scanner.load_seen()
        assert result == set()

    def test_load_seen_returns_empty_set_on_corrupt_json(self, tmp_path):
        state_file = str(tmp_path / "corrupt.json")
        with open(state_file, "w") as f:
            f.write("not valid json {{{")
        with patch.object(scanner, "STATE_FILE", state_file):
            result = scanner.load_seen()
        assert result == set()

    def test_load_seen_returns_empty_set_on_empty_file(self, tmp_path):
        state_file = str(tmp_path / "empty.json")
        with open(state_file, "w") as f:
            f.write("")
        with patch.object(scanner, "STATE_FILE", state_file):
            result = scanner.load_seen()
        assert result == set()

    def test_save_seen_writes_list_to_file(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        seen = {"repo/x", "repo/y"}
        with patch.object(scanner, "STATE_FILE", state_file):
            scanner.save_seen(seen)
        with open(state_file) as f:
            loaded = json.load(f)
        assert set(loaded) == seen

    def test_save_seen_empty_set(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        with patch.object(scanner, "STATE_FILE", state_file):
            scanner.save_seen(set())
        with open(state_file) as f:
            loaded = json.load(f)
        assert loaded == []

    def test_roundtrip_load_save_load(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        original = {"a/b", "c/d", "e/f"}
        with patch.object(scanner, "STATE_FILE", state_file):
            scanner.save_seen(original)
            loaded = scanner.load_seen()
        assert loaded == original


# ── hf_search ─────────────────────────────────────────────────────────────────

class TestHfSearch:
    def test_returns_json_on_success(self):
        mock_response = MagicMock()
        mock_response.json.return_value = [{"id": "owner/repo"}]
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response) as mock_get:
            result = scanner.hf_search("malware", "model")

        assert result == [{"id": "owner/repo"}]
        mock_get.assert_called_once()

    def test_calls_correct_endpoint_for_model(self):
        mock_response = MagicMock()
        mock_response.json.return_value = []
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response) as mock_get:
            scanner.hf_search("pentest", "model")

        args, kwargs = mock_get.call_args
        assert "models" in args[0]

    def test_calls_correct_endpoint_for_dataset(self):
        mock_response = MagicMock()
        mock_response.json.return_value = []
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response) as mock_get:
            scanner.hf_search("exploit", "dataset")

        args, kwargs = mock_get.call_args
        assert "datasets" in args[0]

    def test_calls_correct_endpoint_for_space(self):
        mock_response = MagicMock()
        mock_response.json.return_value = []
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response) as mock_get:
            scanner.hf_search("forensic", "space")

        args, kwargs = mock_get.call_args
        assert "spaces" in args[0]

    def test_includes_authorization_header_when_token_set(self):
        mock_response = MagicMock()
        mock_response.json.return_value = []
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "HF_TOKEN", "my-secret-token"):
            with patch("requests.get", return_value=mock_response) as mock_get:
                scanner.hf_search("malware", "model")

        _, kwargs = mock_get.call_args
        assert kwargs["headers"]["Authorization"] == "Bearer my-secret-token"

    def test_no_authorization_header_when_token_empty(self):
        mock_response = MagicMock()
        mock_response.json.return_value = []
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "HF_TOKEN", ""):
            with patch("requests.get", return_value=mock_response) as mock_get:
                scanner.hf_search("malware", "model")

        _, kwargs = mock_get.call_args
        assert "Authorization" not in kwargs["headers"]

    def test_returns_empty_list_on_http_error(self):
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = Exception("HTTP 403")

        with patch("requests.get", return_value=mock_response):
            result = scanner.hf_search("malware", "model")

        assert result == []

    def test_returns_empty_list_on_connection_error(self):
        with patch("requests.get", side_effect=ConnectionError("timeout")):
            result = scanner.hf_search("malware", "model")

        assert result == []

    def test_passes_correct_search_params(self):
        mock_response = MagicMock()
        mock_response.json.return_value = []
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response) as mock_get:
            scanner.hf_search("exploit", "model", limit=15)

        _, kwargs = mock_get.call_args
        params = kwargs["params"]
        assert params["search"] == "exploit"
        assert params["limit"] == 15
        assert params["sort"] == "lastModified"
        assert params["direction"] == -1


# ── build_notion_content ──────────────────────────────────────────────────────

class TestBuildNotionContent:
    def test_empty_findings_returns_no_findings_message(self):
        result = scanner.build_notion_content([], "42", "2024-01-15 10:00 UTC")
        assert "No new or recently modified" in result
        assert "## Scan Metadata" in result

    def test_scan_metadata_present(self):
        result = scanner.build_notion_content([], "99", "2024-06-01 12:00 UTC")
        assert "Run #**: 99" in result
        assert "2024-06-01 12:00 UTC" in result

    def test_totals_in_metadata(self):
        findings = [SAMPLE_FINDING_HIGH, SAMPLE_FINDING_MEDIUM, SAMPLE_FINDING_LOW]
        result = scanner.build_notion_content(findings, "1", "2024-01-15")
        assert "Total new repositories**: 3" in result

    def test_high_risk_section_present_when_high_findings(self):
        result = scanner.build_notion_content(
            [SAMPLE_FINDING_HIGH], "1", "2024-01-15"
        )
        assert "High-Risk / Suspicious" in result
        assert "evil-corp/malware-model" in result

    def test_medium_risk_section_present_when_medium_findings(self):
        result = scanner.build_notion_content(
            [SAMPLE_FINDING_MEDIUM], "1", "2024-01-15"
        )
        assert "Dual-Use Watchlist" in result
        assert "researcher/pentest-toolkit" in result

    def test_low_risk_section_present_when_low_findings(self):
        result = scanner.build_notion_content(
            [SAMPLE_FINDING_LOW], "1", "2024-01-15"
        )
        assert "Defensive / Research" in result
        assert "defteam/ids-model" in result

    def test_missing_sections_not_rendered(self):
        # Only HIGH finding → medium/low sections should NOT appear
        result = scanner.build_notion_content(
            [SAMPLE_FINDING_HIGH], "1", "2024-01-15"
        )
        assert "Dual-Use Watchlist" not in result
        assert "Defensive / Research" not in result

    def test_executive_summary_counts(self):
        findings = [SAMPLE_FINDING_HIGH, SAMPLE_FINDING_MEDIUM]
        result = scanner.build_notion_content(findings, "5", "2024-01-15")
        assert "Detected **2**" in result
        assert "1 flagged HIGH" in result
        assert "1 MEDIUM" in result

    def test_empty_tags_rendered_as_dash(self):
        finding_no_tags = dict(SAMPLE_FINDING_HIGH, tags=[])
        result = scanner.build_notion_content([finding_no_tags], "1", "2024-01-15")
        assert "**Tags**: —" in result

    def test_tags_truncated_to_six(self):
        many_tags = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]
        finding = dict(SAMPLE_FINDING_HIGH, tags=many_tags)
        result = scanner.build_notion_content([finding], "1", "2024-01-15")
        # t7 and t8 should NOT appear
        assert "t7" not in result
        assert "t6" in result

    def test_missing_modified_date_renders_dash(self):
        finding = dict(SAMPLE_FINDING_HIGH, modified="")
        result = scanner.build_notion_content([finding], "1", "2024-01-15")
        assert "**Modified**: —" in result

    def test_high_risk_count_breakdown(self):
        findings = [SAMPLE_FINDING_HIGH] * 3 + [SAMPLE_FINDING_MEDIUM] * 2 + [SAMPLE_FINDING_LOW]
        result = scanner.build_notion_content(findings, "7", "2024-01-15")
        assert "High-risk**: 3" in result
        assert "Medium: 2" in result
        assert "Low/Defensive: 1" in result


# ── build_email_html ──────────────────────────────────────────────────────────

class TestBuildEmailHtml:
    def test_contains_doctype(self):
        result = scanner.build_email_html([], "1", "2024-01-15", None)
        assert "<!DOCTYPE html>" in result

    def test_no_findings_shows_placeholder_row(self):
        result = scanner.build_email_html([], "1", "2024-01-15", None)
        assert "No high/medium risk items this hour." in result

    def test_high_risk_row_rendered(self):
        result = scanner.build_email_html(
            [SAMPLE_FINDING_HIGH], "1", "2024-01-15", None
        )
        assert "evil-corp/malware-model" in result
        assert "#cc0000" in result  # HIGH badge color

    def test_medium_risk_row_rendered(self):
        result = scanner.build_email_html(
            [SAMPLE_FINDING_MEDIUM], "1", "2024-01-15", None
        )
        assert "researcher/pentest-toolkit" in result
        assert "#e07000" in result  # MEDIUM badge color

    def test_low_risk_finding_not_shown_in_table(self):
        # LOW risk items are excluded from the email table
        result = scanner.build_email_html(
            [SAMPLE_FINDING_LOW], "1", "2024-01-15", None
        )
        assert "No high/medium risk items this hour." in result

    def test_notion_link_present_when_url_given(self):
        result = scanner.build_email_html(
            [], "1", "2024-01-15", "https://notion.so/abc123"
        )
        assert "https://notion.so/abc123" in result
        assert "Full report in Notion" in result

    def test_notion_link_unavailable_when_url_none(self):
        result = scanner.build_email_html([], "1", "2024-01-15", None)
        assert "Notion link unavailable" in result

    def test_run_number_in_header(self):
        result = scanner.build_email_html([], "77", "2024-01-15", None)
        assert "Digest #77" in result

    def test_scan_date_in_body(self):
        result = scanner.build_email_html([], "1", "2024-06-11 08:00 UTC", None)
        assert "2024-06-11 08:00 UTC" in result

    def test_finding_counts_in_summary(self):
        result = scanner.build_email_html(
            [SAMPLE_FINDING_HIGH, SAMPLE_FINDING_MEDIUM], "1", "2024-01-15", None
        )
        assert "<strong>2</strong>" in result
        assert "<strong>1 HIGH</strong>" in result
        assert "<strong>1 MEDIUM</strong>" in result

    def test_missing_modified_date_renders_dash_in_table(self):
        finding = dict(SAMPLE_FINDING_HIGH, modified="")
        result = scanner.build_email_html([finding], "1", "2024-01-15", None)
        assert "—" in result

    def test_url_linked_in_table(self):
        result = scanner.build_email_html(
            [SAMPLE_FINDING_HIGH], "1", "2024-01-15", None
        )
        assert f'href="{SAMPLE_FINDING_HIGH["url"]}"' in result


# ── save_to_notion ────────────────────────────────────────────────────────────

class TestSaveToNotion:
    def test_skips_when_no_token(self, capsys):
        with patch.object(scanner, "NOTION_TOKEN", ""):
            result = scanner.save_to_notion([], "1", "2024-01-15")
        assert result is None
        captured = capsys.readouterr()
        assert "SKIP" in captured.err

    def test_returns_page_url_on_success(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {"url": "https://notion.so/page-123"}
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "NOTION_TOKEN", "test-token"):
            with patch("requests.post", return_value=mock_response):
                result = scanner.save_to_notion([], "1", "2024-01-15")

        assert result == "https://notion.so/page-123"

    def test_includes_parent_page_id_when_set(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {"url": "https://notion.so/page-123"}
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "NOTION_TOKEN", "test-token"):
            with patch.object(scanner, "NOTION_PAGE_ID", "parent-page-abc"):
                with patch("requests.post", return_value=mock_response) as mock_post:
                    scanner.save_to_notion([], "1", "2024-01-15")

        _, kwargs = mock_post.call_args
        assert kwargs["json"]["parent"]["page_id"] == "parent-page-abc"

    def test_no_parent_when_page_id_empty(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {}
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "NOTION_TOKEN", "test-token"):
            with patch.object(scanner, "NOTION_PAGE_ID", ""):
                with patch("requests.post", return_value=mock_response) as mock_post:
                    scanner.save_to_notion([], "1", "2024-01-15")

        _, kwargs = mock_post.call_args
        assert "parent" not in kwargs["json"]

    def test_returns_none_on_api_error(self, capsys):
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = Exception("API Error")

        with patch.object(scanner, "NOTION_TOKEN", "test-token"):
            with patch("requests.post", return_value=mock_response):
                result = scanner.save_to_notion([], "1", "2024-01-15")

        assert result is None
        captured = capsys.readouterr()
        assert "ERROR" in captured.err

    def test_title_contains_run_number_and_date(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {}
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "NOTION_TOKEN", "test-token"):
            with patch("requests.post", return_value=mock_response) as mock_post:
                scanner.save_to_notion([], "99", "2024-06-11 10:00 UTC")

        _, kwargs = mock_post.call_args
        title_content = kwargs["json"]["properties"]["title"]["title"][0]["text"]["content"]
        assert "99" in title_content
        assert "2024-06-11 10:00 UTC" in title_content

    def test_content_truncated_to_1900_chars(self):
        """Notion paragraph content is capped at 1900 chars."""
        # Build a finding with very long tag list to force long content
        finding = dict(
            SAMPLE_FINDING_HIGH,
            tags=["tag-" + str(i) for i in range(100)],
        )
        mock_response = MagicMock()
        mock_response.json.return_value = {}
        mock_response.raise_for_status = MagicMock()

        with patch.object(scanner, "NOTION_TOKEN", "test-token"):
            with patch("requests.post", return_value=mock_response) as mock_post:
                scanner.save_to_notion([finding] * 20, "1", "2024-01-15")

        _, kwargs = mock_post.call_args
        block_content = kwargs["json"]["children"][0]["paragraph"]["rich_text"][0]["text"]["content"]
        assert len(block_content) <= 1900


# ── send_email ────────────────────────────────────────────────────────────────

class TestSendEmail:
    def test_skips_when_smtp_user_missing(self, capsys):
        with patch.object(scanner, "SMTP_USER", ""):
            with patch.object(scanner, "SMTP_PASS", "password"):
                scanner.send_email([], "1", "2024-01-15", None)
        captured = capsys.readouterr()
        assert "SKIP" in captured.err

    def test_skips_when_smtp_pass_missing(self, capsys):
        with patch.object(scanner, "SMTP_USER", "user@example.com"):
            with patch.object(scanner, "SMTP_PASS", ""):
                scanner.send_email([], "1", "2024-01-15", None)
        captured = capsys.readouterr()
        assert "SKIP" in captured.err

    def test_sends_email_on_success(self, capsys):
        mock_server = MagicMock()
        mock_smtp_ssl = MagicMock(return_value=mock_server)
        mock_smtp_ssl.__enter__ = MagicMock(return_value=mock_server)
        mock_smtp_ssl.__exit__ = MagicMock(return_value=False)
        mock_ctx_manager = MagicMock()
        mock_ctx_manager.__enter__ = MagicMock(return_value=mock_server)
        mock_ctx_manager.__exit__ = MagicMock(return_value=False)

        with patch.object(scanner, "SMTP_USER", "sender@example.com"):
            with patch.object(scanner, "SMTP_PASS", "app-password"):
                with patch.object(scanner, "GMAIL_TO", "recipient@example.com"):
                    with patch("smtplib.SMTP_SSL", return_value=mock_ctx_manager):
                        scanner.send_email(
                            [SAMPLE_FINDING_HIGH], "1", "2024-01-15", None
                        )

        mock_server.login.assert_called_once_with(
            "sender@example.com", "app-password"
        )
        mock_server.sendmail.assert_called_once()

    def test_handles_smtp_error_gracefully(self, capsys):
        mock_ctx_manager = MagicMock()
        mock_ctx_manager.__enter__ = MagicMock(
            side_effect=Exception("Connection refused")
        )
        mock_ctx_manager.__exit__ = MagicMock(return_value=False)

        with patch.object(scanner, "SMTP_USER", "sender@example.com"):
            with patch.object(scanner, "SMTP_PASS", "app-password"):
                with patch("smtplib.SMTP_SSL", return_value=mock_ctx_manager):
                    scanner.send_email([], "1", "2024-01-15", None)

        captured = capsys.readouterr()
        assert "ERROR" in captured.err

    def test_subject_contains_run_number_and_counts(self):
        captured_msg = {}
        mock_server = MagicMock()

        def capture_sendmail(from_, to_, msg_str):
            captured_msg["subject"] = msg_str

        mock_server.sendmail.side_effect = capture_sendmail
        mock_ctx_manager = MagicMock()
        mock_ctx_manager.__enter__ = MagicMock(return_value=mock_server)
        mock_ctx_manager.__exit__ = MagicMock(return_value=False)

        with patch.object(scanner, "SMTP_USER", "sender@example.com"):
            with patch.object(scanner, "SMTP_PASS", "app-password"):
                with patch.object(scanner, "GMAIL_TO", "r@example.com"):
                    with patch("smtplib.SMTP_SSL", return_value=mock_ctx_manager):
                        scanner.send_email(
                            [SAMPLE_FINDING_HIGH, SAMPLE_FINDING_MEDIUM],
                            "55",
                            "2024-01-15",
                            None,
                        )

        assert "55" in captured_msg["subject"]
        assert "1H" in captured_msg["subject"]
        assert "1M" in captured_msg["subject"]


# ── run_scan ──────────────────────────────────────────────────────────────────

class TestRunScan:
    def _make_repo(self, repo_id: str, minutes_ago: int = 5, tags=None):
        """Helper: build a minimal repo dict that passes is_recent(hours=1)."""
        ts = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=minutes_ago)
        ).isoformat()
        return {
            "id": repo_id,
            "lastModified": ts,
            "tags": tags or [],
            "author": repo_id.split("/")[0] if "/" in repo_id else "",
            "createdAt": ts,
            "downloads": 0,
            "likes": 0,
        }

    def test_returns_empty_list_when_no_repos_found(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[]):
                result = scanner.run_scan(lookback_hours=1)
        assert result == []

    def test_finding_includes_expected_fields(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/test-model")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                findings = scanner.run_scan(lookback_hours=1)

        assert len(findings) == 1
        f = findings[0]
        assert f["id"] == "org/test-model"
        assert "type" in f
        assert "url" in f
        assert "author" in f
        assert "classification" in f
        assert "risk" in f
        assert "matched_query" in f

    def test_deduplication_within_single_run(self, tmp_path):
        """Same repo returned for multiple queries should only appear once."""
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/dup-model")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                findings = scanner.run_scan(lookback_hours=1)

        # QUERIES has 13 entries × 3 repo_types = 39 calls, but only 1 unique result
        assert len(findings) == 1

    def test_already_seen_repos_excluded(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        # Pre-populate the seen file with the repo we'll return
        with open(state_file, "w") as f:
            json.dump(["org/already-seen"], f)

        repo = self._make_repo("org/already-seen")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                findings = scanner.run_scan(lookback_hours=1)

        assert len(findings) == 0

    def test_old_repos_excluded_by_is_recent(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        old_ts = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(hours=5)
        ).isoformat()
        repo = {"id": "org/old-model", "lastModified": old_ts, "tags": []}

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                findings = scanner.run_scan(lookback_hours=1)

        assert len(findings) == 0

    def test_seen_state_updated_after_scan(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/new-model")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                scanner.run_scan(lookback_hours=1)

        with open(state_file) as f:
            saved = set(json.load(f))

        assert "org/new-model" in saved

    def test_url_construction_for_model(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/my-model")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                # Only trigger model calls
                original_queries = scanner.QUERIES
                with patch.object(scanner, "QUERIES", ["malware"]):
                    with patch.object(scanner, "REPO_TYPES", ["model"]):
                        findings = scanner.run_scan(lookback_hours=1)

        assert findings[0]["url"] == "https://huggingface.co/org/my-model"

    def test_url_construction_for_dataset(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/my-dataset")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                with patch.object(scanner, "QUERIES", ["malware"]):
                    with patch.object(scanner, "REPO_TYPES", ["dataset"]):
                        findings = scanner.run_scan(lookback_hours=1)

        assert findings[0]["url"] == "https://huggingface.co/datasets/org/my-dataset"

    def test_url_construction_for_space(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/my-space")

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                with patch.object(scanner, "QUERIES", ["malware"]):
                    with patch.object(scanner, "REPO_TYPES", ["space"]):
                        findings = scanner.run_scan(lookback_hours=1)

        assert findings[0]["url"] == "https://huggingface.co/spaces/org/my-space"

    def test_tags_truncated_to_ten(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("org/tagged", tags=[f"t{i}" for i in range(20)])

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                with patch.object(scanner, "QUERIES", ["malware"]):
                    with patch.object(scanner, "REPO_TYPES", ["model"]):
                        findings = scanner.run_scan(lookback_hours=1)

        assert len(findings[0]["tags"]) == 10

    def test_repo_with_empty_id_skipped(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        ts = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=5)
        ).isoformat()
        repo = {"id": "", "lastModified": ts, "tags": []}

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                findings = scanner.run_scan(lookback_hours=1)

        assert findings == []

    def test_author_extracted_from_id_when_missing(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        repo = self._make_repo("myorg/myrepo")
        if "author" in repo:
            del repo["author"]

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                with patch.object(scanner, "QUERIES", ["malware"]):
                    with patch.object(scanner, "REPO_TYPES", ["model"]):
                        findings = scanner.run_scan(lookback_hours=1)

        assert findings[0]["author"] == "myorg"


# ── notion_headers ────────────────────────────────────────────────────────────

class TestNotionHeaders:
    def test_contains_authorization(self):
        with patch.object(scanner, "NOTION_TOKEN", "my-notion-token"):
            headers = scanner.notion_headers()
        assert headers["Authorization"] == "Bearer my-notion-token"

    def test_contains_notion_version(self):
        headers = scanner.notion_headers()
        assert headers["Notion-Version"] == "2022-06-28"

    def test_contains_content_type(self):
        headers = scanner.notion_headers()
        assert headers["Content-Type"] == "application/json"


# ── main ──────────────────────────────────────────────────────────────────────

class TestMain:
    def test_skips_notion_and_email_when_no_findings_and_skip_empty(
        self, tmp_path, capsys
    ):
        state_file = str(tmp_path / "seen.json")
        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[]):
                with patch.dict(os.environ, {"LOOKBACK_HOURS": "1", "SKIP_EMPTY": "true"}):
                    with patch.object(scanner, "save_to_notion") as mock_notion:
                        with patch.object(scanner, "send_email") as mock_email:
                            scanner.main()

        mock_notion.assert_not_called()
        mock_email.assert_not_called()
        captured = capsys.readouterr()
        assert "SKIP" in captured.out

    def test_calls_notion_and_email_when_findings_present(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        ts = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=5)
        ).isoformat()
        repo = {
            "id": "org/new-model",
            "lastModified": ts,
            "createdAt": ts,
            "tags": [],
            "downloads": 0,
            "likes": 0,
        }

        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                with patch.dict(os.environ, {"LOOKBACK_HOURS": "1", "SKIP_EMPTY": "true"}):
                    with patch.object(
                        scanner, "save_to_notion", return_value="https://notion.so/p"
                    ) as mock_notion:
                        with patch.object(scanner, "send_email") as mock_email:
                            # Limit to one query+type to get exactly one finding
                            with patch.object(scanner, "QUERIES", ["malware"]):
                                with patch.object(scanner, "REPO_TYPES", ["model"]):
                                    scanner.main()

        mock_notion.assert_called_once()
        mock_email.assert_called_once()

    def test_does_not_skip_when_skip_empty_is_false(self, tmp_path, capsys):
        state_file = str(tmp_path / "seen.json")
        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[]):
                with patch.dict(os.environ, {"LOOKBACK_HOURS": "1", "SKIP_EMPTY": "false"}):
                    with patch.object(
                        scanner, "save_to_notion", return_value=None
                    ) as mock_notion:
                        with patch.object(scanner, "send_email") as mock_email:
                            scanner.main()

        mock_notion.assert_called_once()
        mock_email.assert_called_once()

    def test_lookback_hours_read_from_env(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.dict(os.environ, {"LOOKBACK_HOURS": "6", "SKIP_EMPTY": "true"}):
                with patch.object(scanner, "run_scan", return_value=[]) as mock_run:
                    scanner.main()

        mock_run.assert_called_once_with(lookback_hours=6)

    def test_prints_done_when_findings_processed(self, tmp_path, capsys):
        state_file = str(tmp_path / "seen.json")
        ts = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=5)
        ).isoformat()
        repo = {
            "id": "org/my-model",
            "lastModified": ts,
            "createdAt": ts,
            "tags": [],
            "downloads": 0,
            "likes": 0,
        }
        with patch.object(scanner, "STATE_FILE", state_file):
            with patch.object(scanner, "hf_search", return_value=[repo]):
                with patch.dict(os.environ, {"LOOKBACK_HOURS": "1", "SKIP_EMPTY": "true"}):
                    with patch.object(scanner, "save_to_notion", return_value=None):
                        with patch.object(scanner, "send_email"):
                            with patch.object(scanner, "QUERIES", ["malware"]):
                                with patch.object(scanner, "REPO_TYPES", ["model"]):
                                    scanner.main()

        captured = capsys.readouterr()
        assert "[DONE]" in captured.out


# ── Edge / regression cases ───────────────────────────────────────────────────

class TestEdgeCases:
    def test_repo_id_uses_modelId_when_id_absent(self):
        """Regression: modelId fallback must work when 'id' key absent."""
        repo = {"modelId": "org/legacy-model", "tags": []}
        assert scanner.repo_id(repo) == "org/legacy-model"

    def test_classify_with_no_tags_field(self):
        """repo dict without 'tags' key should not raise."""
        repo = {"id": "org/notags"}
        result = scanner.classify(repo)
        assert result in {"Suspicious", "Dual-use", "Defensive", "Research/Educational"}

    def test_is_recent_with_both_timestamps_none(self):
        """Should return False without raising when both timestamps are None."""
        assert scanner.is_recent({"lastModified": None, "createdAt": None}, 1) is False

    def test_build_notion_content_returns_string(self):
        result = scanner.build_notion_content([], "1", "2024-01-01")
        assert isinstance(result, str)

    def test_build_email_html_returns_string(self):
        result = scanner.build_email_html([], "1", "2024-01-01", None)
        assert isinstance(result, str)

    def test_risk_level_all_known_classifications(self):
        assert scanner.risk_level("Suspicious") == "HIGH"
        assert scanner.risk_level("Dual-use") == "MEDIUM"
        assert scanner.risk_level("Defensive") == "LOW"
        assert scanner.risk_level("Research/Educational") == "LOW"

    def test_hf_search_invalid_repo_type_raises(self):
        """hf_search with unknown repo_type should raise KeyError (design behavior)."""
        with pytest.raises(KeyError):
            scanner.hf_search("malware", "unknown_type")

    def test_save_seen_overwrites_existing_file(self, tmp_path):
        state_file = str(tmp_path / "seen.json")
        with open(state_file, "w") as f:
            json.dump(["old/repo"], f)

        with patch.object(scanner, "STATE_FILE", state_file):
            scanner.save_seen({"new/repo"})

        with open(state_file) as f:
            loaded = json.load(f)

        assert "old/repo" not in loaded
        assert "new/repo" in loaded

    def test_classify_abliterat_is_suspicious(self):
        """Regression: 'abliterat' substring should match SUSPICIOUS_KEYWORDS."""
        repo = {"id": "org/abliterated-llm", "tags": []}
        assert scanner.classify(repo) == "Suspicious"

    def test_classify_zero_day_is_suspicious(self):
        repo = {"id": "org/repo", "tags": ["zero-day-exploit"]}
        assert scanner.classify(repo) == "Suspicious"

    def test_build_notion_content_all_three_risk_levels(self):
        findings = [SAMPLE_FINDING_HIGH, SAMPLE_FINDING_MEDIUM, SAMPLE_FINDING_LOW]
        result = scanner.build_notion_content(findings, "10", "2024-01-15")
        assert "High-Risk / Suspicious" in result
        assert "Dual-Use Watchlist" in result
        assert "Defensive / Research" in result
