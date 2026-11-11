# Local dashboard design loop

Working directory: the repository's `ui/` directory. Build the production UI and open the disposable playground:

```sh
cd ui
npm run build
npm run review:insights
```

The browser opens **Service investigation**, linked to **Workload detail**. It uses real Insights document persistence in a temporary directory and deterministic synthetic chart responses. No cluster, production documents or live telemetry are involved. Keep this browser open while editing; closing it stops the local services and removes the temporary documents. Export a dashboard before closing if you want to retain an experiment.

The fixture includes long workload names, incomplete stacks, a missing latest observation, percentile gaps and stable metric colours. Edit **Request latency → Style → Chart appearance** to try Clean line, Soft area or Compare, then fine-tune the existing controls. These starting points change presentation only. A custom change clears the preset selection. Editing opens a focused chart workbench: the large preview and query stay beside its settings on desktop. Use local Undo/Redo, Apply changes to return with the staged edits, or Discard to restore the chart. Save dashboard keeps the applied changes durably.

The settings tabs stay on one row. Swipe, scroll horizontally with a trackpad, or use the scrollbar when the labels do not fit. Faded edges indicate more tabs. Arrow keys, Home and End select a tab and bring it into view. Scrolling alone leaves the selected panel unchanged.

Opening Workload detail directly starts with a second service, `payments-worker`, and a six-hour range. Following a link from the overview selects `checkout-api` and the overview's one-hour range for that visit. Both ranges are fixed so the playground remains reproducible on later dates.

Inspect a point with hover or arrow keys, press Enter to pin, then follow **Inspect workload**. The selected value and service travel with the time range; the destination's saved defaults stay intact. The stacked CPU inspector offers the same named action, with the workload label included. Missing values disable links that require a numeric reading. Source details retain the original identity, labels, unit and exact value.

Run the repeatable acceptance loop against the production export:

```sh
npm run test:e2e:polish
```

The 37 checks cover desktop (1512px), tablet (768px) and mobile (390px), light/dark themes, keyboard and emulated touch, exact historical drilldowns, missing observations, provider-order changes, query-free style preview, invalid input, Undo/Redo, save/reload and service-restart persistence. The mobile menu checks also resize to 320px to test an overflowing strip, touch swipes and recovery when widened. Screenshots and `report.json` are written under `artifacts/insights/local-polish/after/`. `INSIGHTS_POLISH_OUTPUT` overrides that directory. Physical touch devices and production are separate verification steps.

For rapid UI iteration, start the regular development server separately and set `INSIGHTS_E2E_URL` to its loopback URL when running either command. The disposable harness serves the UI through that server while retaining its own authentication, documents and query fixtures. Finish with a production build and the acceptance loop so development styling does not stand in for release behaviour.

For the Edge Watch and Reliability Room compositions, start the isolated provider stack and gallery described in `demo/insights-gallery/README.md`. Select Dark and Compact view to compare with the demo artboards; check light and phone layouts as well. The gallery provides synthetic Prometheus, PostgreSQL and Tempo observations through real local providers.

With the production export served and the gallery running, repeat the proportion and interaction checks from the repository root:

```sh
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port> \
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<gallery-port> \
node ui/e2e/insights-chart-footer-live.e2e.mjs
```

This checks five widths (1592, 1512, 768, 390 and 320px) in both themes: useful plot heights, all three outcome identities, keyboard scrolling, recorded-event timestamps, unchanged plots when opening events, pinned inspection, zoom/reset and unchanged saved documents. Captures and measurements go to `artifacts/insights/local-polish/demo-refinement/`. The independent `insights-rich-charts.e2e.mjs` fixture suite covers six other compositions, sparse histories, long provider labels, filtering and saved configuration.

## Shared chart styling and editing regression checks

Run `node e2e/insights-chart-system.e2e.mjs` from `ui/` against the local export (`INSIGHTS_E2E_URL`, default `http://127.0.0.1:3015`). Its deterministic 500-record fixture covers geographic hexes, honeycombs, tables and connection maps in both themes, three widths and both view/edit states. It checks full map bounds, complete desktop honeycomb fitting, touch access to both ends of the honeycomb, readable table rows, paging and missing-value inspection. Review every family capture in `artifacts/insights/chart-system`; geometric assertions do not replace visual judgment.

Run `node e2e/insights-edit-performance.e2e.mjs` separately, with no concurrent build or browser tests. Use a production export for performance conclusions. The workload has 12 panels, 500-record maps and eight time-series plots with eight series of 2,000 raw samples. Both normal and reduced motion are measured. The report distinguishes frame intervals, pointer-event-to-next-animation-frame latency (a scheduling proxy, not measured pixel presentation), long tasks and script/style/layout time. `editMs` and `focusedEditorMs` include the automation round trip and readiness checks; they are not input-to-paint latency. Timing is diagnostic across hardware. No extra queries, no accidental hover inspectors, real changed drops, no chart subtree reattachment, retained focus, native handle selection and zero reduced-motion transitions are regression gates. The same run resizes a panel, releases outside its original bounds, opens an inspector, saves and reloads the resulting dimensions. It then opens the focused editor, verifies that only the selected chart is mounted with no new query, and returns to all 12 panels. `INSIGHTS_PERF_OUTPUT` can isolate an experiment's report and captures.

Run `node e2e/insights-tooltip-structure.e2e.mjs` for the shared inspector anatomy. It measures actual text gutters, alignment, horizontal overflow and viewport clearance across six families in light/dark at 1512, 768 and 390px. It also exercises long record identifiers, unknown values, exact metric readings, expanded metadata, history, mobile minimization and dismissal. Review the images in `artifacts/insights/tooltip-structure`; geometry alone cannot establish readability. The CI browser smoke runs all three scripts and retains their evidence with the other Insights artifacts.


## Focused chart editor

Run `node e2e/run-insights.mjs e2e/insights-editor-focus.e2e.mjs` from `ui/` with `INSIGHTS_E2E_URL` set to the local production export. This exercises both themes at 1512, 768 and 390px: one-chart focus, retained query data, staged changes, invalid drafts, undo/redo, guarded Back, nested Escape, focus restoration, explicit save/reload, and map/honeycomb/table settings. Captures and measurements are under `artifacts/insights/editor-focus/`. The generated layout concepts in `output/imagegen/` are design exploration; the browser captures are the implementation evidence.


## Agent authoring against the gallery stack

`review:insights` starts its own disposable harness, and an agent cannot attach to it.
Use the gallery stack instead. Its harness (`demo/insights-gallery/serve.mjs`) serves the
browser proxy and the `/observe/mcp` endpoint from one Insights document store, so a
document an agent writes appears on the gallery page after a reload. Everything here uses
synthetic providers, and production is not involved.

1. Start the gallery as `demo/insights-gallery/README.md` describes: `python3
   demo/insights-gallery/start.py` (Docker), the loopback UI server, then the harness with
   `--ready-file=artifacts/insights/gallery-ready.json`. Run all of these from the
   repository root. Wait until the ready file exists.

2. Attach the agent. This block sets all of its own paths, so it runs in any shell. Working
   directory: the repository root.

   ```sh
   receipt=artifacts/insights/gallery-ready.json
   state=$(node -p "require('$PWD/$receipt').state")
   mcp_url=$(node -p "require('$state/private-connection.json').mcpURL")
   token=$(node -p "require('$state/private-connection.json').mcpWriteToken")
   claude mcp add --transport http paprika-gallery "$mcp_url" --header "Authorization: Bearer $token"
   ```

   `state` is an absolute path, so the block works from any shell in the same repository.
   `mcpWriteToken` can create and update documents. For read-only checks, read
   `mcpViewerToken` from the same file instead. Do not print the token into shared logs.

3. Open the gallery page at the receipt's `url` field and reload it after each agent write.

Restarting the gallery or the harness changes the port and the signing secret, so the agent's
configuration becomes stale. Remove the entry and repeat step 2:

```sh
claude mcp remove paprika-gallery
```

The token lifetime is set by `--session-duration` on the harness command (default one hour,
at most 24 hours). When it expires, restart the harness, then repeat step 2.

The `paprika-plugins` installer cannot target this endpoint. It always installs the production
Observe package with its OAuth configuration.
