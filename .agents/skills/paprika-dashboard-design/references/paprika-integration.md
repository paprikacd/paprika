# Paprika integration map

## Contents

- [Refresh the baseline](#refresh-the-baseline)
- [Find the canonical owner](#find-the-canonical-owner)
- [Distinguish built-ins from plugins](#distinguish-built-ins-from-plugins)
- [Preserve authoring and interaction behavior](#preserve-authoring-and-interaction-behavior)
- [Check implementation hazards](#check-implementation-hazards)
- [Select validation](#select-validation)
- [Primary sources](#primary-sources)

## Refresh the baseline

This map was inspected on 2026-10-30 at Paprika `master` commit `bb52aed8ded8beb08534f6b190a3e7f37c1b19d8` (committed 2026-10-29). It is a source snapshot, not a claim of rendered verification. Re-read the current repository's `AGENTS.md`, root `DESIGN.md`, `docs/design/insights/UX-CONTRACT.md`, relevant runtime contracts and package scripts before implementation. Inspect relevant active work before editing shared owners. Prefer current verified code over stale examples; surface contradictions with maintained product contracts.

Target `/dashboard/insights` unless the request identifies another surface. Root `DESIGN.md` covers this independently themed Gamma workspace; `.impeccable.md` describes a separate main-app direction. Do not spread an Insights palette change across the main shell. The audience is DevOps/platform engineers performing operational work. Reference screenshots and generated artboards inform hierarchy and craft; they do not establish data, available features or permission to invent observations.

At this revision, Insights uses Next.js 16.2.7, React 19.2.4, `@tanstack/charts` 1.1.0, d3-shape 3.2.0, react-grid-layout 2.3.0, Zod 4.6.7, Vitest 4.1.9 and Playwright 1.61.1. Recheck installed versions; avoid introducing another chart library by default.

## Find the canonical owner

Paths below are relative to `ui/src/features/insights/` unless qualified.

| Capability | Canonical owner | Integration rule |
| --- | --- | --- |
| Dashboard and result types | `schema.ts` | Validate the current document and normalized result shapes; do not author from a copied schema. |
| Portable schema | `docs/design/insights/dashboard.schema.json`; `schema-artifacts.test.ts` | Preserve generation and drift checks when changing the runtime contract. |
| Service validation | `internal/insights/schema.go`, `schema_extensions.go`, `types.go` | Update backend acceptance with frontend schema changes. |
| Widget lifecycle | `charts.tsx` | Retain the shared pending, failure, empty, unavailable-plugin, truncation and renderer-boundary behavior. |
| Built-in visualization | `chart-renderers.tsx` | Extend the existing renderer rather than duplicating its chart/inspection shell. |
| Numeric transforms | `chart-data.ts`; plugin `*-data.ts` modules | Keep calculations independent of drawing and calculate summaries before display sampling. |
| Trusted renderer registry | `widget-registry.tsx` | Declare data kind, validated configuration and actual control capabilities. |
| Bundled plugin installation | `plugins/threshold-gauge.tsx` | Extend the existing `registerDefaultWidgetPlugins()` composition. |
| Theme and UI | `gamma/gamma-theme.module.css`; shared `gamma/` controls | Consume the scoped adapter for light/dark/system colors, typography, surfaces, focus and portals. |
| Plot selection | `chart-cursor.tsx`, `plot-tooltip.tsx`, `metric-inspector.tsx` | Share exact timestamps; preserve hover/pin/dismiss and stale-result invalidation. |
| Tooltip sub-widgets | `tooltip-editor.tsx`, `tooltip-query.tsx`, `tooltip-widgets.tsx` | Keep query-backed inspection explicit, cancellable and bounded. |
| Data requests | `query.ts`, `client.ts` | Use the host scheduler and normalized results; renderers do not fetch or evaluate source text. |
| Draft editing and saving | `insights-app.tsx`, `history.ts` | Keep draft history, explicit persistence and conflict recovery coherent. |
| Responsive placement | `responsive-layout.ts` | Project saved layout into available width without modifying the document. |
| Drilldown and sharing | `drilldown.ts`, `widget-context.ts`, `workspace-transfer.ts` | Carry deliberate observation/time/filter context without replacing destination defaults. |

## Distinguish built-ins from plugins

The current persisted built-in types are `timeseries`, `bar`, `stat`, `table`, `traces` and `heatmap`. `heatmap` is a latest-sample status visualization, not a distribution histogram. A trace list does not establish waterfall support.

Rich renderers are persisted as `type: "plugin"`, with a registered `pluginId`, explicit `dataKind` and bounded `config`. They are not new values in the built-in type enum.

| Plugin family | Verified IDs | Source |
| --- | --- | --- |
| Rich time series | `stacked-timeseries`, `directional-traffic`, `distribution-heatmap` | `plugins/rich-metrics.tsx`, `rich-metrics-data.ts` |
| Capacity | `threshold-gauge` | `plugins/threshold-gauge.tsx` |
| Shares and states | `pie`, `status-history` | `plugins/metric-distributions.tsx` |
| Typed record charts | `records-line`, `records-bar` | `plugins/record-charts.tsx` |
| Operational records | `connection-map`, `pipeline-topology`, `incident-calendar` | `plugins/operational-records.tsx` |

Discover the complete current registry; this table is not an exhaustive permanent catalog. Reuse an existing renderer when it expresses the data truthfully. For a new trusted plugin:

1. Define its question, input semantics, empty/missing/error behavior and resource bounds.
2. Implement pure transforms and a renderer accepting `WidgetRendererProps`; handle readonly `embedded` mode and deliberate `onContextChange` consistently.
3. Register a unique ID with the correct `dataKind`, `parseConfig`, usable defaults and authoring fields. Expose only style controls the renderer implements.
4. Wire its registration into the bundled installer; verify editor discovery and document import/export. Keep configuration within the host envelope, currently 16 KiB and eight nesting levels.
5. Check schema generation, backend validation and authoring metadata whenever the accepted document contract changes. Check the separate tooltip allowlist before claiming embedded compatibility.
6. Add data fixtures, targeted component coverage and an end-to-end composition through the real authoring surface. Never load code from a dashboard document.

## Preserve authoring and interaction behavior

- Canvas editing, JSON/YAML and OpenUI resolve to one versioned dashboard document. Keep source imports as data; do not evaluate generated JavaScript or HTML.
- Valid changes update the draft. Query edits currently coalesce for 350 ms and cancel superseded work; presentation changes do not refetch. Invalid edits retain the last valid preview and block saving while invalid.
- `Save dashboard` persists the draft. Preserve Undo/Redo, draft retention on failures and conditional-write conflict behavior. Resizing the viewport and applying drilldown view parameters are not document edits.
- Saved placement uses twelve columns. Current responsive projection uses wide mode from 960px, compact mode from 600px and stacked mode below 600px. The inspector remains a non-drag layout alternative.
- Hover is transient; click/tap or Enter pins inspection; Escape dismisses it. A result refresh clears stale selected observations and cursors, including pinned observations. Do not silently preserve a pin against a new result or retarget it by array index.
- Keep a selected historical observation distinct from the latest history value. Details-only inspection makes no additional request. Explicit query-backed tooltip widgets use the host scheduler, cancel on dismissal/switch, reject missing bindings locally and mask stale responses.
- Embedded widgets are bounded and readonly, without nested tooltip, inspector or drilldown actions. Preserve scoped theme inheritance for portalled content.
- Keep source identity and configuration in authoring/inspection or actionable failure UI. Ordinary widget chrome prioritizes title, data and meaningful actions.

Compose with the existing `paprika-observe` skill for live discovery, provider-specific querying and authorized document operations. It lives at `plugins/paprika/skills/paprika-observe/SKILL.md` and in the standalone Observe plugin. Discover real provider capabilities, metric metadata, labels and returned samples before designing queries. Observe read access and Insights write access are distinct. Do not infer dashboard visualization support from gateway query support.

## Check implementation hazards

| Hazard | Verified snapshot and required response |
| --- | --- |
| Unit labels mistaken for conversion | `unit` is a display suffix. A seconds-to-ms label change does not multiply data, and `%` does not convert a ratio. Convert once deliberately and keep thresholds/inspection consistent. |
| Timestamp units | Query requests use Unix seconds; chart samples are consumed as JavaScript epoch milliseconds. Inspect adapter boundaries before joining data or moving conversions. |
| Series identity vs position | Built-in palette assignment currently uses series index. Stable color by semantic identity is a proposed improvement, not shipped behavior; verify reorder/filter/refresh fixtures when implementing it. |
| Shared cursor vs shared domain | Cursor state shares a timestamp, but built-in plot extents derive from returned data. Verify visual time alignment across sparse panels; identical query bounds alone do not prove identical rendered domains. |
| Latest finite vs current | Core `latestPoint()` selects the latest finite reading; some status renderers retain missing latest samples. Label age and reducer semantics explicitly instead of implying a fresh observation. |
| Cosmetic sampling | `chart-data.ts` already uses min/max sampling with a 480-point default, endpoints and gap separation. Preserve short spikes/troughs and missingness; do not replace it with stride sampling or averaging for smoothness. |
| Rich-chart meaning | Stack exact timestamps; preserve missing contributions. Mirror outbound geometry while retaining raw positive traffic. Difference cumulative histogram buckets only under the declared contract, preserving invalid/missing groups. |
| Documentation drift | The overview README's plugin type table omits `records`; current schema and registry accept it. Read runtime contracts rather than copying this old table. |
| Capability overstatement | Current `QueryResult` exposes metrics, traces and records. Observe can query logs, but that does not supply a logs widget. Do not claim native histograms, alert evaluation, complete Grafana import/parity or a trace waterfall without verified implementation. |

## Select validation

Read `docs/design/insights/premium-ui.json` first. At the inspected revision it requires unit, E2E, typecheck and build; targeted checks accelerate iteration but do not replace a required project gate. Resolve missing wrappers or prerequisites explicitly and never report an unrun check as passed.

Run these targeted examples from `ui/`, selecting files affected by the change:

```sh
npm test -- src/features/insights/charts.test.tsx src/features/insights/numeric-precision.test.tsx src/features/insights/chart-cursor.test.tsx
npm test -- src/features/insights/plugins/rich-metrics-data.test.ts src/features/insights/plugins/rich-metrics.test.tsx
npm test -- src/features/insights/schema.test.ts src/features/insights/schema-artifacts.test.ts src/features/insights/widget-registry.test.tsx
npm test -- src/features/insights/responsive-layout.test.ts src/features/insights/query.test.tsx
node e2e/run-insights.mjs e2e/insights-rich-charts.e2e.mjs e2e/insights-responsive.e2e.mjs
```

The E2E wrapper starts an isolated development server when `INSIGHTS_E2E_URL` is absent. Further relevant scripts are `e2e/insights-widget-audit.e2e.mjs`, `e2e/insights-reference-dashboards.e2e.mjs` and `e2e/insights-tooltip-query.e2e.mjs`. Read their prerequisites before running service-backed checks.

The maintained `premium-ui.json` commands below are quoted exactly from the inspected configuration; run from the repository context expected by that configuration and recheck current values:

```sh
rtk proxy npm --prefix ui test
rtk proxy env INSIGHTS_E2E_URL=http://127.0.0.1:3015 node ui/e2e/run-insights.mjs
rtk proxy npm --prefix ui exec -- tsc --project ui/tsconfig.json --noEmit --pretty false
rtk proxy npm --prefix ui run build
```

Keep numerical fixtures, interaction checks and visual evidence distinct. Existing rich-data tests cover timestamp mismatch, missing stack members, nonmonotonic bucket groups, raw statistics before sampling and overflow-safe means. The reference-dashboard acceptance document describes complete imported compositions with shared filters and persistence exercised through the real app; its deterministic observations are test-only. Add a screenshot review for the changed whole dashboard and relevant narrow/theme/interaction states. Static lint and unit success do not establish visual quality, complete accessibility or performance.

## Primary sources

All links below are pinned to the inspected commit; revisit the current equivalents before use.

- [Design scope and visual contract](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/DESIGN.md) and [observable UX contract](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/docs/design/insights/UX-CONTRACT.md).
- [Runtime schema](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/schema.ts) and [trusted widget registry](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/widget-registry.tsx).
- [Chart transforms](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/chart-data.ts), [built-in renderers](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/chart-renderers.tsx) and [rich metric fixtures](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/plugins/rich-metrics-data.test.ts).
- [Theme adapter](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/gamma/gamma-theme.module.css) and [query scheduler](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/src/features/insights/query.ts).
- [Observe skill](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/plugins/paprika/skills/paprika-observe/SKILL.md).
- [Maintained verification configuration](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/docs/design/insights/premium-ui.json), [E2E runner](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/ui/e2e/run-insights.mjs) and [reference dashboard acceptance](https://github.com/paprikacd/paprika/blob/bb52aed8ded8beb08534f6b190a3e7f37c1b19d8/docs/design/insights/reference-dashboard-acceptance.md).
