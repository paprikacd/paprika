---
version: alpha
name: Paprika Insights
description: A compact Gamma workspace for reading telemetry and building observability dashboards.
colors:
  primary: "#b65332"
  background: "#ffffff"
  surface: "#f5f7f7"
  ink: "#223139"
typography:
  sans:
    fontFamily: "var(--font-sans), system-ui, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
rounded:
  control: "5px"
  panel: "6px"
  small: "4px"
omitted:
  - section: spacing
    reason: Layout geometry belongs to the responsive canvas and scoped component styles, not a second generated token set.
  - section: components
    reason: The canonical Gamma adapters and their state rules are linked below.
---

# Paprika Insights design context

## Overview

This document covers `/dashboard/insights` and its independently scoped component. It does not replace the dark main-app direction in `.impeccable.md`. The user requested a clean, smooth, performant dashboard builder, maintained Gamma components, detailed telemetry controls, JSON/YAML/OpenUI authoring, and no routine source metadata on widgets. The approved October artboards extend the chart vocabulary and visual detail of this workspace. They are references for reusable chart components. The empty dashboard offers "Start from a template" beside "Add your first widget" and "Import dashboard". It opens a short list of first-party starters (service overview, SLO and burn rate, namespace capacity, Paprika control plane), each with a thumbnail of its grid, its widget count and what it needs (providers and variables). Choosing one hands its complete dashboard to the same import review a file uses, where providers are mapped; the variables keep their defaults and can be changed on the dashboard afterwards. Nothing is saved until the user confirms. The picker loads only when opened, so the empty canvas stays light.

The audience is DevOps and platform engineers, as recorded in `.impeccable.md`. Their job here is to scan telemetry, understand an observation, and follow it into a related dashboard. Treat this as an **Operate** product surface. Gamma's maintained controls frame crisp paper or deep slate plots; the shared series palette (`--gamma-series-1` to `--gamma-series-8`, documented in `ui/src/features/insights/gamma/README.md`) distinguishes signals, status marks carry state, and paprika identifies actions. Dense information should remain legible; decoration must not compete with data. English is the current interface language. Market-specific behavior and additional locales are not established by this feature.

Runtime ownership: `ui/src/features/insights/gamma/gamma-theme.module.css` is the canonical scoped token adapter. It maps the maintained Gamma semantic names to Paprika values; `gamma/controls.module.css` and `gamma/gamma.module.css` consume those names. Widget CSS consumes that same theme. This file records intent and selected values; it does not generate another token system. Source provenance lives in `gamma/README.md` and `docs/design/insights/gamma-source-catalogue.json`.

## Colors

Insights supports Light, Dark and System independently of the main shell. Warm white and charcoal surfaces use the same hierarchy, with restrained borders separating controls and plots. Paprika orange identifies primary actions and focus; sage, blue and the remaining chart palette distinguish data series. Axis text has its own legible token, separate from the quieter chart grid. Status colors must have text or accessible context, especially on heatmaps and gauges. Normal text needs 4.5:1 contrast and default series strokes need 3:1 against the plot surface. Custom backgrounds receive readable default text; explicit text/background choices are preserved with a warning when they fail the contrast target. Provider identity belongs in the editor or an actionable connection error, not ordinary widget chrome.

## Typography

Use the host's existing sans font through Gamma's UI token. Reserve monospace for code and exact identifiers. Numeric values use tabular figures. Widget titles, values, units and ancillary text have distinct levels without oversized marketing headings. Long series names, labels and trace operations must remain inspectable on touch and keyboard, not only in a browser-native hover title.

## Layout

The saved dashboard uses twelve columns. `responsive-layout.ts` projects the actual available canvas width: twelve columns from 960px, kept until the canvas falls below 880px so a panel or scrollbar at the edge cannot flip the projection; balanced three-column stat groups from 840px, two compact stat columns from 600px, and a single column below 600px. This projection never overwrites saved placement. Builder panels (Manage, Build with AI, Add widget, Data sources, and Code or Examples) sit beside the canvas and do not reflow it. Opening one collapses the sidebar only when that is needed to keep the wide grid: with the default 192px sidebar, Manage, Build with AI and Add widget keep it from a 1270px viewport and the 440px Code and Examples panel from 1368px, which narrows to the standard width below that. In compact dark, the rail yields the same way and the wide grid holds from 1246px. The plan is kept while a panel is open: resizing or a change of edit or compact state re-plans it, and a sidebar the user showed over a panel stays shown. The sidebar returns when the panel closes, unless the user hid it; this presentation state stays device-local, never in the URL or the document. Opening or closing a panel keeps every tile mounted and issues no new queries. The widget inspector provides a non-drag layout alternative at every width, and its moves edit the saved grid. Tables scroll within their widget; an open inspector remains reachable through natural document scrolling on small screens. Widget size, loading and error states reserve useful geometry.

## Elevation & Depth

Use quiet borders for resting data tiles. Menus and tooltips may use Gamma's offset soft shadows to indicate an overlay. No decorative glass, ambient glowing accents or gradient text. Portals retain the scoped theme and viewport collision behavior.

### Compact dark reference direction

The supplied Edge Watch and Reliability Room images (30 October 2026) are the
visual authority for **dark, Compact, non-editing desktop views** from 1024px.
The canonical Gamma scope uses midnight blue-black surfaces (`#07141b` canvas,
`#0b1b22` plots), thin blue-gray boundaries, cyan/teal signals and violet
comparison. Standard density, light appearance and narrow layouts retain their
existing theme. Density is a viewing preference, not a saved dashboard edit.
Portals copy the same tokens and update on density and desktop-boundary changes.
Explicit authored series colors remain authoritative.

The demo composition follows four Edge stats, traffic/destinations at 8/4,
geography/outcomes/risk at 4/4/4 and full-width blocked records; Reliability uses
three stats, burn/attention at 8/4, state history/calendar at 8/4 and full-width
incidents. Extra investigations follow these rows. These are generated synthetic
provider demos, not migrations of user documents. Preserve real queries, units,
missingness, exact inspection and source limitations; never copy concept deltas.
Keep readable working-desktop typography rather than the small reference pixels.
Fine-pointer reference views use 24px calendar day targets and state lanes;
one-month calendars reserve a complete six-week grid and retain their legends.
Coarse-pointer calendars retain 44px targets and the ordinary taller projection.
A modest plot-local glow is permitted only when it does not enlarge meaningful
marks or reduce intersection/label legibility; it is not required, and the default
implementation uses crisp marks without glow. No ambient or shell glow is allowed.

## Shapes

Paprika's compact Gamma adapter uses 5px controls, 6px panels and 4px small surfaces. Keep these as tokens rather than restating radii on each control. Use Lucide icons consistently; icon-only actions need accessible names and a clear focus state.

## Components

Reuse `GammaButton`, `GammaInput`, `GammaTextarea`, `GammaSelect`, `GammaSearchCombobox`, `GammaSwitch`, `GammaTabs` and `GammaActionMenu`. Selects use authored listboxes; actions use menus. Focus, disabled, busy and selected treatment belong to these shared owners. Use scoped scrollbar, caret and selection tokens on product-owned scroll surfaces, including portals.

Chart editing opens a dedicated workbench with one live preview and only that chart's controls. Desktop keeps the preview and query workspace beside settings; narrow screens place the chart above settings and query, with persistent Apply/Discard actions. Use the canonical canvas tile, query retention and form components. Valid changes preview without modifying the dashboard until Apply; Discard restores the original settings. The shared bounded history supports chart undo/redo, including placement. Save dashboard remains a separate persistence action. Query creation must preserve the chart draft, and returning to the dashboard restores focus to its edit control.

Tab bars stay on one row. When labels do not fit, use native horizontal scrolling with subtle edge fades, without arrow buttons. Keep full labels and reveal the selected or focused tab without moving the surrounding page. Fitting tab bars need no overflow treatment.

Charts receive normalized data through the host. A legend describes data; it must not become a source badge. Missing data, empty results, failures and result limits must stay distinct. A status heatmap shows the latest sample per series; it is not a histogram. A trace list must not imply a waterfall. Plugin rendering and emitted drilldown context must agree.

Geographic charts share `GeographicPlot`: one fitted 2:1 WGS84 plane, land/coast tokens and coordinate grid. A short card must show the whole map. Hex and distribution heatmaps share the ordered Gamma density ramp and the canonical missing-data hatch. Honeycombs fit their records to desktop panels when columns are unspecified; authored columns remain authoritative, and narrow touch layouts use an explicitly labelled scroll region. Chart marks use Gamma's `mark` size so toolbar touch minimums cannot change plotted geometry.

Hex hover, pinned selection and keyboard focus use the same six-vertex geometry as the fill, with fixed-width SVG contours instead of rectangular button outlines. Clip both contrast and foreground strokes inside that polygon: selection must never paint over a neighbouring cell or the map. The shared Gamma mark button stays transparent in every interaction state; ordinary button hover backgrounds must not paint behind the clipped shape. Inspection preserves the encoded fill colour and missing-data hatch. Raise the active cell above its neighbours so the contour remains complete in dense maps and honeycombs; keep the contour out of pointer hit testing. Compare actual neighbouring pixels during hover, pin and keyboard focus, including small marks and high-density displays.

Metric, trace, record and matrix tables share `ChartTable` typography, sticky headings, separators and focus treatment. Record controls use Gamma inputs and buttons. Renderer `sizing.minHeight` describes useful card height; compact and narrow view projections respect it without rewriting saved placement or limiting the wide editor. Visual checks must cover every affected family in view and edit states, including short cards, both themes and narrow widths. Checking only the first dashboard rows is insufficient.

Reduced motion disables transitions within Insights rather than starting tiny transitions on every chart mark. Theme propagation reads a complete token snapshot before writing portal styles. During tile dragging/resizing, one transparent canvas surface owns hit testing; do not toggle pointer styles across every chart descendant. Handles suppress native text selection without a page-wide selection stylesheet. A wide editing session preserves its initial DOM/tab order and chart focus while the grid moves panels visually; saved viewing and narrow layouts use visual reading order. Moving a chart does not rebuild its contents; dimensions, data, style and callback changes still update. Stable callbacks read current route and selection state. Performance evidence uses a production build and recorded workload, independently from appearance checks.

Observation panels share a 14px content gutter through `tooltip-content.tsx` and `chart-styles.module.css`. Titles, readings, definition-list facts, source metadata, history and actions align to that inset. Individual renderers must not add a second outer inset or render text flush against the shell. Long values wrap; intentionally shortened series labels keep their full accessible identity without expanding the scroll area. Pinned panels retain viewport clearance, bounded vertical scrolling, dismissal guidance and compact controls when needed. Test real text bounds across metric, record, honeycomb and geographic inspectors, including expanded metadata and missing values.

Pin a pointer preview where it opened. Pinning changes its lifetime and makes its contents interactive; it must not switch to a distant gap outside the chart. Retain the pointer-facing corner through content changes, anchor the pin to its mark during page scrolling, and adjust only when viewport geometry requires it. Keyboard and touch openings without a pointer preview retain their accessible placement. Record the hover-to-pin transition frame by frame, including pointer departure and keyboard scrolling; settled screenshots alone miss jumps.

New KPI sparklines sit beside the value so the signal does not cross its number or freshness text; explicitly authored background sparklines remain supported. Time-series identities and investigation actions use separate footer rows where height allows; short desktop panels keep a scrollable series key beside the controls. Statistics legends scroll before they squeeze out the plot. Capacity rows retain their full label and touch-target height inside the bank's scroll surface, and values outside the authored scale receive a directional cue while preserving the exact reading. Chart axes, metric inspectors and the range summary use the dashboard's timezone.

Compact metric legends keep their series in one horizontal row, with readings beneath names on narrow panels. Longer keys retain native scrolling and keyboard access. Recorded chart events share the investigation footer; their bounded disclosure overlays the plot without resizing it. Escape closes the event list and returns focus to its summary. Gauge inspectors use the same short identity as the gauge, with complete provider context in Source details.

The richer chart vocabulary includes stacked areas/bars, mirrored directional traffic, bucket distribution heatmaps, segmented and radial capacity meters, supplied-coordinate maps, directed pipeline diagrams and UTC incident calendars. Each is a configurable renderer in the existing builder. Distribution color represents bucket density; thresholds represent explicit limits; meter fills represent the measured fraction. Never substitute a status heatmap for a distribution or fabricate coordinates, missing observations or healthy days. Guided settings expose only capabilities the renderer implements, with advanced JSON retained.

Time-based plots share the exact observation timestamp through a dashboard-scoped cursor. Hover remains transient; click/tap or Enter pins the inspector; Escape dismisses it. A result refresh clears stale observations and cursors. Details-only charts do not launch extra queries. Query-backed tooltip widgets remain an explicit authoring choice.

The October 2026 component studies in `output/imagegen/` guide presentation, not dashboard schema or invented data. Prefer thin readable lines, low-opacity areas, quiet horizontal grids, compact aligned legends and tabular values. Area charts may use a vertical gradient fill per series that fades to transparent at the baseline; no glow or blur on marks. An observation card should remain beside the selected track where space permits. Its history keeps the selected series' color in both themes; an explicit authored color takes priority. The selected observation and latest history value remain separately labelled. Never invent deltas or combine incompatible units just to reproduce a concept image.

Keep motion brief and functional, using Gamma's standard or exponential deceleration. Do not use overshoot or elastic easing. Reduced motion retains visible pending/selected/focus feedback without moving effects. The historic spring token is an alias to the emphasized easing for compatibility. Charts may draw in once on first render (left-to-right reveal, ≤ 700 ms, emphasized easing). Data refreshes never re-animate, values are never interpolated through intermediate states, and reduced motion (OS setting or `data-motion="reduced"`) disables it.

## Do's and Don'ts

- Keep the data and its available actions readable at rest, including on mobile.
- Extend a shared Gamma adapter when behavior recurs; preserve provenance and accessibility.
- Do not expose a style control that does nothing for the selected widget.
- Do not replace this dashboard with landing-page styling or migrate its control library during a review.

The behavior owners and review evidence are in `docs/design/insights/UX-CONTRACT.md` and `docs/design/insights/widget-review.md`.
