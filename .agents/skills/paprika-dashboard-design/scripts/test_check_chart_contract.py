"""Regression checks for declaration failures; these do not test Paprika runtime."""

import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

from check_chart_contract import contrast_ratio, validate


SCRIPT = Path(__file__).with_name("check_chart_contract.py")
EXAMPLE = SCRIPT.parent.parent / "assets" / "chart-contract.example.json"


class ChartContractTests(unittest.TestCase):
    def setUp(self):
        self.example = json.loads(EXAMPLE.read_text(encoding="utf-8"))

    def changed(self, path, value):
        result = copy.deepcopy(self.example)
        target = result
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        return result

    def assert_invalid(self, document, fragment=None):
        result = validate(document)
        self.assertFalse(result["valid"], result)
        self.assertFalse(result["runtime_verified"])
        self.assertEqual(result["scope"], "declared-contract-only")
        if fragment:
            self.assertIn(fragment, json.dumps(result["errors"]))
        return result

    def cli(self, raw):
        return subprocess.run([sys.executable, str(SCRIPT), "-"], input=raw,
                              text=True, capture_output=True, check=False)

    def test_realistic_example_and_explicit_scope(self):
        result = validate(self.example)
        self.assertTrue(result["valid"], result)
        self.assertFalse(result["runtime_verified"])
        self.assertEqual(result["scope"], "declared-contract-only")
        self.assertEqual(len(result["contrast_results"]), 3)
        self.assertIn("No runtime evidence", " ".join(result["warnings"]))

    def test_evidence_references_never_verify_runtime(self):
        document = self.changed(("evidence",), ["screenshots/review.png", "reports/query-checks.json"])
        result = validate(document)
        self.assertTrue(result["valid"], result)
        self.assertFalse(result["runtime_verified"])
        self.assertIn("were not verified", " ".join(result["warnings"]))

    def test_missing_optional_contrast_is_unassessed(self):
        del self.example["contrast_pairs"]
        result = validate(self.example)
        self.assertTrue(result["valid"], result)
        self.assertIn("contrast remains unassessed", " ".join(result["warnings"]))

    def test_important_contradictions(self):
        mutations = [
            (("version",), True, "integer 1"),
            (("time", "synchronization"), "array_index", "timestamp"),
            (("panels", 0, "question"), "  ", "nonempty"),
            (("panels", 0, "metric", "scale"), 1000, "scale = 1"),
            (("panels", 1, "metric", "scale"), 0.001, "multiply"),
            (("panels", 1, "metric", "display_unit"), "bytes", "different dimensions"),
            (("panels", 1, "metric", "display_unit"), "fortnights", "unrecognized conversion"),
            (("panels", 0, "metric", "rate_order"), "after_aggregation", "before"),
            (("panels", 0, "metric", "kind"), "gauge", "counter"),
            (("panels", 1, "metric", "aggregation"), "mean", "percentiles"),
            (("panels", 1, "metric", "kind"), "summary", "cannot be merged"),
            (("panels", 1, "metric", "percentile"), 95, "between 0 and 1"),
            (("panels", 2, "metric", "denominator", "zero"), "zero", "unknown"),
            (("panels", 2, "metric", "denominator", "missing"), "zero", "unknown"),
            (("panels", 2, "metric", "aggregation"), "mean", "before division"),
            (("panels", 0, "metric", "precision", "decimals"), 2, "source support"),
            (("panels", 0, "data", "missing"), "zero", "gap"),
            (("panels", 0, "data", "summary_source"), "decimated_points", "before_visual_decimation"),
            (("panels", 0, "data", "series_identity"), "array_index", "stable_id"),
            (("panels", 0, "data", "series_key"), "rank", "stable series identity"),
            (("panels", 0, "interaction", "keyboard"), "", "nonempty"),
            (("panels", 0, "interaction", "touch"), None, "nonempty"),
            (("panels", 0, "interaction", "non_drag"), "", "nonempty"),
            (("panels", 0, "interaction", "interactive"), False, "drag actions"),
        ]
        for path, value, fragment in mutations:
            with self.subTest(path=path, value=value):
                self.assert_invalid(self.changed(path, value), fragment)

    def test_duplicate_ids_and_unknown_fields(self):
        self.example["panels"].append(copy.deepcopy(self.example["panels"][0]))
        self.assert_invalid(self.example, "unique")
        self.assert_invalid(self.changed(("format",), "paprika-dashboard"), "paprika-chart-review")
        self.example["production_verified"] = True
        self.assert_invalid(self.example, "unknown field")

    def test_required_nested_fields_cannot_be_omitted(self):
        for key in ("id", "question", "metric", "chart", "data", "interaction"):
            with self.subTest(key=key):
                document = copy.deepcopy(self.example)
                del document["panels"][0][key]
                self.assert_invalid(document)
        document = copy.deepcopy(self.example)
        del document["panels"][2]["metric"]["denominator"]
        self.assert_invalid(document, "denominator")

    def test_cumulative_counter_is_legitimate(self):
        metric = self.example["panels"][0]["metric"]
        metric.update(statistic="value", unit="requests", display_unit="requests")
        del metric["rate_order"]
        self.assertTrue(validate(self.example)["valid"])

    def test_single_counter_rate_needs_no_aggregation_order(self):
        metric = self.example["panels"][0]["metric"]
        metric["aggregation"] = "none"
        del metric["rate_order"]
        self.assertTrue(validate(self.example)["valid"])

    def test_summary_quantile_without_aggregation_is_legitimate(self):
        self.example["panels"][1]["metric"].update(kind="summary", aggregation="none")
        self.assertTrue(validate(self.example)["valid"])

    def test_domain_and_baseline_rules(self):
        for chart in (
            {"type": "bar", "scale": "linear", "domain": [10, 90], "baseline": 0},
            {"type": "bar", "scale": "linear", "domain": [0, 100], "baseline": 10},
            {"type": "area", "scale": "linear", "domain": [5, 20], "baseline": 5},
            {"type": "bar", "scale": "log", "domain": [1, 100], "baseline": 0},
            {"type": "line", "scale": "log", "domain": [0, 100]},
            {"type": "line", "scale": "linear", "domain": [10, 10]},
        ):
            with self.subTest(chart=chart):
                self.assert_invalid(self.changed(("panels", 0, "chart"), chart))
        for chart in (
            {"type": "line", "scale": "linear", "domain": [90, 110]},
            {"type": "line", "scale": "log", "domain": [1, 1000]},
            {"type": "bar", "scale": "linear", "domain": [-20, 80], "baseline": 0},
        ):
            with self.subTest(chart=chart):
                result = validate(self.changed(("panels", 0, "chart"), chart))
                self.assertTrue(result["valid"], result)

    def test_justified_visible_imputation_is_allowed(self):
        data = self.example["panels"][0]["data"]
        data.update(missing="impute", imputation={
            "method": "zero for confirmed event-free closed intervals",
            "rationale": "The source contract guarantees complete intervals with explicit no-event markers.",
            "provenance": "source-contract/events-v2#closed-intervals",
            "visible": True,
        })
        self.assertTrue(validate(self.example)["valid"])
        for key, invalid in (("visible", False), ("provenance", ""), ("rationale", None)):
            with self.subTest(key=key):
                self.assert_invalid(self.changed(("panels", 0, "data", "imputation", key), invalid))
        del data["imputation"]
        self.assert_invalid(self.example, "imputation")

    def test_static_panel_is_allowed(self):
        self.example["panels"][0]["interaction"] = {"interactive": False, "drag_actions": []}
        self.assertTrue(validate(self.example)["valid"])

    def test_nonnumeric_values_and_bool_are_not_numbers(self):
        paths = [
            ("panels", 0, "metric", "scale"),
            ("panels", 1, "metric", "percentile"),
            ("panels", 0, "metric", "precision", "decimals"),
            ("panels", 2, "chart", "baseline"),
            ("panels", 2, "chart", "domain", 0),
        ]
        for path in paths:
            for invalid in (True, False, None, [], {}, "1", float("nan"), float("inf")):
                with self.subTest(path=path, invalid=invalid):
                    self.assert_invalid(self.changed(path, invalid))

    def test_malformed_structures_never_raise(self):
        for root in (None, [], True, 1, "", float("nan")):
            with self.subTest(root=root):
                self.assert_invalid(root)
        paths = [("time",), ("panels", 0), ("panels", 0, "metric"),
                 ("panels", 0, "chart"), ("panels", 0, "data"),
                 ("panels", 0, "interaction"), ("panels", 0, "metric", "precision"),
                 ("panels", 2, "metric", "denominator"), ("contrast_pairs", 0)]
        for path in paths:
            for invalid in (None, [], True, "bad", 1):
                with self.subTest(path=path, invalid=invalid):
                    self.assert_invalid(self.changed(path, invalid))
        for path in (("panels", 0, "metric", "kind"), ("panels", 0, "metric", "unit"),
                     ("panels", 0, "metric", "aggregation"), ("panels", 0, "chart", "type")):
            self.assert_invalid(self.changed(path, []))

    def test_contrast_boundaries_use_unrounded_ratio(self):
        self.assertEqual(contrast_ratio("#000", "#fff"), 21)
        self.assertEqual(contrast_ratio("#fff", "#fff"), 1)
        for role, foreground, expected in (
            ("normal_text", "#767676", True), ("normal_text", "#777777", False),
            ("essential_graphics", "#949494", True), ("essential_graphics", "#959595", False),
        ):
            with self.subTest(role=role, foreground=foreground):
                pair = {"name": "Boundary fixture", "role": role, "foreground": foreground, "background": "#fff"}
                result = validate(self.changed(("contrast_pairs",), [pair]))
                self.assertEqual(result["valid"], expected, result)
        self.assertEqual(round(contrast_ratio("#959595", "#fff"), 2), 3.0)

    def test_large_text_requires_qualifying_size_and_weight(self):
        pair = {"name": "Large metric", "role": "large_text", "foreground": "#888",
                "background": "#fff", "font_size_px": 24}
        self.assertTrue(validate(self.changed(("contrast_pairs",), [pair]))["valid"])
        pair["font_size_px"] = 18
        self.assert_invalid(self.changed(("contrast_pairs",), [pair]), "large text")
        pair.update(font_size_px=56 / 3, bold=True)
        self.assertTrue(validate(self.changed(("contrast_pairs",), [pair]))["valid"])
        pair["bold"] = "true"
        self.assert_invalid(self.changed(("contrast_pairs",), [pair]))

    def test_contrast_rejects_alpha_css_and_malformed_pairs(self):
        for color in ("#0008", "#ffffff88", "rgba(0,0,0,.5)", "var(--line)", "black", None, 123):
            with self.subTest(color=color):
                self.assert_invalid(self.changed(("contrast_pairs", 0, "foreground"), color), "opaque")
        self.assert_invalid(self.changed(("contrast_pairs",), None), "array")

    def test_ineligible_large_text_never_gets_a_passing_subresult(self):
        pair = {"name": "Small label", "role": "large_text", "foreground": "#888",
                "background": "#fff", "font_size_px": 12}
        result = self.assert_invalid(self.changed(("contrast_pairs",), [pair]))
        self.assertEqual(result["contrast_results"], [])
        pair.update(font_size_px=24, bold="false")
        result = self.assert_invalid(self.changed(("contrast_pairs",), [pair]))
        self.assertEqual(result["contrast_results"], [])

    def test_cli_invalid_utf8_stdin_returns_an_input_error(self):
        raw = json.dumps(self.example).encode("utf-8")
        raw = raw.replace(b'"question": "', b'"question": "\xff', 1)
        process = subprocess.run([sys.executable, str(SCRIPT), "-"], input=raw,
                                 capture_output=True, check=False)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(process.stderr, b"")
        result = json.loads(process.stdout)
        self.assertFalse(result["valid"])
        self.assertFalse(result["runtime_verified"])

    def test_cli_valid_and_invalid_exit_codes(self):
        valid = self.cli(json.dumps(self.example))
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertFalse(json.loads(valid.stdout)["runtime_verified"])
        invalid = self.cli(json.dumps(self.changed(("version",), True)))
        self.assertEqual(invalid.returncode, 1)
        self.assertFalse(json.loads(invalid.stdout)["valid"])

    def test_cli_malformed_json_returns_json_without_traceback(self):
        for raw in ("{", "", '{"version": NaN}', '{"version": Infinity}',
                    '{"version": 1, "version": 2}'):
            with self.subTest(raw=raw):
                process = self.cli(raw)
                self.assertEqual(process.returncode, 2, process.stdout)
                self.assertEqual(process.stderr, "")
                result = json.loads(process.stdout)
                self.assertFalse(result["valid"])
                self.assertFalse(result["runtime_verified"])
        for raw in ("null", "[]", "true", "42", '"string"'):
            process = self.cli(raw)
            self.assertEqual(process.returncode, 1)
            self.assertEqual(process.stderr, "")

    def test_cli_missing_file_and_usage_error(self):
        for args in ([], [str(EXAMPLE.parent / "does-not-exist.json")]):
            process = subprocess.run([sys.executable, str(SCRIPT)] + args,
                                     text=True, capture_output=True, check=False)
            self.assertEqual(process.returncode, 2)
            self.assertEqual(process.stderr, "")
            self.assertFalse(json.loads(process.stdout)["valid"])


if __name__ == "__main__":
    unittest.main()
