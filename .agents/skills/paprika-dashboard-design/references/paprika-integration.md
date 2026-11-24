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

This map points at code owners; it is not a claim of rendered verification. Re-read the current repository's `AGENTS.md`, root `DESIGN.md`, `docs/design/insights/UX-CONTRACT.md`, relevant runtime contracts and package scripts before implementation. Inspect relevant active work before editing shared owners. Prefer current verified code over stale examples; surface contradictions with maintained product contracts.

Target `/dashboard/insights` unless the request identifies another surface. Root `DESIGN.md` is the design context for this independently themed Gamma workspace; `.impeccable.md` records the audience and the console's light-only shell. Do not spread an Insights palette change across the main shell. The audience is DevOps/platform engineers performing operational work. Reference screenshots and generated artboards inform hierarchy and craft; they do not establish data, available features or permission to invent observations.

Read installed versions from `ui/package.json` (Next.js 16, React 19, `@tanstack/charts`, d3-shape, react-grid-layout, Zod, Vitest, Playwright); avoid introducing another chart library by default.

## Find the canonical owner

Paths below are relative to `ui/src/features/insights/` unless qualified. This table maps code owners. The UI behaviour owners (observation owner, tooltips, footers, tables, layout, shortcuts) and their verification are in [UX-CONTRACT.md](../../../../docs/design/insights/UX-CONTRACT.md); do not copy them here.

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

The built-in plugin IDs are listed in [`docs/design/insights/widget-plugins.json`](../../../../docs/design/insights/widget-plugins.json), which `widget-plugin-list.test.ts` regenerates from the registry. Read the registration in `plugins/` for each one's config.

Reuse an existing renderer when it expresses the data truthfully. For a new trusted plugin:

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
- Hover is transient; click/tap or Enter pins inspection; Escape dismisses it. An automatic refresh keeps an open or pinned observation on the same key (series, sample, bucket, day) with its new values and closes it when the key leaves the result; cursors clear. Never retarget a pin by array index. The rules are in UX-CONTRACT.md (Observation owner).
- Keep a selected historical observation distinct from the latest history value. Details-only inspection makes no additional request. Explicit query-backed tooltip widgets use the host scheduler, cancel on dismissal/switch, reject missing bindings locally and mask stale responses.
- Embedded widgets are bounded and readonly, without nested tooltip, inspector or drilldown actions. Preserve scoped theme inheritance for portalled content.
- Keep source identity and configuration in authoring/inspection or actionable failure UI. Ordinary widget chrome prioritizes title, data and meaningful actions.

Compose with the existing `paprika-observe` skill for live discovery, provider-specific querying and authorized document operations. It lives at `plugins/paprika-observe/skills/paprika-observe/SKILL.md`, in the standalone Observe plugin. Discover real provider capabilities, metric metadata, labels and returned samples before designing queries. Observe read access (`paprika:observe`) and Insights authoring (`paprika:insights:write`) are distinct scopes. Do not infer dashboard visualization support from gateway query support.

## Check implementation hazards

| Hazard | Current behaviour and required response |
| --- | --- |
| Unit labels mistaken for conversion | `unit` is a display suffix. A seconds-to-ms label change does not multiply data, and `%` does not convert a ratio. Convert once deliberately and keep thresholds/inspection consistent. |
| Timestamp units | Query requests use Unix seconds; chart samples are consumed as JavaScript epoch milliseconds. Inspect adapter boundaries before joining data or moving conversions. |
| Series identity vs position | `seriesColorMode` defaults to `name`, which keys colour to series identity; `index` keeps position slots. Verify reorder, filter and refresh fixtures when changing colour assignment. |
| Shared cursor vs shared domain | Cursor state shares a timestamp, but built-in plot extents derive from returned data. Verify visual time alignment across sparse panels; identical query bounds alone do not prove identical rendered domains. |
| Latest finite vs current | Core `latestPoint()` selects the latest finite reading; some status renderers retain missing latest samples. Label age and reducer semantics explicitly instead of implying a fresh observation. |
| Cosmetic sampling | `chart-data.ts` already uses min/max sampling with a 480-point default, endpoints and gap separation. Preserve short spikes/troughs and missingness; do not replace it with stride sampling or averaging for smoothness. |
| Rich-chart meaning | Stack exact timestamps; preserve missing contributions. Mirror outbound geometry while retaining raw positive traffic. Difference cumulative histogram buckets only under the declared contract, preserving invalid/missing groups. |
| Capability overstatement | Current `QueryResult` exposes metrics, traces and records. Observe can query logs, but that does not supply a logs widget. Do not claim native histograms, alert evaluation, complete Grafana import/parity or a trace waterfall without verified implementation. |

## Select validation

Read `docs/design/insights/premium-ui.json` first. It requires unit, E2E, typecheck and build; targeted checks accelerate iteration but do not replace a required project gate. Resolve missing wrappers or prerequisites explicitly and never report an unrun check as passed.

Run these targeted examples from `ui/`, selecting files affected by the change:

```sh
npm test -- src/features/insights/charts.test.tsx src/features/insights/numeric-precision.test.tsx src/features/insights/chart-cursor.test.tsx
npm test -- src/features/insights/plugins/rich-metrics-data.test.ts src/features/insights/plugins/rich-metrics.test.tsx
npm test -- src/features/insights/schema.test.ts src/features/insights/schema-artifacts.test.ts src/features/insights/widget-registry.test.tsx
npm test -- src/features/insights/responsive-layout.test.ts src/features/insights/query.test.tsx
node e2e/run-insights.mjs e2e/insights-rich-charts.e2e.mjs e2e/insights-responsive.e2e.mjs
```

The E2E wrapper starts an isolated development server when `INSIGHTS_E2E_URL` is absent. Further relevant scripts are `e2e/insights-widget-audit.e2e.mjs`, `e2e/insights-reference-dashboards.e2e.mjs` and `e2e/insights-tooltip-query.e2e.mjs`. Read their prerequisites before running service-backed checks.

The `premium-ui.json` commands, run from the repository root (recheck the file for current values):

```sh
npm --prefix ui test
env INSIGHTS_E2E_URL=http://127.0.0.1:3015 node ui/e2e/run-insights.mjs
npm --prefix ui exec -- tsc --project ui/tsconfig.json --noEmit --pretty false
npm --prefix ui run build
```

Keep numerical fixtures, interaction checks and visual evidence distinct. Existing rich-data tests cover timestamp mismatch, missing stack members, nonmonotonic bucket groups, raw statistics before sampling and overflow-safe means. The [reference-dashboard acceptance record](../../../../docs/design/insights/receipts/reference-dashboard-acceptance.md) describes complete imported compositions with shared filters and persistence exercised through the real app; its deterministic observations are test-only. Add a screenshot review for the changed whole dashboard and relevant narrow/theme/interaction states. Static lint and unit success do not establish visual quality, complete accessibility or performance.

## Primary sources

- [DESIGN.md](../../../../DESIGN.md) and [UX-CONTRACT.md](../../../../docs/design/insights/UX-CONTRACT.md).
- [Runtime schema](../../../../ui/src/features/insights/schema.ts) and [trusted widget registry](../../../../ui/src/features/insights/widget-registry.tsx).
- [Chart transforms](../../../../ui/src/features/insights/chart-data.ts), [built-in renderers](../../../../ui/src/features/insights/chart-renderers.tsx) and [rich metric fixtures](../../../../ui/src/features/insights/plugins/rich-metrics-data.test.ts).
- [Theme adapter](../../../../ui/src/features/insights/gamma/gamma-theme.module.css) and [query scheduler](../../../../ui/src/features/insights/query.ts).
- [Observe skill](../../../../plugins/paprika-observe/skills/paprika-observe/SKILL.md).
- [Verification configuration](../../../../docs/design/insights/premium-ui.json), [E2E runner](../../../../ui/e2e/run-insights.mjs) and [the Insights dev loop](../../../../docs/guides/insights-dev-loop.md).
