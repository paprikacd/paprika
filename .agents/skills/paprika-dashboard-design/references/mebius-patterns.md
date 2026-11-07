# Mebius chart study: mechanisms to adapt for Paprika

## Contents

- What was verified
- Visual mechanisms
- Motion and interaction mechanisms
- Translating the reference into Paprika
- Validation
- Reuse boundary
- Sources

## What was verified

Research snapshot: **2026-10-30**. The official [charts page](https://www.mebius.design/freebies/charts) advertises **62 chart cards**, a Figma file, and animated React, TypeScript and Tailwind v4 code for the shadcn CLI. Its public installation-dialog implementation names React 19 and anime.js. Treat Mebius as a designed component collection and implementation reference, not a general plotting engine equivalent to D3 or visx. The count describes cards/variants, not 62 independent chart grammars.

Evidence has three distinct levels:

1. **Visually inspected:** official static previews for Cash Flow Area, Overview and Spending Overview Range. These establish composition, typography, marks, selection treatments and shown tooltip states.
2. **Source inspected:** the public demo's compiled modules for those three cards, Budget Health, shared animation helpers and chart sizing. These establish implemented timelines, rendering and event handling. Descriptions below report code paths, not motion observed in an interactive browser session.
3. **Not established:** production performance, assistive-technology behavior, complete keyboard coverage, every catalog card, or the behavior of the account-gated downloadable package. A polished preview does not establish these properties.

The inspected examples combine SVG marks with HTML controls and overlays. This separation is useful: data geometry, an exact-value inspector, and a native interaction target need not be implemented by the same rendering surface.

## Visual mechanisms

| Inspected treatment | What it contributes | Paprika adaptation and constraint |
| --- | --- | --- |
| Cash Flow Area: a thin blue current line, neutral comparison line, and a vertical fill fading from 24% opacity to transparent | Establishes a primary series while retaining a comparison in the same plot | Resolve colors from Gamma and series identity. Keep the authoritative stroke legible independently of its fill. Name/dash the comparison; low opacity alone is insufficient. Use an area only when its baseline has meaningful semantics. |
| Cash Flow Area: a dashed observation cursor, separate dots for both values, emphasized axis label and adjacent comparison card | Connects an exact time to both series and their difference | Align all marks to one timestamp. Show units and comparison period; distinguish missing comparison data from zero. Delta direction is not automatically success or failure. |
| Cash Flow Area: compact white tooltip with a fine outline and two soft shadow layers | Separates detail from busy geometry without a heavy panel | Use a restrained elevation token in both themes. Keep the card inside its usable viewport, with a stable anchored position and readable text. Do not let a decorative halo substitute for focus contrast. |
| Overview: a selected run of green bars against neutral context; lighter and darker gradient variants within the selected run | Makes a selected time interval readable while preserving outside context | Retain entity identity and use a selection outline/band or controlled emphasis. If two treatments mean different cohorts, name them. Do not imply two statuses through unexplained brightness. |
| Overview: an orange range track/handles plus a summary containing dates, aggregate and comparison | Makes an interval an actionable object with its own result | Give the range exact start/end timestamps, visible handles, a keyboard route and a clear action. Calculate the summary from the full eligible data, not the rendered/downsampled marks. Paprika primary accent may identify interaction without recoloring the underlying series. |
| Spending Overview Range: rounded floating segments with clipped orange/red subranges, sparse horizontal guides and quiet context marks | Reveals ranges and exceptions with little visual mass | Use for real bounded values or an explicitly defined interval grammar. Explain each segment. Do not use this shape as decoration for an ordinary total; radius and gaps must not erase a tiny magnitude or imply missing data. |
| All three: prominent summary values, subordinate explanatory text, consistent alignment and few controls near the title | Separates overview reading from detailed inspection | Keep the hierarchy while tightening it for actual Paprika widget sizes. Large showroom padding, pale labels and large numerals are not a density or contrast specification. |
| Overview and Range: rounded controls, small inner highlights and soft edge shadows | Provides tactile affordance at the interaction layer | Reuse Gamma controls and focus states. Preserve flat, measurable geometry for data; do not add gloss, extrusion or shadows that change the apparent extent of marks. |

The reference's character comes from a coordinated treatment of geometry, inspection, color and spacing. Applying a gradient to an otherwise incoherent chart does not reproduce that quality. Avoid copying its large-card proportions into an incident dashboard containing many simultaneous panels.

## Motion and interaction mechanisms

These are **source-verified examples**, not proposed Paprika timing defaults. Follow [motion and effects](motion-and-effects.md) for Paprika's motion contract.

| Public implementation | Useful mechanism | Paprika decision |
| --- | --- | --- |
| Cash Flow Area draws the two strokes, reveals the area through a clip rectangle, staggers axes/labels, and counts summary values over 1,400 ms | A coordinated reveal can explain how a chart is assembled | Render operational values immediately. Consider a short reveal only in an explicit onboarding/presentation mode. Do not replay a draw-from-zero sequence on refresh or mount after virtualization. |
| Overview grows bars over 800 ms with 6 ms staggering and crossfades selected base/fill layers over 500 ms | Selection can change emphasis while preserving mark position | Prefer a brief state transition that leaves the data geometry and time scale fixed. Bound total duration rather than multiplying delay by an unbounded number of marks. |
| Cash Flow Area opens its tooltip with opacity/scale over 300 ms; Range uses a 350 ms entrance with `outBack` easing | An inspector can appear at the point of attention | Use immediate or short non-overshooting transitions during scrubbing. Never make the inspector chase the pointer so slowly that its value appears to belong to another sample. |
| Range animates segment geometry in drop/rise phases and uses `outBack(1.4)` on the rise; Budget Health uses overshooting badge entrances | Choreography is intentional and reusable at the affordance layer | Do not apply overshoot to numerical geometry, thresholds, meter positions or range bounds. An intermediate drawn value must not suggest a transient event that never occurred. |
| The shared animation helper listens for reduced-motion changes, skips the entrance timeline when reduction is requested, and starts ordinary entrance playback using an IntersectionObserver with a default 25% threshold | Motion policy and lifecycle belong in a shared owner | Centralize reduced-motion and visibility policy. Keep final values and controls usable when animation is disabled; treat reduced motion as a supported state. |
| Shared timelines disconnect observers and revert on cleanup; value transitions cancel previous animation and cancel on unmount | Interrupted work should not leave stale transforms or duplicate animations | Cancel on replacement, removal and scope changes. Repeated refreshes must not accumulate animation work or leave an inspector attached to obsolete data. |
| The sizing helper observes each chart's content box with ResizeObserver and skips state changes when size is unchanged | Measure a widget independently of the browser viewport | Use Paprika's established sizing owner. Reflow ticks, labels and controls at small panel widths; a scaled screenshot or iframe is not a responsive-layout test. |
| Cash Flow/Overview expose slider roles, value text and keyboard handlers. Range exposes pressed selection and roving tab stops; public code includes Escape clearing | Exact inspection is a first-class interaction, beyond decorative hover | Verify Paprika's complete keyboard, touch, pin/unpin and dismissal behavior. A detected ARIA attribute is evidence of an implementation attempt, not proof of accessibility. |

The demo shell also contains simulated pointer movement for showroom hover playback, guarded by reduced-motion preference. This is presentation machinery. Operational dashboards should let real user input control observation and selection.

## Translating the reference into Paprika

Start from one analytical job and one coherent treatment, such as **current versus prior period with a pinned comparison inspector**, or **interval selection with an exact aggregate**. Do not begin by adding every visible effect.

1. Establish the data contract, time alignment, aggregation, gap semantics, series identity and baseline before styling. A finance-oriented sample is not a model for telemetry semantics.
2. Inspect the existing chart and interaction owner. Keep Gamma, the current renderer and controls unless a demonstrated capability gap justifies a change. Importing Tailwind/shadcn/anime.js is not necessary to adopt a visual mechanism.
3. Assign independent roles to series, reference, status, selection and focus. Preserve these roles across light/dark themes, hover, pinned state and refresh.
4. Implement geometry and exact values first; add the smallest fill, outline, shadow or transition that clarifies the chosen interaction. Scope SVG gradients, masks and clip-path IDs to the widget instance so repeated panels do not share resources accidentally.
5. Review a realistic dense dashboard, not only an isolated example. Shared-time alignment, compact labels, quiet grids and a reliable inspector usually contribute more than a new animation dependency.

## Validation

Use the existing [validation gates](validation.md), plus these reference-specific checks:

- **Truth:** fading fill does not hide missing segments; comparison timestamps and units align; selection summaries use the correct full-resolution data; rounded segments preserve endpoints and zero semantics.
- **Interaction:** pointer, touch and keyboard reach equivalent exact values; selection is visibly different from hover; clear/dismiss works; result replacement or scope changes clear observations, pins and their cursors. Re-resolve geometry only within the same result version; do not silently move a pin into new data.
- **Appearance:** inspect both supported themes, a narrow widget, many series and multiple repeated widgets. Measure rendered contrast for actual labels, marks and selection; do not inherit the reference's pale palette without checking it.
- **Motion:** reduced motion reaches the same final state; live refresh does not replay entrance choreography; no overshoot changes a measured value; interruption/unmount removes observers and pending animation.
- **Density and performance:** inspect the whole dashboard during refresh and continuous scrubbing. A single successful card preview cannot establish many-panel performance.

## Reuse boundary

The page publicly offers installation through the mebius shadcn registry, including `@mebius/charts-theme` and named chart items. Its public dialog implementation gates copying code, downloading the `.fig` file and obtaining the installation prompt behind a mebius account. Public demos and their normally served compiled modules were inspected; no account flow, protected download or component installation was performed.

The general [Mebius license](https://www.mebius.design/license), updated October 21, 2026, is framed around purchased kits. It permits customized commercial interfaces but restricts file redistribution, component libraries and certain builder/competing-product uses. The inspected public material does **not establish the exact free-chart license or permission for Paprika's builder use**. Verify those terms before adopting components. This skill contains original design guidance, not redistributed Mebius code, artwork or assets.

## Sources

Prefer stable page/demo links when revisiting the research. Hashed bundle URLs below identify the inspected snapshot and may change on a later deployment.

| Source | Exact URL |
| --- | --- |
| Official collection and advertised scope | https://www.mebius.design/freebies/charts |
| Cash Flow Area public demo | https://www.mebius.design/demo/charts-cash-flow-area?canvas=none |
| Overview public demo | https://www.mebius.design/demo/charts-overview?canvas=none |
| Spending Overview Range public demo | https://www.mebius.design/demo/charts-spending-overview-range?canvas=none |
| Budget Health public demo | https://www.mebius.design/demo/charts-budget-health?canvas=none |
| Inspected Cash Flow preview | https://www.mebius.design/kits/charts/previews/charts-cash-flow-area.webp |
| Inspected Overview preview | https://www.mebius.design/kits/charts/previews/charts-overview.webp |
| Inspected Range preview | https://www.mebius.design/kits/charts/previews/charts-spending-overview-range.webp |
| General license | https://www.mebius.design/license |
| Public installation/preview dialog bundle | https://www.mebius.design/_next/static/immutable/chunks/36bf4azobupgu.js |
| Demo shell and module routing | https://www.mebius.design/kits/charts/demo/assets/index-CqR7HRY6.js |
| Cash Flow Area implementation snapshot | https://www.mebius.design/kits/charts/demo/assets/cash-flow-area-Bws01uaO.js |
| Overview implementation snapshot | https://www.mebius.design/kits/charts/demo/assets/overview-XPiwNCFp.js |
| Range implementation snapshot | https://www.mebius.design/kits/charts/demo/assets/spending-overview-range-C2cDWi_L.js |
| Budget Health implementation snapshot | https://www.mebius.design/kits/charts/demo/assets/budget-health-CcCG5jU7.js |
| Shared animation and formatting helpers | https://www.mebius.design/kits/charts/demo/assets/frame-C7JUoDZ1.js |
| Container sizing helper | https://www.mebius.design/kits/charts/demo/assets/use-chart-size-U0viV_V9.js |
| Public demo CSS | https://www.mebius.design/kits/charts/demo/assets/index-DS1J0FhE.css |
