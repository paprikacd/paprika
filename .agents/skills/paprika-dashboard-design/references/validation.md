# Validation and acceptance

## Contents

- Evidence layers and severities
- Required acceptance matrix
- Adversarial fixture use
- Fixture and inspector regressions
- Family coverage and geographic acceptance
- Repository validation
- Visual review and finish

## Evidence layers and severities

Keep four evidence types separate:

1. **Declared contract:** a written question, metric, encoding and interaction plan. The bundled checker can catch contradictions here.
2. **Executable semantics:** actual query/adapter calculations tested against known observations and boundaries.
3. **Rendered behavior:** browser inspection and tests of the real app, controls, state, themes and dimensions.
4. **Measured operation:** actual performance, live provider behavior or persistence evidence for the tested environment.

A lower layer never proves the higher layers. An accurate fixture does not prove that a production query returns those observations. A manifest declaring keyboard support does not prove the interaction works. A screenshot does not prove Save or cancellation.

Classify findings:

- **Blocker — truth:** wrong units/aggregation, invented observations, misleading coverage, incorrect scale/geometry, or resize-dependent semantic numbers.
- **Blocker — operation:** an essential investigation path fails; inaccessible primary operation; wrong scope/time; stale response shown as current; lost draft or broken persistence.
- **Major — reading:** the main question cannot be answered because of illegibility, overlap, ambiguous labeling, or unusable layout.
- **Minor — craft:** a noncritical alignment, spacing, or consistency issue without a material interpretation/action consequence.

Do not report “pass” with unresolved blockers or major issues for the affected scope. Keep unrelated pre-existing problems clearly identified and avoid unsolicited migrations.

## Required acceptance matrix

Apply the relevant rows, record non-applicable rows with a reason, and report unexecuted checks as unverified.

| Area | Test | Passing evidence |
| --- | --- | --- |
| Metric identity | Query/metadata and renderer contract agree | Kind, population, grouping and unit are documented and tested |
| Conversion | Known base value and thresholds | Example: 0.125s appears as 125ms after one conversion everywhere |
| Counters | One replica resets while another increases | Rate calculated before aggregation; no concealed reset artifact |
| Ratios | Unequal denominators and zero traffic | Population-weighted ratio; explicit undefined/no-traffic policy |
| Percentiles | Compatible histogram vs per-instance p95 | Aggregate distribution used; no average of percentiles |
| Buckets | Known cumulative/nonmonotonic bucket inputs | Exactly one cumulative-to-disjoint conversion; invalid input surfaced |
| Missingness | Internal gap, missing tail, absent series, true zero | Distinct outcomes; no fabricated healthy/zero observation |
| Sampling | Narrow breach/trough, gap and endpoints | Required extrema/gaps visible; semantic statistics use full result |
| Synthetic cadence | Split a known fixture bucket into finer observations | Exact count/outcome conservation; duration-aware rate accounting; stated cadence; no invented provider data |
| Snapshot identity | Compare overlapping refresh windows | Same entity/timestamp retains its observation; resolved event bounds and missing intervals stay fixed |
| Resize invariance | Same fixed source/window at narrow/medium/wide panel widths | KPI, threshold outcome and summaries equal within stated numerical tolerance |
| Series identity | Reorder, filter, top-N and refresh | Explicit or stable identity colors remain assigned to the same entities |
| Scale | Zero/negative/outlier/log/threshold cases; resize/zoom | Honest baseline/domain, visible clipping and valid log handling; grid/ticks/selection use the same actual scales |
| Time alignment | Different sampling intervals and late-starting series | Same timestamp maps coherently; real sample offsets remain visible |
| Time-window brush | Forward/reverse drag, tiny click, cancel, empty window, exact input, undo/reset and source replacement | Scale-derived UTC bounds, explicit local/shared scope, no accidental pin, stale gesture cleanup and reachable recovery |
| Responsive composition | Source-size reference, tablet, narrow panel and small viewport/text zoom | Reflowed hierarchy, readable type, recomputed plot/ticks and reachable inspector; panel bounds contain all chart content without sibling overlap; unchanged semantic summaries |
| Inspection | Hover, focus, pin, touch, Escape, refresh | Correct sample/value; collision handling; transient blur cleanup, reachable unpin, preserved keyboard focus, stale observation invalidation |
| Embedded history | Full-coverage and gapped fixtures; non-integer min/max | No artificial missing boundary samples; explicit nested precision; stable series colors and exact-data access |
| Navigation | Drilldown, Back/reset, shareable view | Relevant time/filters preserved; destination document unchanged |
| Accessibility | Keyboard, non-drag pointer, focus, text/mark contrast, equivalent data | Core task completed; readable and semantically equivalent evidence |
| Resilience | Loading, empty, null, partial, failure, missing plugin | Stable geometry, explicit state, local recovery |
| Authoring | Guided controls, JSON/YAML/OpenUI, undo/redo, Save/reload | One schema and actual behavior; validation and draft preservation |
| Request behavior | Style edit, rapid query changes, tooltip dismissal | No unnecessary requests; obsolete work cancelled/ignored |
| Performance | Representative workload and sustained refresh | Measured budget/result with environment; bounded marks/requests/memory |
| Motion | Interrupted update, reduced motion, unmount and live refresh | Latest state wins; no fictional values, overshoot, repeating delay or leaked animation work |
| Effects | Multiple widgets, theme switch, gradient/mask/clip resources | Unique stable IDs; correct local theme; readable marks and meaningful layering |
| Renderer parity | SVG/Canvas or library adapter change | Consistent values, hit testing, selected timestamps, clipped bounds and accessible alternatives |

## Adversarial fixture use

`assets/adversarial-fixtures.json` provides small deterministic inputs, not a replacement query engine or expected output for every metric. Adapt them through the **actual** transformation owner. Do not test a second reimplementation and assume that proves the product. Their timestamps are explicitly Unix seconds; convert to the runtime chart model's milliseconds at the correct adapter boundary.

Use explicit expected observations:

- **Units:** a 0.125 second value with a 0.2 second threshold becomes 125ms and 200ms.
- **Population weighting:** 1/10 and 9/990 error/request counts produce 10/1000 = 1%, not the average of 10% and approximately 0.909%.
- **Counter reset:** one cumulative series drops from 110 to 5 while another continues. Test the real rate query semantics; simple hand differencing is not a complete Prometheus `rate` oracle.
- **Cumulative buckets:** counts 2, 5, 9, 10 imply disjoint counts 2, 3, 4, 1. Do not derive an exact p95 from this tiny example without choosing the interpolation model.
- **Null tail:** `[4, 7, null]` has historical latest-finite 7 but no current final sample. Name both correctly.
- **Extremum:** many values of 10 with one 250 breach must not become an apparently safe flat trend after reduction.
- **DST:** UTC instants around the Melbourne spring transition remain ordered; the local clock skips an hour. Verify timezone conversion using a maintained timezone library, not a fixed offset.

Extend only for concrete risks: duplicated timestamps, fractional/negative values, NaN/Infinity rejection, out-of-order arrival, very large identifiers, long text, multiple null spans, unusual buckets, or mixed units. Define the application's chosen policy rather than silently guessing.

Use meaningful numerical tolerances derived from units/algorithm. Do not assert exact floating-point equality for operations where rounding or source estimators legitimately differ; do not choose a broad tolerance that hides a wrong unit.

## Fixture and inspector regressions

Add focused checks at the actual calculation/state owner for the applicable risks:

- Compare two overlapping snapshots by absolute entity/timestamp keys. Historical values, incident starts, resolved ends, deployments, and missing spans must not move when the window advances. An active incident may extend only under its stated policy.
- For a one-minute fixture refined into six ten-second observations, verify exact request/outcome totals and duration-aware rate accounting. Recheck every dependent KPI, stack, share, and event total. Never use fine-grained synthetic observations as evidence of real provider cadence.
- Inspect a complete-coverage series and a real gap in the embedded history. Null anchors added only for plot extent must not increase the missing count. Remove artificial observations or use a supported domain/reference source; do not fix the footer by hiding genuine missingness or filling it with zero.
- Verify selected value, min/max, latest value, units, and exact details with fractional fixtures. Set `tooltipView.decimals` explicitly when needed; parent `widget.options.decimals` does not establish nested history precision. Test rounding only at display boundaries.
- Exercise keyboard focus → transient inspection → blur, and focus → pin → blur → Escape/clear. Blur clears transient state while a deliberate pin persists; dismissal retains usable keyboard focus. Scope/result replacement clears stale pins; theme and size changes preserve semantic result identity.

For narrow layouts, inspect the actual panel rectangle and computed rule winning at that size; a declared container rule can lose to a more specific layout class. Label desktop constrained-panel evidence accurately. It does not establish physical touch-device behavior.

## Family coverage and geographic acceptance

Use [chart families](chart-families.md) to record every selected visual's actual owner, support level, input/configuration, variants and evidence. Verify a clean application entry, not a registry populated by previously visiting an unrelated route. Exercise the actual renderer with ready, selected, relevant missing/empty and constrained-width states. A static reference fixture or source file cannot establish a registered reusable capability.

For promotion from a replica, use an independent dataset. Change entity order, labels, value range, cadence or geography and panel width. Preserve semantic summaries, stable identities, units and relevant visual relationships. Reject reference-only index scales, fixed inspectors, arbitrary jitter or illustrative accounting in the analytical example. Check that the family emits the context its consumers require; do not infer timestamps or IDs from a label/value-only event.

For maps, apply [the geographic acceptance cases](geographic-charts.md#validate-the-interaction-and-transfer): finite coordinates and viewport transforms, off-centre anchor preservation, min/max zoom, pan boundaries, exact reset, scaled-artboard coordinate conversion, selection after zoom/filter/replacement, keyboard and non-drag controls, page-scroll/browser-zoom arbitration, independent instances and omitted-location disclosure. Distinguish pure transform tests from browser gesture evidence; record physical touch as unverified unless exercised.

## Repository validation

First read current `ui/package.json`, `docs/design/insights/premium-ui.json`, and relevant repository instructions. Select transformation/component/E2E checks that cover the change; also run required project gates. Use the actual package manager and scripts declared there.

Useful existing test areas at the inspected snapshot:

- `chart-data`, `numeric-precision`, `chart-cursor`, and `charts` tests.
- `plugins/rich-metrics-data.test.ts` for aligned stacks, gaps, original values and histograms.
- Registry/config and schema-artifact tests for changes to capabilities or documents.
- `responsive-layout` tests for viewport projection without document changes.
- `query` and tooltip tests for cancellation and stale result isolation.
- `ui/e2e/run-insights.mjs` and selected `insights-*.e2e.mjs` suites for real rendered behavior.

Resolve complete paths in [the integration map](paprika-integration.md). Do not blindly paste stale commands. Record exit codes and scope. If a test cannot run because the environment lacks a service or dependency, report what is missing and complete independent checks. Do not equate “test file exists” with “test passed.”

For this skill's own tooling:

```sh
python3 <skill-dir>/scripts/check_chart_contract.py <skill-dir>/assets/chart-contract.example.json
python3 <skill-dir>/scripts/test_check_chart_contract.py
```

These validate the review-side tool. They do not execute Paprika or establish its current quality.

## Visual review and finish

Use a bounded batch of real captures with deterministic data. Cover supported themes, desktop composition, a narrow widget, small viewport, long labels/dense legend, active inspection, and at least one relevant degraded state. Verify the captures actually show settled content and the intended state.

Inspect at actual size and enlarged detail: clipping, tick collision, contrast, plot-area alignment, overlay placement, focus, and chart-to-chrome balance. Pair screenshots with keyboard/pointer checks, not just screenshot differences.

For the bundled dashboard references, follow [reference fidelity](reference-fidelity.md): inspect the actual images and compare both settled and selected states. Use exact canvas dimensions and registered comparison for literal reproduction; use explicit composition budgets for adaptation. Do not invent measurements from a thumbnail or claim pixel equality without a valid method. Verify that concept-art scales and accounting have not replaced the analytical metric contract.

Review the six craft dimensions in [visual craft](visual-craft.md) through observed findings, not a numerical beauty score. Fix material findings as a batch and confirm once. Additional work should address a concrete failure, mandatory gate, or explicitly requested design iteration.

Complete the report with pass/fail/unverified/not-applicable evidence and precise remaining limits. If reviewing a proposal without runtime access, deliver a useful design/source review and call the rendered gates unverified. Never promote a declarative checker success into “production ready.”
