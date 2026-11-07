# Local dashboard polish — 7 November 2026

## Outcome and scope

Paprika Insights now has clearer KPI cards, more useful plotting space, readable legends, and more reliable compact/mobile layouts. This adapts the landing-page dashboard style to working analytical panels; it is not a pixel replica.

- Branch: `codex/local-dashboard-polish`, based on `f5fc0e3f`.
- Running gallery: <http://127.0.0.1:63154/dashboard/insights/?dashboard=local-gallery-edge-watch>.
- Select **Dark** and **Compact view** for the dense preview-style composition. Light and standard layouts were also checked.
- Nine dashboards and 78 saved queries use isolated local Prometheus, PostgreSQL, and Tempo providers. All observations are synthetic; company/inventory snapshots are seed-time examples.
- The session expires at 08:38 Melbourne time on 8 November 2026. Restarting the gallery harness creates a fresh session and document store.
- Production dashboards and services were not changed. Changes remain in this worktree.

## Material findings and remedies

| Finding | Change | Evidence |
| --- | --- | --- |
| Sparklines competed with headline values | Side sparklines are the default for newly authored stats and local gallery cards; existing explicit placements remain valid | Component/schema tests and real editor save/reopen checks |
| Legends consumed most of narrow chart panels | Reserve useful plot height, bound statistics tables, and keep series identities independently scrollable from chart actions | Independent 7/5-column fixture, keyboard scrolling, light/dark browser captures |
| Compact charts could hide their entire legend | Reserve a complete legend row and show a scroll hint | Edge Watch capture and compact-canvas assertions |
| Long gauge labels overlapped readings or blocked targets | Stack labels at narrow widths and let rows size to their content | Twelve gauge layouts, including 320px and extreme values |
| Gauge fill concealed values outside the authored scale | Keep exact readings and add an above/below-scale cue | Negative and over-scale test values plus browser inspection |
| Status timelines and record charts disagreed with table timestamps | Use the dashboard timezone consistently for ticks, inspectors, and range summaries | Melbourne dashboard in a UTC browser; exact underlying timestamps retained |
| Dense calendars clipped six-week months | Increase compact calendar row budgets | August six-week calendar in live compact-canvas tests |
| Long mobile descriptions displaced the dashboard | Put long descriptions in the keyboard-accessible Dashboard context disclosure | Six main dashboards, both themes, 390px captures and keyboard checks |
| Fleet Atlas left an unused three-column gap | Allocate the full row to node states and disk capacity | Desktop, tablet, and phone captures |
| The static production build rejected global chart animation selectors | Scope the selectors through the chart wrapper | Production build and chart entrance tests |

## Acceptance gates

| Gate | Status | Evidence and limits |
| --- | --- | --- |
| Analytical truth and numerical consistency | Pass for changed behavior | Exact gauge values, unknown history samples, timestamp alignment, provider queries, and bounded-result notices checked. No production metric or alert policy was changed. |
| Hierarchy and visual readability | Pass | Actual browser captures inspected across the six main dashboards at desktop, tablet, and phone sizes, in both themes. Smaller 320px cases covered gauges and legends. |
| Context and interaction fidelity | Pass for affected paths | Pinned inspection, chart zoom/reset, exact-data dialog, keyboard legend scrolling, filters, and destination updates exercised. |
| Accessibility and non-drag operation | Pass for affected controls | Keyboard pinning, context disclosure, visible focus, readable narrow axes, and gauge target geometry checked. This is not a complete assistive-technology audit or physical-device touch certification. |
| Resilience, authoring, and persistence | Pass for affected paths | Stat edit/save/reopen, unchanged saved layouts after compact viewing, missing data, explicit errors, truncated results, and 12-hour local session validation covered. |
| Measured performance and bounded resources | Unverified for performance | MCP checks confirmed bounded results and query deduplication; browser checks found no unexpected query failures or rate limits. No load benchmark or CPU/memory profile was performed. |

## Family and state coverage

| Family | Coverage | Remaining scope |
| --- | --- | --- |
| Stat and side sparkline | Both themes, narrow sizes, defaults, editor persistence, real local data | Existing authored background placements are preserved |
| Time series and statistics legend | Independent varied data, unequal series lengths, 7/5 panels, selected values, zoom/reset, keyboard scrolling, mobile | No new rendering family introduced |
| Linear and radial gauges | Long labels, nulls, negative and over-scale readings, pinning, 320–1600px layouts | Physical touch hardware not exercised |
| Status history and calendar | Unknown samples, Melbourne ticks, keyboard selection, six-week month, compact and stacked layouts | No status or aggregation semantics changed |
| Record charts and tables | Both themes at desktop/mobile, dual axes, annotations, complete bars, keyboard selection, local timestamps | Existing table/treemap algorithms retained |
| Maps, traces, and supporting panels | Live local rendering, dashboard interactions, theme/responsive capture, bounded provider results | Map camera and trace algorithms were not changed or fully re-audited |

## Executed validation

- Production UI build with webpack, TypeScript, changed-file ESLint, and `git diff --check` passed.
- Focused Vitest suites passed for schema/editor, chart entrance, compact shell, responsive layout, metric distributions, gauges, and record charts. The final record-chart run passed all 17 tests.
- Python seed validation: 13 tests passed. Go local harness validation: three tests passed, including session lifetime bounds.
- Dashboard polish browser suite: six light/dark desktop/tablet/phone cases passed, using independent deterministic observations.
- Gauge layout: 12 cases; legend layout: eight cases; status-history axes: four cases; compact stat editing: four cases; compact live canvas: eight cases; live chart footer: four cases — all passed.
- Record-chart browser suite passed desktop and mobile checks in both themes, with no page errors.
- Live gallery browser suite: 16 desktop board/theme cases passed. Six main dashboards also passed 24 tablet/phone captures, followed by 12 final phone captures with disclosure checks.
- All 78 saved queries were exercised with default and alternate filters. MCP bundle checks covered eight dashboards, 16 bundles, 154 widget results, deduplication, and explicit provider bounds.

Signal Kit deliberately includes error/empty/stale examples. Query Stress Lab deliberately produces bounded-result notices. These are visible demonstration states, not concealed failures. This validation does not claim that every repository test was run.

## Evidence packet

- Final Edge Watch screenshot: `/tmp/paprika-dashboard-polish/edge-watch-final.png`.
- Final Market Lens screenshot: `/tmp/paprika-dashboard-polish/market-lens-final.png`; chart ticks and record rows both show Melbourne time.
- Main-dashboard captures and reports: `/tmp/paprika-dashboard-polish/live/` and `/tmp/paprika-dashboard-polish/live-final/`.
- Deterministic dashboard/inspector captures: `/tmp/paprika-dashboard-polish/`.
- Additional browser reports/captures: `artifacts/insights/gauge-layout/`, `artifacts/insights/legend-layout/`, `artifacts/insights/record-charts/`, and `artifacts/insights/gallery-live-review/`.
- The once-run manual Impeccable check reported no findings for the changed visual owners.

## Local handoff

The static UI is served at <http://127.0.0.1:3015/>. The gallery proxy at port 63154 attaches its local credential server-side. Keep both servers and the local data containers running.

To restart the static UI, run from `ui/` after rebuilding when needed:

```sh
rtk npm run build -- --webpack
rtk proxy python3 -m http.server 3015 --bind 127.0.0.1 --directory out
```

To start a fresh gallery session, run from the repository root and use its newly printed loopback URL:

```sh
rtk proxy node --experimental-strip-types demo/insights-gallery/serve.mjs \
  --providers=/tmp/paprika-dashboard-polish-local/providers.json \
  --ui-url=http://127.0.0.1:3015/ \
  --ready-file=/tmp/paprika-dashboard-polish-ready-12h.json \
  --session-duration=12h
```

Provider credentials and the harness connection file are private and must not be committed. The local stack uses bind storage under `/tmp/paprika-dashboard-polish-local` because Docker's virtual disk was full; no unrelated Docker data was pruned. The gallery README documents startup and shutdown. Bind data is retained on shutdown, including with `--delete-data`, until the chosen state directory is explicitly removed.
