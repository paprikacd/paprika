---
version: alpha
name: Paprika Insights
description: A compact Gamma workspace for reading telemetry and building observability dashboards.
colors:
  primary: "#b65332"
  background: "#fffefd"
  surface: "#f7f8fa"
  ink: "#202936"
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

This document covers `/dashboard/insights` and its independently scoped component. It does not replace the dark main-app direction in `.impeccable.md`. The user requested a clean, smooth, performant dashboard builder, maintained Gamma components, detailed telemetry controls, JSON/YAML/OpenUI authoring, and no routine source metadata on widgets. This is a refinement of that existing workspace, not a new visual direction.

The audience is DevOps and platform engineers, as recorded in `.impeccable.md`. Their job here is to scan telemetry, understand an observation, and follow it into a related dashboard. Treat this as an **Operate** product surface. The reference is Gamma's maintained controls inside Paprika's paper, paprika and sage palette. Dense information should remain legible; decoration must not compete with data. English is the current interface language. Market-specific behavior and additional locales are not established by this feature.

Runtime ownership: `ui/src/features/insights/gamma/gamma-theme.module.css` is the canonical scoped token adapter. It maps the maintained Gamma semantic names to Paprika values; `gamma/controls.module.css` and `gamma/gamma.module.css` consume those names. Widget CSS consumes that same theme. This file records intent and selected values; it does not generate another token system. Source provenance lives in `gamma/README.md` and `docs/design/insights/gamma-source-catalogue.json`.

## Colors

Insights supports Light, Dark and System independently of the main shell. Warm white and charcoal surfaces use the same hierarchy, with restrained borders separating controls and plots. Paprika orange identifies primary actions and focus; sage, blue and the remaining chart palette distinguish data series. Axis text has its own legible token, separate from the quieter chart grid. Status colors must have text or accessible context, especially on heatmaps and gauges. Normal text needs 4.5:1 contrast and default series strokes need 3:1 against the plot surface. Custom backgrounds receive readable default text; explicit text/background choices are preserved with a warning when they fail the contrast target. Provider identity belongs in the editor or an actionable connection error, not ordinary widget chrome.

## Typography

Use the host's existing sans font through Gamma's UI token. Reserve monospace for code and exact identifiers. Numeric values use tabular figures. Widget titles, values, units and ancillary text have distinct levels without oversized marketing headings. Long series names, labels and trace operations must remain inspectable on touch and keyboard, not only in a browser-native hover title.

## Layout

The saved dashboard uses twelve columns. `responsive-layout.ts` projects the actual available canvas width: twelve columns from 960px, two compact stat columns from 600px, and a single column below 600px. This projection never overwrites saved placement. The widget inspector provides a non-drag layout alternative at every width. Tables scroll within their widget; an open inspector remains reachable through natural document scrolling on small screens. Widget size, loading and error states reserve useful geometry.

## Elevation & Depth

Use quiet borders for resting data tiles. Menus and tooltips may use Gamma's offset soft shadows to indicate an overlay. No decorative glass, glowing accents or gradient text. Portals retain the scoped theme and viewport collision behavior.

## Shapes

Paprika's compact Gamma adapter uses 5px controls, 6px panels and 4px small surfaces. Keep these as tokens rather than restating radii on each control. Use Lucide icons consistently; icon-only actions need accessible names and a clear focus state.

## Components

Reuse `GammaButton`, `GammaInput`, `GammaTextarea`, `GammaSelect`, `GammaSearchCombobox`, `GammaSwitch`, `GammaTabs` and `GammaActionMenu`. Selects use authored listboxes; actions use menus. Focus, disabled, busy and selected treatment belong to these shared owners. Use scoped scrollbar, caret and selection tokens on product-owned scroll surfaces, including portals.

Charts receive normalized data through the host. A legend describes data; it must not become a source badge. Missing data, empty results, failures and result limits must stay distinct. A status heatmap shows the latest sample per series; it is not a histogram. A trace list must not imply a waterfall. Plugin rendering and emitted drilldown context must agree.

The October 2026 component studies in `output/imagegen/` guide presentation, not dashboard schema or invented data. Prefer thin readable lines, low-opacity areas, quiet horizontal grids, compact aligned legends and tabular values. An observation card should remain beside the selected track where space permits. Its history keeps the selected series' color in both themes; an explicit authored color takes priority. The selected observation and latest history value remain separately labelled. Never invent deltas or combine incompatible units just to reproduce a concept image.

Keep motion brief and functional, using Gamma's standard or exponential deceleration. Do not use overshoot or elastic easing. Reduced motion retains visible pending/selected/focus feedback without moving effects. The historic spring token is an alias to the emphasized easing for compatibility.

## Do's and Don'ts

- Keep the data and its available actions readable at rest, including on mobile.
- Extend a shared Gamma adapter when behavior recurs; preserve provenance and accessibility.
- Do not expose a style control that does nothing for the selected widget.
- Do not replace this dashboard with landing-page styling or migrate its control library during a review.

The behavior owners and review evidence are in `docs/design/insights/UX-CONTRACT.md` and `docs/design/insights/widget-review.md`.
