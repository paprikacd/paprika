# Chart review manifest v1

Use this optional manifest to catch contradictions in an author's declarations before implementation or review. **It is not Paprika's dashboard schema, API contract, configuration format, or runtime authoring format.** Do not send it to Paprika services or replace an existing dashboard model with it.

## Run the check

From this skill's directory:

```bash
python3 scripts/check_chart_contract.py assets/chart-contract.example.json
python3 scripts/check_chart_contract.py path/to/chart-review.json
python3 -m unittest discover -s scripts -p 'test_check_chart_contract.py' -v
```

Use `-` in place of a file path to read JSON from stdin. Both paths require strict UTF-8 input. Python's standard library is sufficient. The checker writes JSON to stdout and exits `0` for consistent declarations, `1` for declaration failures, or `2` for an unreadable/malformed input or invalid command invocation. Duplicate JSON keys, non-finite constants, and unknown fields are rejected. All errors have a JSON-style field path. The checker performs no network calls or mutations.

Every result contains `scope: "declared-contract-only"` and `runtime_verified: false`. A passing result is **not** evidence that the query, browser interaction, accessibility, visual output, or performance works. Evidence references are recorded as declarations only; the checker neither opens nor verifies them. Missing evidence does not become a runtime pass. Maintain the actual verification report separately.

## Root object

| Field | Contract |
|---|---|
| `format` | Exactly `"paprika-chart-review"`. |
| `version` | Integer `1`; a boolean is invalid. |
| `time` | `{ "synchronization": "timestamp", "timezone": "UTC" }`; use a named timezone appropriate to the investigation. The timezone is checked for nonempty text only, not resolved against a timezone database. |
| `panels` | Nonempty array of panel declarations below. IDs must be unique. |
| `contrast_pairs` | Optional array of explicit opaque color pairs. Omission means contrast is unassessed. |
| `evidence` | Optional array of nonempty evidence references. References are not fetched, interpreted, or verified. |

## Panel object

Require `id`, `question`, `metric`, `chart`, `data`, and `interaction`. The question must state the user decision the panel helps answer. The string checks cannot judge the quality of that decision; review it manually.

### Metric

| Field | Contract |
|---|---|
| `kind` | `counter`, `gauge`, `histogram`, `summary`, or `ratio`. This identifies the underlying semantic input. |
| `statistic` | `value`, `rate`, `percentile`, or `ratio`. A cumulative counter can validly use `value`; rate rules apply only when a rate is represented. |
| `unit`, `display_unit`, `scale` | Unit of the canonical **query result after semantic aggregation**, displayed unit, and multiplicative display conversion. Thus a request counter rendered as throughput uses `requests/s` here. Equal unit names require `scale: 1`. Booleans and non-finite numbers are invalid. |
| `aggregation` | `none`, `sum`, `mean`, `min`, `max`, `distribution_then_quantile`, or `ratio_of_sums`. This describes aggregation across contributing series, not visual downsampling. |
| `rate_order` | Require `before_aggregation` when a counter/counter histogram rate is aggregated. A single series with `aggregation: none` can omit it. |
| `percentile` | Require a number from `0` to `1` for percentile statistics, such as `0.95`. Only `none` or `distribution_then_quantile` is permitted; summary quantiles allow only `none`. Averaging percentiles fails. |
| `denominator` | For ratio metrics, require `{ "missing": "unknown", "zero": "unknown" }`, with `error` also permitted for either policy. Both `kind` and `statistic` must be `ratio`. Aggregate with `ratio_of_sums` or use `none` for an already authoritative ratio. |
| `precision` | Require integer `decimals` and `supported_decimals`, each `0`–`12`, in **display units**. Display decimals must not exceed declared support. This only checks consistency of the author's precision claim. |

Known conversions cover `seconds`, `milliseconds`, `microseconds`, `nanoseconds`; `bytes`, `KiB`, `MiB`, `GiB`; and `ratio`, `percent`. The checker verifies their dimensions and conversion factors. Other unit names such as `requests/s`, `cores`, or `jobs` are accepted unchanged with scale `1`. An unsupported conversion must retain base units or extend the small reviewed registry; do not mislabel units to bypass the check. Non-multiplicative conversions are outside v1.

For a percentile query, this format checks that distributions are merged before quantiles. It does **not** parse PromQL or prove that counter histogram buckets use `rate()` before their aggregation. Verify the query independently. A chart of the maximum of existing p95 values requires an explicit semantic label and separate review; do not describe it as an aggregate p95.

### Chart

Require `type`: `line`, `scatter`, `bar`, `area`, `heatmap`, `stat`, `table`, or `state_timeline`. Quantitative charts also require `scale: "linear"` or `"log"`. In this manifest `area` means a filled **quantity-area** chart; a confidence band is not that encoding.

`domain`, when provided, is `[minimum, maximum]` with finite increasing values **in display units**. A line/scatter chart may have a nonzero domain. Log scales require an explicit strictly positive domain. Bars and quantity-area charts require a linear scale, `baseline: 0`, and an explicit domain including zero. Signed domains such as `[-20, 80]` are valid. Do not describe interval bands, floating intervals, or state timelines as quantity bars to fit this simplified vocabulary; review unsupported encodings separately.

### Data semantics

Require the following fields:

```json
{
  "missing": "gap",
  "summary_source": "before_visual_decimation",
  "series_identity": "stable_id",
  "series_key": "labels.service"
}
```

`missing` permits `gap`, `explicit_state`, or `impute`. Imputation additionally requires an `imputation` object containing nonempty `method`, `rationale`, `provenance`, and `visible: true`. This permits justified imputation, including a domain-defined zero, while rejecting concealed zero filling. The author must still prove the source semantics and visibly distinguish imputed values in the actual chart. A true measured zero should remain ordinary data.

`summary_source` must be `before_visual_decimation`; KPI values and semantic summaries cannot derive from the selected display points. `series_identity` must be `stable_id`; `series_key` identifies a stable entity key. Obvious positional keys `index`, `array_index`, `position`, and `rank` are rejected. Actual stability and cross-panel color continuity still require runtime testing.

### Interaction

Require a boolean `interactive` and a `drag_actions` array of nonempty descriptions, which can be empty. Interactive panels require nonempty `keyboard` and `touch` descriptions. If any drag action exists, also require a nonempty `non_drag` description of an equivalent **single-pointer** path, such as start/end inputs or click controls. Keyboard support alone does not establish the non-drag pointer alternative. A static panel uses `interactive: false` and `drag_actions: []`.

## Optional contrast pairs

Each pair requires `name`, `role`, `foreground`, and `background`. Roles are `normal_text` (minimum 4.5:1), `large_text` (3:1), and `essential_graphics` (3:1). Large text additionally needs `font_size_px` of at least `24`, or at least `56 / 3` (18⅔) with `bold: true`. These thresholds follow [WCAG 2.2](https://www.w3.org/TR/WCAG22/); mark only qualifying elements with the large-text role.

Use opaque `#RGB` or `#RRGGBB` sRGB colors. CSS variables, names, alpha hex, and `rgba()` are rejected. Supply the **precomposited visible color against the actual background** when opacity is involved. Inspect each relevant theme, state, and background separately. For a required boundary between adjacent regions, supply that adjacent color pair; checking only against the panel background is insufficient.

Comparisons use full-precision contrast ratios, never rounded display values. Invalid font size or weight qualification produces an error without a passing contrast sub-result. Quiet decorative gridlines need not be labelled essential graphics merely to satisfy a numerical checklist. Chart meaning, overlapping marks, color-only encoding, focus behavior, and non-text alternatives require separate inspection.

## Limits and extension

This is a small contradiction detector, not an exhaustive chart type system or an accessibility certification tool. It cannot establish truthfulness of declared rationale, source support, stable identity, imputation provenance, interaction descriptions, or evidence references. Use actual fixture data, query assertions, rendered inspection, keyboard and touch checks, and measurements for those claims. A legitimate unsupported design calls for documented manual review or a versioned extension, never fabricated declarations to obtain a pass.
