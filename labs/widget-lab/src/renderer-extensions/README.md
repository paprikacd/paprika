# Lab extensions to the production Insights renderer

The Widget Lab renders through production's renderer. `@insights/*` resolves to `ui/src/features/insights`, so the lab
and production share one module graph, one React and one TanStack Charts, and one widget registry. This folder holds the
only lab code that sits beside that renderer. It holds **no copy of a production file**. Each file either adapts a
production API to a need the lab has, or is a renderer production does not bundle.

Before WP-B1b this folder held 26 patched copies of production files. Every copy was deleted once production covered its
feature: the gridX, calendar, axis-unit, reference-line, inset and gradient features; the per-widget tooltip owner and its
Escape, focus and placement rules; the registry's `validateInput`, `sizing` and field `binding`; the loading slot; the
observation inspector; and the dashboard time zone. The table below lists what remains and why.

## What remains, and the production gap each covers

| File | What it provides | Production gap it covers |
| --- | --- | --- |
| `chart-tooltip.tsx`, `chart-tooltip.css` | `ChartTooltip`: a family's inspector body, drawn by production's `ObservationTooltip`. `isInspectorTarget` recognises focus moving into an inspector. | `ObservationTooltip` requires an `anchor` element, and lab families mount inspectors without one. The wrapper anchors to the element the inspector is mounted in, through a hidden marker. Production has no inspector-body marker, so the lab adds `data-lab-inspector`. |
| `use-tooltip-dismiss.ts` | The hover and focus grace for a family, on production's `useTooltipDismiss`. | Production's hook requires an `engaged` callback. Lab families report leave on the chart and on the inspector, so engagement is always false. |
| `lab-window-controls.tsx`, `lab-window-controls.css` | Production's `ChartWindowControls` with a scope note beside it. | Production states the zoom but not which series it changes. Each lab plot states its own scope. |
| `time-brush-overlay.tsx` | The drag preview over a lab plot: the span under the pointer, with its duration. | Production's brush overlay is internal to `TimeSeriesChart`, and lab plots position their own marks. |
| `lab-widget-loading.tsx` | `LabWidgetLoadingProvider` and `chartLoadingVariant`: the skeleton for production's loading slot. | Production's slot is presentation-only and carries the phase rules. The lab supplies its skeleton look (`src/components/lab/ChartLoading.tsx`). |
| `input-issues.ts` | `checkedInput`: runs a lab data check and returns its outcome as `validateInput` issues. | The lab's data helpers report invalid input by throwing. Production's `widgetInputIssues` reduces a throw to a generic message, so the lab returns the message as the issue. |
| `connection-map.tsx` | `ZoomableConnectionMap`: the connection map with zoom and pan. Registered as `connection-map` in `src/charts/register-lab-charts.ts`. | Production's `ConnectionMap` is a horizontal scroller with no zoom or pan. Zoom is a product decision (convergence decision D5), so the lab keeps it. |

Lab wrappers outside this folder, by design: `src/components/lab/ChartLoading.tsx` (skeleton visuals) and
`src/components/lab/DomainInspector.tsx` (the lab's inspector chrome, which wraps `ChartTooltip`).

## Registration: one registry

Every registration goes through production's `registerWidgetPlugin`. There is no resolver overlay and no second store.
`src/charts/register-lab-charts.ts` registers the zoomable `connection-map` first, keeping production's entry (fields,
defaults and style controls) and replacing only its render. It then calls production's `registerDefaultWidgetPlugins()`,
which skips any id already held. `tests/register-lab-charts.test.ts` pins that order.

## Panel sizing

Production's visualization shell fills its card: its content track grows to the card height. A lab panel whose host is content-sized would collapse under that rule, so those call sites pass `naturalHeight` to `WidgetVisualization`. That is production's intrinsic-height mode (`.visualization.intrinsicStat`). The call sites are the domain host (`DomainPrimitives`), the reference charts, the incident, query-atlas, spatial and exploration panels, and the editor preview. Fixed cards (finance, market risk, inference fleet, grid operations, operations, analytics and the study pages) keep the fill rule. A check of the 31 routes found no collapsed shell with this rule in place.

## Validation and tooltips

- `validateInput` returns issues in production's contract. The lab's 29 checks return the messages the editor shows, and
  `src/editor/editor-model.ts` reports them through production's `widgetInputIssues`.
- One tooltip system: every lab inspector is an `ObservationTooltip`. Escape closes the topmost panel only, and a
  transient preview replaces any other transient preview page-wide. Both rules come from production's owner.

## Rules for this folder

- Do not copy a production file here. If production lacks something the lab needs, add a wrapper that adapts the
  production API, and list it above with the gap it covers.
- Import production only through `@insights/*`. The lab's own `tests/` follow the same rule.
- Production's `ui/` is not edited from the lab.
