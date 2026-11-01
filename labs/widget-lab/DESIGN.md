---
version: alpha
name: Paprika Widget Lab
description: An interactive evaluation of Paprika Insights chart craft and analytical behavior.
colors:
  primary: "#ff7956"
  background: "#071319"
  surface: "#0b1b22"
  ink: "#e4eef2"
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
    reason: Lab composition uses CSS grid; chart and control geometry remains owned by the imported Paprika components.
  - section: components
    reason: Canonical owners are documented in UX-CONTRACT.md and docs/paprika-source.md.
---

# Paprika Widget Lab

## Overview

An interactive surface for an engineer evaluating chart components. The analytical studies follow the user's Edge Watch and Reliability Room references: a dense dark observability console with compact metrics, crisp telemetry, ranked evidence and rich exact inspection. Two studies investigate network activity and request-based service reliability. The original deployment investigation remains available at `#baseline` for comparison. The iteration-06 direction below adds reusable inspection and navigation to the literal studies and chart catalogue.

The maintained Paprika Insights semantic theme and control ownership are preserved. `src/observatory.css` adapts the existing Gamma token contract on the study's `data-insights-theme` scope, using the user-approved reference direction. Components consume those variables instead of declaring independent palettes. The imported Gamma theme remains unchanged and supplies baseline defaults; its portals inherit computed tokens from the current scope. Light and dark each have deliberate colors. The original lab retains its earlier presentation. Product typography is Barlow, with tabular values and monospace identifiers.

## Composition

Use a slim navigation rail, short scope toolbar, compact metric strip, a broad primary trend beside a ranked breakdown, supporting outcome/state panels, and exact event records. The metric strip is intentional for these two user-selected references. New components use 12px or larger operational labels, 14px titles, and roughly 27px summaries. Gutters are 10px; panel radius remains the canonical 6px. The wide shell targets a 54px topbar, approximately 80px metric cards and 10–11px panel padding. These are composition targets, not reasons to clip essential text. The current Edge chart container is 250px tall; supporting rows stay subordinate. Provenance and evaluation detail belong in the notes, leaving the main dashboard focused on its task.

The copied chart host supplies normalized query rendering, cursor, tooltip and exact inspection. Paprika orange identifies actions and focus; cyan and violet distinguish primary and secondary measured series. Green, amber and red have explicit state meanings. Quiet borders frame plots. Compact sparklines use unique gradient IDs and a zero baseline for magnitude area. Top-destination bars compare mean Mb/s on a common domain from zero to the highest destination mean; the separate percentage column expresses share of observed inbound bytes.

This reference pass adds explicit **local owner extensions** for `gridX`, `timeAxis: 'calendar'`, `axisUnit: 'caption'`, `fillStyle: 'gradient'`, `showZeroLine`, `referenceLines` and `inspectorDensity: 'compact'`, together with an 80px tooltip-history option. The strict schema and the renderer are changed together. These fields are supported by this lab's documented patch, not asserted to exist in the pinned upstream commit. Calendar rendering passes Date values to the temporal scale channel while retaining numeric epoch timestamps in observations and cursor/tooltip data. Grids and reference lines use actual plot scales, not decorative CSS overlays. Signed area fills fade toward the actual zero baseline for positive and negative values. The compact inspector shows exact same-timestamp values, selected-series history and expandable metadata. See [source provenance](docs/paprika-source.md) and its reproducible patch.

Panel information belongs in an accessible disclosure next to the title. Keyboard activation, Escape with focus return, outside dismissal and blur cleanup are required. Essential units, current cadence, missingness and mirrored direction remain visible; use the optional `caption` when a persistent explanation is needed. Compactness comes from reducing repeated prose, blank space and oversized surfaces, while retaining exact values and usable controls.

## States and motion

The motion extension in PR #168 adapts [Bklit's chart examples](https://bklit.com/charts), [tooltip](https://bklit.com/docs/utility/tooltip) and [legend](https://bklit.com/docs/utility/legend) patterns into the current Paprika owners. Focus remains local: exact point rings, coherent row/column or edge emphasis, and short color/opacity feedback. Data coordinates update immediately. Routine panel entrances and sibling staggering are removed; a new measurement is never drawn from zero. No Bklit code or dependency is copied.

`labMotionStyle()` in `src/components/lab/motion.tsx` is the single application mapping for Gamma durations. Apply it to every theme scope, including nested catalogue/finance scopes, so already-open portals observe preference changes. `ChartLoading` reserves a family-appropriate plot area, uses one neutral sweep, and keeps placeholder geometry outside measurement and inspection. `ChartRefreshing` overlays retained results without moving the chart or controls. Both become static under Reduced motion and pause movement while the document is hidden or the indicator is outside the viewport. Status text remains available in every mode.

All data is deterministic synthetic telemetry, visibly labelled. Study-specific scenarios expose incidents and missing observations; the baseline retains regression, gaps and quiet-service fixtures. Missing observations never become zeros. Network outbound values are positive magnitudes in summaries and explicitly mirrored below zero in the directional plot. Reliability uses request counts for its SLO and budget; it never mixes downtime minutes into request-based arithmetic. Any aggregated state timeline states its bucket meaning. No live provider or measured performance claim is implied by these fixtures.

Edge's default 10s view consists of synthetic integer-count buckets that conserve each original minute's bytes, requests and exclusive outcomes. It is not interpolation of provider measurements. The 1m view, original summary population and minute outcome bars remain available; selection explicitly identifies its source cadence. Missing minutes produce six missing ten-second observations, and overlapping timestamps retain the same values across snapshots.

Cursor and exact values respond immediately. A changed KPI may receive one interruptible 360ms emphasis; compact inspector appearance uses the inherited 150ms duration. Numerical geometry does not overshoot, count up or morph from zero. The signed fill communicates magnitude and direction without a looping glow or ambient pulse. Refreshing or changing query scope clears old pins and observations.

Demo replay starts paused and advances actual fixture snapshots every 1.8 seconds, corresponding to one observed minute for Edge and one observed hour for Reliability. Explicit pause, hidden-document pause and unmount cleanup belong to its shared owner. Motion Auto follows the operating system; Motion Reduced removes decorative effects without changing data cadence or inspection. Duration tokens are applied inline to the theme scope so open Gamma portals receive effective preference changes. Do not announce every replay tick.

The incident calendar shows distinct episode presence on real local dates clipped to the query window. Active/resolved state must not imply severity. Selecting a date filters only incident evidence, preserving the complete request population used by reliability summaries and exact budget accounting.

## Responsive behavior

Wide view: metrics, primary plot and contributor table share a compact investigation hierarchy. Narrow view: panels stack, the toolbar wraps deliberately, data tables scroll internally, and exact inspection stays reachable. The new shell's 420px outer canvas provides a 390px content area. The width control is presentation-only and must not change semantic summaries. Component adaptation uses container size, not merely viewport size.

## Verification

Numerical fixtures, typecheck/build, browser interaction, dark/light, narrow width, missing data, pin invalidation, replay cleanup and reduced motion are separate evidence. The original evidence is retained in `docs/evaluation-report.md` and `docs/iteration-02.md`; the retained analytical outcomes belong in `docs/iteration-03.md`. Current interaction evidence is recorded in `docs/iteration-06-interaction.md`. Documentation and source inspection alone do not establish browser behavior. The lab changes only its copied renderer owners and owned studies, not Paprika's production repository or persistence model. Regenerate the patch and provenance hashes after every final copied-owner change.

## Reusable chart foundation — iteration 05

Preserve the two literal 1592 × 988 reference artboards and their authored geometry as visual acceptance fixtures. Carry their reusable qualities into the existing chart owners: clear hierarchy, aligned scales, restrained fills, exact values, meaningful missingness and stable inspection. A traced silhouette, a fixed inspector position or an illustrative budget length is not a general data transformation. Historical iteration-04 reproduction evidence remains in `docs/iteration-04-pixel-reproduction.md`.

The `#charts` catalogue evaluates eleven examples through ten canonical renderer identities using the existing `Widget`, `QueryResult`, registry and `WidgetVisualization` contracts. Keep configuration and data disclosure in this evaluation surface. Demonstrate a family with variable valid input and meaningful missing/empty/error cases before describing it as reusable. Linear and segmented gauges are two examples of one renderer. Sampled status history does not establish an elapsed-duration timeline, and an incident-start calendar does not establish local episode coverage.

Geography shares one bounded viewport owner across the reference and catalogue maps, with each retaining its own matching projection and land geometry. Zoom and pan change the camera only; stable IDs, exact values and supplied risk classification retain their meaning. Use fixed-size location marks with a stated color classification. Preserve null values, identify unknown classification, and disclose invalid, duplicate or omitted records. Decorative reference points remain labelled concept material. Map controls offer alternatives to dragging, ordinary wheel scrolling stays available, and touch navigation requires deliberate activation.

Theme and narrow-width controls must preserve the underlying result. Result replacement invalidates obsolete map inspection while preserving the camera. Check these behaviors separately from numerical tests, screenshot similarity and motion preferences. Current implementation and executed evidence belong in `docs/iteration-05-reusable-charts.md`; the earlier composition and analytical contracts above remain historical context.


## Current direction — iteration 06

Retain the source-size reference composition for comparison, and reflow an operational view at smaller widths. Recompute chart geometry using the actual container. Keep the complete plot, controls and legend in normal block flow; share the canonical viewport-bounded portal for transient and pinned inspection; size containment and cyclic percentage height must not collapse an auto-height widget wrapper. Tables retain their exact columns inside local scrolling regions.

Inspection should be visually rich because it is informative: exact timestamp and units, coherent series colors, small histories, a selected-time guide, source-based statistics and meaningful actions. Summaries name the population they describe. Missing counterparts remain missing, and displayed reduction never changes exact values or raw statistics.

A chart window is a reversible local view. Keep source extent, accepted interval, temporary brush and inspection state separate. A deliberate drag clears inspection, previews an interval and commits bounded timestamps; clicks retain observation inspection. Show exact UTC inputs, Undo and Reset. A future shared dashboard interval belongs to the query owner and must reconcile all affected summaries together.

Ordinary wheel input now zooms the map around the pointer, as requested. Consume input only while the bounded camera can change, preserve browser/horizontal navigation gestures, and let outward input at zoom limits return to page scroll. Camera movement leaves exact location values unchanged.

The framework and interaction owners are recorded in `docs/framework-stack.md`; executed verification and remaining limits belong in `docs/iteration-06-interaction.md`.

The Finance, Website and Infrastructure lenses extend this visual grammar into distinct investigations. Finance gives allocation area, signed change, period return and exact holdings different evidence roles. Website adapts the supplied metric/resource/request composition. Infrastructure adapts the paired maps, health rail and capacity grid. These are new compositions, separate from the literal Edge Watch and Reliability Room acceptance fixtures.

Chart authoring uses a large live preview with searchable options on the right and data/query/configuration below. Render the same registered widget and loaded observations as the panel. Treat invalid drafts as recoverable user work, preserve the last valid preview, and make Apply/Discard explicit. Label session-only changes accurately; do not represent read-only fixture context as executable query editing.

## Iteration 07 — complex concept lenses

Market Risk, Inference Fleet, Incident Room and Grid Operations extend the existing dense Paprika visual system. The four generated source images are preserved under `docs/references/` with identities in the reference register. These are adaptive component implementations: preserve visual hierarchy and useful interaction states, while deriving coherent fixtures independently of generated text and numbers.

Each visual has a registered owner, a strict configuration contract and normalized input; the four lenses introduce eleven reusable families. The standalone chart library has 22 examples, installs all optional owners on clean entry, groups families by lens and shares the same editor. Existing React, Paprika, TanStack Charts, D3 and SVG responsibilities remain intact.

Content-sized compound charts must opt into inline-size containment at the host. Full size containment requires an explicit height; applying it to an auto-height trace or telemetry composition collapses the layout and causes overlap. Responsive graph labels use measured pixel geometry, not a large fixed viewBox scaled down until labels are unreadable. Trace rows keep a usable whole-row hit region and distinguish pointer-captured clicks from brush completion.

A paired time view shares both the temporal domain and actual plot gutters. Calendar axes are explicitly UTC in the four new lenses. Do not pair a UTC chart with a browser-local sibling or align outer panels while their plot bounds differ. Heatmap timestamp centers share the time-series scale; edge cells and inspection marks clip at the actual plot boundary.

Narrow layouts preserve notes, maps, status labels and all useful controls. Exact tables, dense rack matrices and large dependency graphs may scroll locally; the page itself must not widen. Map classifications use the host's terminology consistently in legends and inspection. Selected regional evidence has one owner across buttons and map marks.

For actual execution evidence and remaining limits, use `docs/iteration-07-complex-lenses.md`. Source bounds and cleanup do not establish measured production performance; a 390px container preview does not establish physical-device or assistive-technology coverage.

## Iteration 08 — ten-lens chart expansion

Query Atlas, Journey & Retention, Logistics Control, Factory Quality, Threat Hunt, Experiment Studio, Spectrum Observatory, Coastal Observatory, Production Planner and Materials Lab extend the dense Paprika investigation hierarchy. Their signature structures remain distinct: stack profiles, cohort triangles, interval evidence, process control, relationship matrices, uncertainty distributions, frequency/depth fields, resource schedules and composition coordinates. Generated references guide arrangement and visual emphasis; validated records determine geometry and values.

The expansion adds **27 registered plugin identities and 29 catalogue examples**, bringing the library to **51 examples** and navigation to **19 dashboard lenses**. Histogram, violin and ridgeline examples share the `sample-distribution` owner. Global navigation stays outside reference artboards: above 1200px it uses the labelled link grid; at 1200px and below it becomes a compact, labelled native lens picker with grouped destinations and the chart library. Lens headers provide local scope controls.

The [intrinsic-family Set](src/charts/intrinsic-chart-families.ts) is the shared sizing authority for all 27 new identities. Catalogue and editor inspect the active widget through `hasIntrinsicChartLayout`, including after visualization changes. Compound owners use `height: auto` and inline-size containment; their controls, plot and legend participate in block layout; observation popups share the canonical portal. Existing fill-height owners keep their established host. At narrow widths, surrounding panels reflow while dense geometry and exact tables scroll locally, preserving readable labels and access to evidence.

Every advertised fixture state must pass the complete canonical record validator as well as its chart-specific adapter. Preserve the full authored population within host bounds; never make a fixture acceptable by silently truncating records. Stable identities link marks and evidence. Future cohort ages, missing acquisitions, pending material measurements and observed zero have different visual meanings. Selection, hover and provisional changes may receive restrained emphasis; numerical geometry and missingness retain their meaning with reduced motion.

Flamegraph width expresses aggregate cost with explicit units and sample rate; chronological flamecharts require actual weighted time samples. Planner edits show a proposal before Apply, with conflicts, Discard and Undo visible. These families extend the shared inspection and authoring grammar while retaining their own data semantics. Implemented behaviors, validation evidence and remaining limits are recorded in [the iteration-08 report](docs/iteration-08-chart-expansion.md).

## Iteration 09 — linked domain investigations

Seven more lenses adapt generated domain/SRE compositions through the existing Paprika registry. The visual grammar remains dense dark surfaces, low-contrast grids, cyan/violet comparative marks, restrained semantic amber/red, compact controls and exact evidence. Hover evidence overlays its plot; pinned evidence becomes persistent layout. Drill-downs use stable identities, visible scope, breadcrumbs/back and reversible local zoom. A short surface reveal supplies load polish without tweening metric values or suggesting fresh telemetry; the shared motion provider owns user and OS reduced-motion.

New chart definitions colocate loaded-input validation and intrinsic layout metadata. Editor acceptance checks actual mappings and units, preserving the last valid preview when a field is invalid. Shared panel hosts merge presentation overrides with current source identity and lens-controlled selection. Navigation derives from one route catalogue. See `docs/iteration-09-domain-and-sre.md` for the full implementation, numerical boundaries and executed evidence.

## Iteration 10 — source-aware configuration and complementary evidence

The four domain lenses add `followup-distribution`, `reserve-envelope`, `wafer-transect` and `orbital-pass-profile`: endpoint/censor duration populations, reserve headroom, physical die cross-sections and threshold-qualified contact intervals. Preserve the Barlow typography, scoped Gamma colours, 6px panels and 10px composition gutters. Each additional panel should earn its space through a useful comparison and exact evidence.

The editor retains a dominant preview, searchable property rail and lower Data / Fields / Query / Configuration workspace. **Fields** exposes declared source types and units, loaded coverage, sample values and bound roles. Mapped roles use the existing searchable GammaSelect; incompatible columns remain visible but disabled with their reasons stated. Place role meaning, required/optional status and field-specific errors beside the selector. Essential option labels, descriptions, data rows and diagnostic copy use the improved 12px reading size; the preview title is 16px with restrained weight. Separate work regions through existing surfaces and borders without adding nested cards.

Source metadata owns types and units; loaded values supply bounded examples and coverage. A dropdown label never converts a measurement. Optional mappings expose **Not mapped**, retaining an explicit empty value rather than silently reviving a default. Invalid mappings preserve the previous valid chart and the repairable draft. Properties reflow below the preview on narrow layouts, while exact-data tables retain local scroll ownership.

Native selectors for bounded observation/interval inspection and compact fixture scope remain intentional, retaining labelled native keyboard and touch behaviour. Searchable field and visualization authoring uses GammaSelect; this does not imply migration of every lens control.

Grid Balance uses a two-column comparison layout for flow, demand forecast, reserve, storage, contingencies and merit order, with full-width asset evidence. The layout becomes one column at its maintained narrow threshold. Preserve independent MW/MWh meanings and the fixed dispatch snapshot as time inspection changes. Orbital Contact places aligned elevation, link-margin and throughput lanes beside the contact's margin budget and gives the schedule its own full-width row. The lens owns shared contact selection; standalone widgets retain a local picker, which the editor can explicitly enable. Shared UTC alignment and separate unit-labelled lanes support exact comparisons without a dual-unit axis.

Wafer cross-sections use physical millimetres, bin-coloured measured points and a separate unmeasured lane. Follow-up distributions distinguish observed endpoints from right-censors and identify their selected-cohort denominator. These additions share panel and inspection anatomy while retaining their analytical meanings. Presentation overrides belong to their renderer; current source identity belongs to the lens. Applying a compatible alternative must not carry unrelated family configuration or selection keys into it. Editing remains local to the lab session.

## Iteration 11 — fluid Edge Watch and Reliability Room

Operational reference dashboards use the full available container at every width. Their outer dimensions and panel heights follow content; the 1592 × 988 canvas is reserved for explicit source-size and comparison modes. A measured container selects desktop columns, tablet rows or mobile stacking. Keep navigation, labels, controls, flags and inspection text in readable CSS pixels while the plotting area grows or contracts.

Reference plots measure their actual content width and derive bounded plot height. The same geometry maps paths, selected points, zero lines, thresholds, incident bands and missing-data intervals. Axis density responds to available space, while exact selected values and time windows survive resizing. Both transient and pinned inspectors now use the shared floating owner. Hover follows raw pointer coordinates; a deliberate pin freezes its anchor while viewport changes still re-clamp the popup. Removing the old inline inspector must not leave an empty layout column.

Adaptive maps preserve projection aspect, camera and stable location identity. Visible marks and 28px hit regions compensate for the outer SVG scale; camera zoom changes positions without inflating symbols. Selected location details flow below the map. Source-risk flags preserve their 11:7 ratio, with compact labelled records below a 520px panel width. The outcome plot retains every reconstructed bucket and exposes a native exact-bucket picker.

Reliability timelines retain all 85 states per service. Tick density adapts to panel width; native service/interval controls and an explicit Inspect action provide exact access to dense bins. Tables wrap prose and keep complete records in named keyboard-reachable local scroll regions. Short viewports scroll the document, with menus bounded to their visible height.

The development-only `docs/qa/responsive.html` harness exercises real iframe browsing-context viewports without transforming an artboard. Executed width checks, selected-state evidence, screenshot paths and remaining coverage limits are recorded in `docs/iteration-11-responsive-reference-dashboards.md`.

## Shared tooltip and authoring ownership

Every `WidgetVisualization` hosts `WidgetTooltipProvider`, which records pointer and keyboard anchors without rendering the chart again. `ObservationTooltip` alone owns the portal, Gamma theme inheritance, dimensions, viewport collision handling and popup scrolling. `ChartTooltip` and `DomainInspector` adapt exact family content into this owner; no family positions its own floating frame. A short bounded dismissal grace allows the user to cross from a mark into its interactive evidence. Source replacement and disabled inspection invalidate obsolete pins.

The editor has a separate Tooltip section backed by strict common `WidgetOptions`: visibility, comfortable/compact density, preferred side, pointer offset and width/height caps. These are presentation choices against already loaded observations. Preferred placement always yields to available viewport space. Explicit close/Escape return focus to the source; ordinary pointer departure does not move keyboard focus. Dismiss callbacks share `restoreTooltipFocus`, which also preserves the new target during an outside pointer dismissal.

`DashboardWorkbench` owns one editor and session override map per route. Every rendered canonical panel receives `WidgetPanelActions` through `useDashboardPanels`, including catalogue, baseline, analytical, literal-reference and domain dashboards. The menu uses the existing `GammaActionMenu`. Apply preserves the panel ID, provider, query, queryRef, layout and current lens scope; Reset restores presentation defaults. Done editing retains applied session changes, while route changes/reload discard them. Authored evidence views expose their actual details actions without pretending to be configurable widgets.
