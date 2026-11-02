#!/usr/bin/env python3
"""Lint a paprika-chart-review v1 declaration; never certify a rendered dashboard."""

import json
import math
import re
import sys
from pathlib import Path


FORMAT = "paprika-chart-review"
VERSION = 1
UNITS = {
    "seconds": ("duration", 1), "milliseconds": ("duration", 0.001),
    "microseconds": ("duration", 0.000001), "nanoseconds": ("duration", 1e-9),
    "bytes": ("bytes", 1), "KiB": ("bytes", 1024),
    "MiB": ("bytes", 1048576), "GiB": ("bytes", 1073741824),
    "ratio": ("fraction", 1), "percent": ("fraction", 0.01),
}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def contrast_ratio(foreground, background):
    """WCAG relative luminance for opaque sRGB #RGB or #RRGGBB colors."""
    def luminance(color):
        value = color[1:]
        if len(value) == 3:
            value = "".join(channel * 2 for channel in value)
        rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
                  for c in rgb]
        return sum(c * weight for c, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    values = sorted((luminance(foreground), luminance(background)))
    return (values[1] + 0.05) / (values[0] + 0.05)


class Review:
    def __init__(self):
        self.errors = []
        self.contrast_results = []

    def fail(self, path, message):
        self.errors.append({"path": path, "message": message})

    def obj(self, value, path, keys):
        if not isinstance(value, dict):
            self.fail(path, "must be an object")
            return {}
        for key in value:
            if key not in keys:
                self.fail(path + "." + str(key), "unknown field in review format v1")
        return value

    def text(self, value, path):
        if not isinstance(value, str) or not value.strip():
            self.fail(path, "must be a nonempty string")
            return False
        return True

    def choice(self, value, path, choices):
        if not isinstance(value, str) or value not in choices:
            self.fail(path, "must be one of: " + ", ".join(choices))
            return False
        return True

    def strings(self, value, path):
        if not isinstance(value, list):
            self.fail(path, "must be an array of nonempty strings")
            return []
        for index, item in enumerate(value):
            self.text(item, f"{path}[{index}]")
        return value

    def metric(self, value, path):
        m = self.obj(value, path, (
            "kind", "statistic", "unit", "display_unit", "scale", "aggregation",
            "rate_order", "percentile", "denominator", "precision"))
        kind, statistic, aggregation = m.get("kind"), m.get("statistic"), m.get("aggregation")
        self.choice(kind, path + ".kind", ("counter", "gauge", "histogram", "summary", "ratio"))
        self.choice(statistic, path + ".statistic", ("value", "rate", "percentile", "ratio"))
        self.choice(aggregation, path + ".aggregation", (
            "none", "sum", "mean", "min", "max", "distribution_then_quantile", "ratio_of_sums"))
        unit, display, scale = m.get("unit"), m.get("display_unit"), m.get("scale")
        units_valid = self.text(unit, path + ".unit")
        units_valid = self.text(display, path + ".display_unit") and units_valid
        if not number(scale) or scale <= 0:
            self.fail(path + ".scale", "must be a finite positive number, not a boolean")
        elif units_valid:
            if unit == display:
                if scale != 1:
                    self.fail(path + ".scale", "unchanged units require scale = 1")
            elif unit not in UNITS or display not in UNITS:
                self.fail(path + ".scale", "unrecognized conversion; retain base units or extend the reviewed unit registry")
            elif UNITS[unit][0] != UNITS[display][0]:
                self.fail(path + ".scale", "cannot convert between different dimensions")
            elif not math.isclose(scale, UNITS[unit][1] / UNITS[display][1], rel_tol=1e-9, abs_tol=0):
                self.fail(path + ".scale", "scale must multiply the canonical value into display units")
        if statistic == "rate":
            if kind not in ("counter", "histogram"):
                self.fail(path + ".kind", "rate requires a counter or counter histogram in v1")
            if aggregation != "none" and m.get("rate_order") != "before_aggregation":
                self.fail(path + ".rate_order", "apply rate before aggregating counters")
        if "rate_order" in m:
            self.choice(m["rate_order"], path + ".rate_order", ("before_aggregation",))
        if statistic == "percentile":
            if kind not in ("histogram", "summary"):
                self.fail(path + ".kind", "percentile requires histogram or summary input")
            if aggregation not in ("none", "distribution_then_quantile"):
                self.fail(path + ".aggregation", "do not average or sum percentiles; aggregate distributions first")
            if kind == "summary" and aggregation != "none":
                self.fail(path + ".aggregation", "precomputed summary quantiles cannot be merged")
            if not number(m.get("percentile")) or not 0 <= m["percentile"] <= 1:
                self.fail(path + ".percentile", "must be a finite quantile between 0 and 1")
        elif "percentile" in m or aggregation == "distribution_then_quantile":
            self.fail(path + ".statistic", "percentile fields require statistic = percentile")
        if kind == "ratio" or statistic == "ratio":
            if kind != "ratio" or statistic != "ratio":
                self.fail(path, "ratio kind and statistic must agree")
            if aggregation not in ("none", "ratio_of_sums"):
                self.fail(path + ".aggregation", "aggregate numerators and denominators before division")
            denominator = self.obj(m.get("denominator"), path + ".denominator", ("missing", "zero"))
            for condition in ("missing", "zero"):
                self.choice(denominator.get(condition), path + ".denominator." + condition, ("unknown", "error"))
        elif "denominator" in m or aggregation == "ratio_of_sums":
            self.fail(path, "denominator policies and ratio_of_sums require a ratio metric")
        precision = self.obj(m.get("precision"), path + ".precision", ("decimals", "supported_decimals"))
        valid_precision = True
        for key in ("decimals", "supported_decimals"):
            v = precision.get(key)
            if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 12:
                self.fail(path + ".precision." + key, "must be an integer from 0 to 12")
                valid_precision = False
        if valid_precision and precision["decimals"] > precision["supported_decimals"]:
            self.fail(path + ".precision.decimals", "display precision exceeds declared source support in display units")

    def chart(self, value, path):
        c = self.obj(value, path, ("type", "scale", "domain", "baseline"))
        chart_type = c.get("type")
        self.choice(chart_type, path + ".type", (
            "line", "scatter", "bar", "area", "heatmap", "stat", "table", "state_timeline"))
        quantitative = chart_type in ("line", "scatter", "bar", "area", "heatmap")
        if quantitative or "scale" in c:
            self.choice(c.get("scale"), path + ".scale", ("linear", "log"))
        domain = c.get("domain")
        valid_domain = (isinstance(domain, list) and len(domain) == 2
                        and all(number(v) for v in domain) and domain[0] < domain[1])
        if "domain" in c and not valid_domain:
            self.fail(path + ".domain", "must be [finite_min, finite_max] with min < max")
        if c.get("scale") == "log" and (not valid_domain or domain[0] <= 0):
            self.fail(path + ".domain", "log scales require a declared strictly positive domain")
        if "baseline" in c and not number(c["baseline"]):
            self.fail(path + ".baseline", "must be a finite number, not a boolean")
        if chart_type in ("bar", "area"):
            if c.get("scale") != "linear":
                self.fail(path + ".scale", "length and quantity-area encodings require a linear scale")
            if not number(c.get("baseline")) or c["baseline"] != 0:
                self.fail(path + ".baseline", "length and quantity-area encodings require baseline = 0")
            if not valid_domain or not domain[0] <= 0 <= domain[1]:
                self.fail(path + ".domain", "declare a domain that includes zero for length or quantity area")

    def data(self, value, path):
        d = self.obj(value, path, ("missing", "imputation", "summary_source", "series_identity", "series_key"))
        missing = d.get("missing")
        self.choice(missing, path + ".missing", ("gap", "explicit_state", "impute"))
        if missing == "impute":
            imputation = self.obj(d.get("imputation"), path + ".imputation", ("method", "rationale", "provenance", "visible"))
            for key in ("method", "rationale", "provenance"):
                self.text(imputation.get(key), path + ".imputation." + key)
            if imputation.get("visible") is not True:
                self.fail(path + ".imputation.visible", "imputed values must be visibly identified")
        elif "imputation" in d:
            self.fail(path + ".imputation", "imputation details require missing = impute")
        self.choice(d.get("summary_source"), path + ".summary_source", ("before_visual_decimation",))
        self.choice(d.get("series_identity"), path + ".series_identity", ("stable_id",))
        if self.text(d.get("series_key"), path + ".series_key"):
            if d["series_key"].strip().lower() in ("index", "array_index", "position", "rank"):
                self.fail(path + ".series_key", "array position or current rank is not a stable series identity")

    def interaction(self, value, path):
        i = self.obj(value, path, ("interactive", "keyboard", "touch", "drag_actions", "non_drag"))
        if not isinstance(i.get("interactive"), bool):
            self.fail(path + ".interactive", "must be a boolean")
        for key in ("keyboard", "touch", "non_drag"):
            if (i.get("interactive") is True and key != "non_drag") or key in i:
                self.text(i.get(key), path + "." + key)
        actions = self.strings(i.get("drag_actions"), path + ".drag_actions")
        if actions:
            if i.get("interactive") is not True:
                self.fail(path + ".interactive", "drag actions require interactive = true")
            self.text(i.get("non_drag"), path + ".non_drag")

    def contrast(self, value, path):
        if not isinstance(value, list):
            self.fail(path, "must be an array")
            return
        for index, pair in enumerate(value):
            p = f"{path}[{index}]"
            pair = self.obj(pair, p, ("name", "role", "foreground", "background", "font_size_px", "bold"))
            self.text(pair.get("name"), p + ".name")
            role = pair.get("role")
            valid = self.choice(role, p + ".role", ("normal_text", "large_text", "essential_graphics"))
            for key in ("foreground", "background"):
                color = pair.get(key)
                if not isinstance(color, str) or not re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})", color):
                    self.fail(p + "." + key, "use opaque #RGB/#RRGGBB; precompose alpha against its actual background")
                    valid = False
            if "bold" in pair and not isinstance(pair["bold"], bool):
                self.fail(p + ".bold", "must be a boolean")
                valid = False
            if "font_size_px" in pair and (not number(pair["font_size_px"]) or pair["font_size_px"] <= 0):
                self.fail(p + ".font_size_px", "must be a finite positive number")
                valid = False
            if role == "large_text":
                size = pair.get("font_size_px")
                if not number(size) or not (size >= 24 or size >= 56 / 3 and pair.get("bold") is True):
                    self.fail(p + ".font_size_px", "large text requires >=24 CSS px, or >=18.6667 CSS px and bold")
                    valid = False
            if valid:
                ratio = contrast_ratio(pair["foreground"], pair["background"])
                minimum = 4.5 if role == "normal_text" else 3.0
                self.contrast_results.append({"path": p, "ratio": round(ratio, 6), "minimum": minimum, "passes": ratio >= minimum})
                if ratio < minimum:
                    self.fail(p, "contrast ratio below required threshold; comparisons use the unrounded ratio")

    def run(self, value):
        root = self.obj(value, "$", ("format", "version", "time", "panels", "contrast_pairs", "evidence"))
        if root.get("format") != FORMAT:
            self.fail("$.format", "must be " + FORMAT)
        if type(root.get("version")) is not int or root["version"] != VERSION:
            self.fail("$.version", "must be integer 1")
        time = self.obj(root.get("time"), "$.time", ("synchronization", "timezone"))
        self.choice(time.get("synchronization"), "$.time.synchronization", ("timestamp",))
        self.text(time.get("timezone"), "$.time.timezone")
        panels, seen = root.get("panels"), set()
        if not isinstance(panels, list) or not panels:
            self.fail("$.panels", "must be a nonempty array")
            panels = []
        for index, panel in enumerate(panels):
            path = f"$.panels[{index}]"
            panel = self.obj(panel, path, ("id", "question", "metric", "chart", "data", "interaction"))
            identifier = panel.get("id")
            if self.text(identifier, path + ".id"):
                if identifier in seen:
                    self.fail(path + ".id", "panel IDs must be unique")
                seen.add(identifier)
            self.text(panel.get("question"), path + ".question")
            self.metric(panel.get("metric"), path + ".metric")
            self.chart(panel.get("chart"), path + ".chart")
            self.data(panel.get("data"), path + ".data")
            self.interaction(panel.get("interaction"), path + ".interaction")
        if "contrast_pairs" in root:
            self.contrast(root["contrast_pairs"], "$.contrast_pairs")
        if "evidence" in root:
            self.strings(root["evidence"], "$.evidence")
        warnings = ["Author declarations only; runtime behavior, screenshots, queries, and evidence references were not verified."]
        if not root.get("evidence"):
            warnings.append("No runtime evidence references supplied; runtime verification remains outstanding.")
        if not root.get("contrast_pairs"):
            warnings.append("No explicit contrast pairs supplied; contrast remains unassessed.")
        return {"valid": not self.errors, "scope": "declared-contract-only", "runtime_verified": False,
                "format": FORMAT, "version": VERSION, "errors": self.errors,
                "warnings": warnings, "contrast_results": self.contrast_results}


def validate(value):
    return Review().run(value)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) != 1:
            raise ValueError("usage: check_chart_contract.py FILE.json (or - for stdin)")
        raw = (sys.stdin.buffer.read().decode("utf-8") if args[0] == "-"
               else Path(args[0]).read_text(encoding="utf-8"))
        def reject_constant(value):
            raise ValueError("non-finite JSON constant is not allowed: " + value)
        def unique_object(pairs):
            result = {}
            for key, item in pairs:
                if key in result:
                    raise ValueError("duplicate JSON object key: " + key)
                result[key] = item
            return result
        value = json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_object)
        result = validate(value)
        code = 0 if result["valid"] else 1
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        result = {"valid": False, "scope": "declared-contract-only", "runtime_verified": False,
                  "format": FORMAT, "version": VERSION,
                  "errors": [{"path": "$", "message": "input error: " + str(error)}],
                  "warnings": ["Runtime verification was not performed."], "contrast_results": []}
        code = 2
    print(json.dumps(result, indent=2, allow_nan=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
