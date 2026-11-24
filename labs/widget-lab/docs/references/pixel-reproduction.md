# Reproduce a supplied dashboard literally

## Contents

- Establish the reproduction contract
- Measure before implementing
- Build the reference as native UI
- Compare equal-size captures
- Edge Watch geometry
- Reliability Room geometry
- Typography and sampled palette
- Finish with an honest comparison

## Establish the reproduction contract

Use this workflow when the user asks for pixel reproduction, a replica, exact matching, or corrects a design that remains significantly different. Treat the supplied image as the visual specification. Do not substitute a new shell, a generic dashboard template, a preferred font, fewer rows, or a different panel merely because it already exists in the lab.

Open the original image at its native dimensions. Identify whether it is a concept, a working product screenshot, or measured chart evidence. Preserve its concept/synthetic disclosure. For an authored concept, copy its visible labels, values, dates, table records and selected state when literal reproduction is requested. Record inconsistent labels, axes or accounting in the implementation notes; do not claim they reconcile into one operational dataset. Keep any existing tested analytical lab reachable when useful, without making a separate app a universal requirement.

Write a small reproduction manifest: source path and dimensions; target canvas and capture dimensions; device scale; fonts and assets; initial hover/pin, filters and date; fixed versus interactive elements; synthetic fixture or real result identity; known occlusion and reconstruction. Keep evaluation controls out of the default reference state. An explicitly opened source-overlay comparator may cover the canvas during review; close it for the implementation capture.

## Measure before implementing

Map the canvas, rail, title, toolbar, cards, panel bounds, plot rectangles, legends, inspector, table columns and row baselines. Verify repeated-mark counts from the source pixels or measured divider pitch: visual estimates can be substantially wrong (the current references have 28 visible outcome bars and approximately 85 timeline cells per row). Record x/y/width/height in source pixels. Measure the actual reference, not a downscaled chat thumbnail. Preserve distinct shells when references differ; sharing code does not require identical geometry.

Inventory visual density: destination/service counts, timeline cells, number and width of bars, flag/icon sizes, sparkline lengths, tick positions, legend order and open overlays. Record actual text, casing, line breaks and precision. Match font family or nearest verified substitute, weight, size, line height, letter spacing and tabular figures. Typography changes can move every downstream alignment.

Sample background, border, grid, data and text colours separately. Preserve differences between references and local gradients. A single shared dark palette can still be visibly wrong. Record approximate measurements as approximate; do not invent confidence or exact font identification from raster appearance.

Fix structural differences before micro-effects: shell and panel geometry → content/typography → plots and assets → selection and motion. Missing maps, flags, risk bars, incident bands or a selected inspector are structural failures, even if the surrounding cards are polished.

## Build the reference as native UI

Implement real HTML/CSS/SVG components and interactive controls. Do not make the screenshot a page background, flatten the dashboard into a raster, or place transparent controls over it. Use the existing Paprika host and trusted registry where applicable; a documented registry extension can own authored concept geometry without introducing another chart library or dashboard schema.

Trace visible vector paths when that is the closest faithful reconstruction. Name the output **authored concept geometry**, not recovered measured telemetry. A screenshot cannot establish original sampling cadence, integrated counts or measurement precision. Record occluded spans as reconstructed; keep reconstructions bounded by visible entry/exit shape instead of inventing extra events. Preserve source hatching, threshold placement and apparent curve envelope in a replica while documenting illustrative axis inconsistencies.

Keep accessible DOM labels and keyboard-reachable controls. When source controls have no defined backend, implement a meaningful local fixture action or describe the available reference state; do not present unsupported live queries. Preserve exact fixture values in inspection. Freeze deterministic initial state for capture, including the reference's open inspector, while retaining dismissal and exploration. Do not add entrance choreography or replay that changes the target before comparison.

Use measured reference dimensions first. After the primary artboard matches, add responsive behavior as the requested scope requires. A scaled-down preview can aid navigation, but it is not the pixel-comparison artifact.

## Compare equal-size captures

1. Render at the source canvas dimensions and capture at the same pixel dimensions and state. For both bundled primary references, use **1592 × 988**. Record any difference between browser viewport and fixed artboard capture; do not silently resize either image to hide it.
2. Wait for fonts and assets to render and motion to settle. Keep the fixture, selected point, month and filters deterministic. Capture the actual application through the permitted browser workflow.
3. Compare the full image side by side and with a registered overlay or image difference. Alignment should follow the measured canvas, not a best-fit rescaling that disguises incorrect panel geometry. Inspect important regions independently: shell, metrics, main plot, inspector, tables, timeline/map and calendar.
4. Use numerical difference as a diagnostic, with the exact method, alignment and regions recorded. Whole-image averages can be dominated by dark background; antialiasing and font rasterization can inflate text differences. Inspect edge displacement, panel bounds, baseline drift and local colour residuals alongside human visual comparison.
5. Fix the largest concrete mismatches, recapture, and compare again. Do not stop at passing numerical/data tests when a defining panel or shell still differs. Do not convert a raw difference statistic into an unsupported “fidelity percentage.”

Image analysis and comparison tools may measure existing captures according to the available tool policy. Keep those artifacts distinct from the unmodified implementation screenshots. Static comparison establishes appearance only; exercise implemented controls, dismissal, focus, replay and reduced motion separately when applicable.

## Edge Watch geometry

Use [the bundled Edge reference](../assets/reference-edge-watch.png). Coordinates are measured on its 1592 × 988 canvas; boundary estimates are generally within 1–2px and should be checked against the image.

| Region | x | y | Width | Height |
| --- | ---: | ---: | ---: | ---: |
| Full-height rail | 0 | 0 | 79 | 988 |
| Main frame | 87 | 65 | 1488 | 904 |
| Title origin | 107 | 18 | — | 19 |
| Subtitle origin | 108 | 40 | — | 15 |
| Ingress card | 98 | 120 | 364 | 87 |
| Egress card | 470 | 120 | 355 | 87 |
| Blocked card | 833 | 120 | 354 | 87 |
| Connections card | 1194 | 120 | 369 | 87 |
| Traffic panel | 98 | 218 | 948 | 332 |
| Destinations | 1055 | 218 | 508 | 332 |
| Geography | 98 | 560 | 468 | 220 |
| Outcomes | 576 | 560 | 469 | 220 |
| Risk | 1055 | 560 | 508 | 220 |
| Blocked requests | 98 | 789 | 1465 | 170 |
| Traffic plot | 154 | 276 | 874 | 200 |
| Open inspector | 717 | 269 | 242 | 251 |

Match toolbar controls near y76 with 34px height. Place the first metric icon at 109/130, approximately 44px square; label/value start at x173. Use the visible values **842.15 Mb/s, 218.46 Mb/s, 2.14%, 18,432** for the reference fixture. Preserve the cyan/violet plot, zero baseline near y389, selected guide near x643, and bottom legend near y529.

Render ten destination rows on about 26px pitch, with columns beginning near x1075/1112/1254/1349/1539. Render five risk rows with flags, sparklines and segmented scores. Geography occupies approximately x110–553/y600–772. Outcomes plot occupies x625–1028/y609–722. Preserve four blocked-request records and their approximately 25px row pitch. Do not replace these panels with gateway or protocol cards in literal mode.

## Reliability Room geometry

Use [the bundled Reliability reference](../assets/reference-reliability-room.png). Its title spans above the rail; it does not share Edge's full-height rail or 87px metrics.

| Region | x | y | Width | Height |
| --- | ---: | ---: | ---: | ---: |
| Title origin | 26 | 20 | — | 18 |
| Subtitle origin | 26 | 45 | — | 15 |
| Rail below title | 12 | 65 | 66 | 917 |
| Content frame | 78 | 65 | 1499 | 917 |
| Achieved card | 90 | 121 | 464 | 143 |
| Target card | 563 | 121 | 462 | 143 |
| Budget card | 1034 | 121 | 531 | 143 |
| Burn panel | 90 | 273 | 935 | 306 |
| Services | 1034 | 273 | 531 | 306 |
| Timeline | 90 | 589 | 935 | 229 |
| Calendar | 1034 | 589 | 531 | 229 |
| Recent incidents | 90 | 826 | 1475 | 156 |
| Burn plot | 143 | 326 | 859 | 182 |
| Open inspector | 602 | 307 | 214 | 243 |
| Calendar grid | 1046 | 626 | 507 | 157 |

Preserve the visible values **99.96%, 99.90%, 60.00%**. The achieved icon starts near 105/133, label/value at x173; target icon near 576/133, text at x641; budget icon near 1047/133, text at x1109. The budget bar is approximately x1049/y204/w503/h20. Preserve the source's mini-plots, target legend and accounting text rather than replacing them with a generic one-line summary.

Render six service and six timeline rows. Timeline cells span x203–1006, with approximately 85 cells per row at about 9.5px pitch, 15px row height and 21–22px pitch. Preserve amber/red/unknown runs. The calendar has seven roughly 72.4px columns, a weekday header and five date rows for May 2024. Preserve selected date 16, incident fills and unknown-date hatching. The burn plot includes the incident band near x297–347, unknown band near x835–920, selected guide near x562, and source tick positions; document its irregular illustrative axis spacing rather than claim linear recovered measurements.

## Typography and sampled palette

Compare actual rendered glyph widths rather than identify a font from the raster alone. Roboto Condensed looked plausible in image inspection but proved too narrow in the working reproduction; Barlow body text with Roboto titles and metric digits was closer in the subsequent render review. Treat these as candidates, not an assertion about the source's exact faces. Initial measurements: body/table 13–14px; panel titles about 17px/500; Edge metrics 30px; Reliability metrics 36px; page title 16px with about 4px tracking; subtitle 14px with about 1.5–2px tracking. Match line breaks and column fit before reducing type.

| Role | Edge sample | Reliability sample |
| --- | --- | --- |
| Header canvas | `#091C2B` | `#051921` |
| Rail | `#05141C` | `#021218` |
| Panel/plot | `#081C26` | about `#061B22` |
| Border | `#142D3D` | `#102A36` |
| Cyan legend | `#02E8FC` | `#05ACF9` |
| Violet legend | `#9267F4` | `#7F4EF8` |
| Amber | `#FBBC20` | `#F8BF47` |
| Red | `#FB4841` | `#F84846` |
| Inspector | `#031119` | `#021118` |

Treat these as sampled pixels/region medians, not a complete token system. Preserve Edge's bluer surfaces and Reliability's greener surfaces. Inspect contained area-fill strength, sharp line strokes and localized selection rings; global glow will not compensate for a wrong trace envelope.

## Finish with an honest comparison

Deliver actual rendered captures, the exact reference/capture dimensions and state, the major corrected differences, and any visible residuals. Distinguish visual fixture fidelity, source consistency, runtime interaction and analytical integration. Include the authored fixture and tracing/provenance notes in the code deliverable. Name remaining deviations directly; do not describe a substantially different layout as a pixel reproduction because its tests pass.

When the user asks to carry the result into the skill or reusable charts, apply [the transferable visual system](visual-system.md), [family coverage](chart-families.md), and [geographic charts](geographic-charts.md) for maps. Extract hierarchy, anatomy, layers and interaction contracts; retain traced profiles, illustrative contradictions, decorative locations and fixed coordinates in this fixture. Demonstrate promoted families on independent normalized data before describing the visual study as a general chart capability.
