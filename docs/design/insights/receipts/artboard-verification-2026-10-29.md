# Rich chart verification, 29 October 2026

Dated evidence split out of [artboard-implementation.md](../artboard-implementation.md), which keeps the chart input contracts.

## Verification, 29 October 2026

The implementation passed 1,688 UI unit tests, TypeScript and the production webpack export. ESLint completed with no errors and nine existing warnings outside Insights. The dedicated chart suite is included in the existing CI browser job, with screenshots and diagnostics uploaded on failure. Its fixture import was also checked with CI's Node 22 runtime.

| Browser suite | Passed checks |
| --- | ---: |
| Rich charts, two themes and desktop/mobile | 26 |
| Existing widget audit | 206 |
| Responsive layout and tooltips | 8 |
| Builder | 13 |
| Saved-query tooltips through the Go service | 24 |
| Shared service filters through the Go service | 12 |
| Service persistence and provider adapters | 9 |
| Existing record charts | 2 |
| Total | 300 |

All eight suites reported zero browser errors. Four intentionally inapplicable widget-audit scenarios are excluded from the totals. The rich-chart suite changes an existing time-series widget to stacked areas and exercises continuous, segmented and radial gauge controls, then verifies saved-query bindings, shared filters and persistence after reload. Independent visual inspection verified the radial reading, axis labels, mobile legends, pipeline scroll controls and tooltip dismissal.

Browser testing found and fixed a measured-canvas remount on dashboard switches, clipped negative axis labels, cross-chart Escape interception, stale shared-cursor ownership, and hidden overflow affordances. The public example catalog is unchanged and test fixture expressions are absent from the production JavaScript bundle.

Evidence is under `artifacts/insights/rich-charts/`, including `implementation-validation.json`, `report.json`, `visual-review.md` and component screenshots. This is local implementation validation; no Omega deployment or new production-provider validation was performed in this pass.

## Reference-derived generation acceptance, 29 October 2026

The next acceptance pass uses the four supplied Grafana images directly. It generates four canonical bundles containing 56 saved-query-backed panels, imports them through the UI into an empty real Go service, and compares the resulting saved documents with the generated specification. Only telemetry responses are deterministic fixtures; authentication, provider discovery, conditional document writes and durable storage are real. These compositions remain test-only.

The reference suite passed all 14 checks: UI generation, eight desktop theme compositions, a real process restart, and four mobile layouts. It captured 14 images, resolved every shared-filter binding, preserved document ETags across restart and reported no browser or query-fixture errors. The final run persisted 60 documents. An earlier successful run recovered from an explicit 429 rejection; bounded client retries retained the exact body and write precondition. Separate transport tests verify that network failures, server errors and conflicts are not automatically replayed.

Screenshot review exposed and resolved overlapping heatmap bucket labels, clipped state-history lanes, incomplete host meter banks and overly tall table chrome. Regression assertions now require legible bucket labels, all six state lanes and meters, all five flow rows, useful time-series plot height, no tile overlap, and desktop compositions fitting the stated viewport. Tables expose row-density and search controls; gauge banks expose per-series radial or segmented meters.

Final verification: 1,739 unit tests; full TypeScript; production webpack export; ESLint with zero errors and nine existing warnings outside Insights; 14 reference-generation checks, 26 rich-chart interaction checks and two record-chart browser checks. The previous 300-check pass above remains a separate historical run. Final captures were independently compared with the source images. Statistics tables in legends and per-cell table meters remain documented visual approximations, and the network reference is a two-dashboard collage that intentionally scrolls.

Review `artifacts/insights/reference-dashboards/index.html`, its `generated-dashboard-bundle.json`, `report.json` and `visual-review.md`. This is local validation with test telemetry, not a new production-provider or Omega deployment claim.
