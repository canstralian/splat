"""Tests for .github/FUNDING.yml structure and content."""

import os
import unittest

import yaml

FUNDING_FILE = os.path.join(
    os.path.dirname(__file__), "..", ".github", "FUNDING.yml"
)

VALID_PLATFORMS = {
    "github",
    "patreon",
    "open_collective",
    "ko_fi",
    "tidelift",
    "community_bridge",
    "liberapay",
    "issuehunt",
    "otechie",
    "lfx_crowdfunding",
    "polar",
    "buy_me_a_coffee",
    "thanks_dev",
    "custom",
}


class TestFundingYml(unittest.TestCase):
    funding_file: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.funding_file = os.path.abspath(FUNDING_FILE)

    def _load_funding(self) -> dict:
        """Helper to load and return parsed FUNDING.yml content."""
        with open(self.funding_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        self.assertIsInstance(
            data, dict, "FUNDING.yml top-level structure should be a YAML mapping"
        )
        return data

    def test_file_exists(self) -> None:
        self.assertTrue(
            os.path.isfile(self.funding_file),
            f"FUNDING.yml not found at {self.funding_file}",
        )

    def test_file_is_valid_yaml(self) -> None:
        with open(self.funding_file, "r", encoding="utf-8") as f:
            try:
                yaml.safe_load(f)
            except yaml.YAMLError as exc:
                self.fail(f"FUNDING.yml is not valid YAML: {exc}")

    def test_top_level_is_mapping_or_empty(self) -> None:
        self._load_funding()

    def test_only_valid_platforms(self) -> None:
        data = self._load_funding()
        for key in data.keys():
            self.assertIn(
                key,
                VALID_PLATFORMS,
                f"Unknown platform '{key}' in FUNDING.yml",
            )

    def test_platform_values_are_strings_or_lists(self) -> None:
        data = self._load_funding()
        for platform, value in data.items():
            self.assertTrue(
                isinstance(value, (str, list)),
                f"Value for '{platform}' must be a string or list, got {type(value).__name__}",
            )
            if isinstance(value, list):
                for item in value:
                    self.assertIsInstance(
                        item,
                        str,
                        f"All items under '{platform}' must be strings",
                    )


if __name__ == "__main__":
    unittest.main()
