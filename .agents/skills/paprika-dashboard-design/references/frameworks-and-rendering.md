# Frameworks and rendering

Use this reference when choosing a renderer, adding an unusual chart family, changing motion, or investigating a measured rendering bottleneck. Apply the visual policy in [motion and effects](motion-and-effects.md) independently of a library's demonstration defaults.

## Contents

- [Choose the existing owner first](#choose-the-existing-owner-first)
- [Version and documentation discipline](#version-and-documentation-discipline)
- [Compare responsibilities](#compare-responsibilities)
- [Use the released TanStack capabilities](#use-the-released-tanstack-capabilities)
- [Use D3 as a precise toolkit](#use-d3-as-a-precise-toolkit)
- [Evaluate visx as a React composition alternative](#evaluate-visx-as-a-react-composition-alternative)
- [Validate extension boundaries](#validate-extension-boundaries)
- [Primary sources](#primary-sources)

## Choose the existing owner first

Preserve Paprika's current TanStack chart host and existing D3-based plugin boundary unless a concrete requirement exceeds them. Extend shared theme, inspection, and renderer owners before creating parallel implementations. A gradient, rounded bar, attractive tooltip, or smooth transition alone does not justify a library migration.

Treat the frameworks as different allocations of responsibility. D3 provides calculation, geometry, and interaction tools; visx composes React visualization primitives; TanStack Charts supplies a typed chart definition and shared rendering/interaction host. TanStack itself depends on D3 modules. Compare the implementation needed to satisfy Paprika's contract, not a count of gallery examples. [T1, D1, V1]

Treat a visual kit as reference material or reusable presentation code after examining its actual implementation. Its appearance does not establish the rendering, accessibility, streaming, or analytical behavior of these frameworks.

## Version and documentation discipline

Research snapshot: **2026-10-30**. Refresh versions and installed exports before implementation; these are source findings, not results from a Paprika runtime benchmark.

| Dependency | Verified baseline | Consequence |
| --- | --- | --- |
| `@tanstack/charts` | Paprika's inspected manifest pins `1.1.0`; the official site identifies it as the latest published release at this snapshot. `/latest` documentation follows unreleased `main`. | Use the `v1.1.0` source links below for capabilities. Do not assume every current website example exists in the lockfile. [T0, T1] |
| visx | Official `v4.0.0` source; XYChart peers accept React 18 or 19 and `@react-spring/web` 9.7.5 or 10. | Do not repeat obsolete claims that visx cannot support React 19. Check the selected package manifests and migration changes before adopting it. [V2] |
| D3 | Official documentation displays D3 `7.9.0`; Paprika's direct shape dependency is `d3-shape` `3.2.0`. | D3's aggregate version differs from independently versioned modules. Check the module actually imported. [D1, D2] |

Source-verified TanStack `1.1.0` includes optional Canvas rendering, mixed renderer marks, `svgAnimation`, the optional `motion()` renderer, scoped gradients, keyboard focus, brush and zoom accessibility hooks. These are released capabilities; their presence does not mean Paprika already exposes or tests them. [T1–T5]

## Compare responsibilities

| Dimension | D3 | visx | TanStack Charts |
| --- | --- | --- | --- |
| Composition | Choose independent scales, shapes, layouts, selections, and behaviors; own the chart system. | Use React primitives; optionally use the higher-level Cartesian `XYChart`. | Define marks/scales in a typed specification; use a shared host and renderer. |
| React ownership | Use pure calculations in JSX, or isolate a D3-owned DOM subtree. | React owns components and SVG elements. XYChart contexts coordinate scales, data, theme, events, and tooltip. | React adapter manages the chart host; definition identity controls rebuilding. |
| Rendering | Shape generators produce SVG path strings or draw to a Canvas 2D context; application owns the rendering pipeline. | Verified XYChart series render SVG. No general built-in Canvas/WebGL XYChart renderer was established in the inspected sources. | SVG default; optional Canvas 2D; selected marks may use Canvas while guides remain SVG. No released WebGL renderer was established. |
| Motion | DOM transitions and interpolation/timer tools; Canvas animation requires an application-owned loop. | Animated XYChart series and guides use React Spring. Nonanimated equivalents exist. | Default keyed SVG animation or separate optional SVG motion renderer; Canvas has different transition semantics. |
| Style | App-owned SVG/CSS/Canvas paint. | SVG props, theme contexts, and gradient primitives. | Theme tokens, palette variables, mark channels, resources, and tooltip tokens. |
| Interaction | Compose brush/zoom/drag/hit testing and accessible UI. | Compose pointer events, tooltip, brush/zoom; application supplies product semantics. | Shared focus, tooltip, cursor, brush, zoom, and lifecycle; application still supplies meaning and workflows. |
| Best Paprika use | Geometry, preparation, layouts, and specialist plugin gaps. | A scoped alternative when React composition solves a demonstrated requirement. | First choice for existing built-in panels and shared behavior. |

Sources: [D1–D4, V1–V7, T1–T7]. None of these libraries makes every chart accessible or every dataset fast by default.

## Use the released TanStack capabilities

### Choose an entry point deliberately

| Need | Verified `1.1.0` entry or API | Implementation boundary |
| --- | --- | --- |
| Existing React SVG charts | `@tanstack/charts/react` | Preserve the current canonical host and adapter. |
| Explicit renderer in React | `@tanstack/charts/react/core` | Pass the renderer; keep host behavior shared. |
| Optional whole-chart Canvas | `@tanstack/charts/react/canvas` | Verify the specific chart's paint and access behavior. |
| Dense marks within SVG chart | `canvasChartRenderer` from `@tanstack/charts/canvas`; mark `renderer` | Keep useful labels, axes, and focus in SVG; measure the mixed chart. |
| Existing SVG updates | Host `svgAnimation` | Use one animation owner for a geometry subtree. |
| Definition-level motion | `motion` from `@tanstack/charts/motion` | Select this renderer explicitly; a `motion` field alone is inert. |
| Timing policy without renderer import | `stagger` from `@tanstack/charts/motion/definition` | Keep optional animation code outside default paths. |

These exports are verified in the release package. Default entries exclude the optional Canvas and motion runtimes. Preserve that import boundary instead of importing every feature globally. [T1, T2]

Memoize a definition against its actual data/options dependencies. Use semantic keys for marks and observations within the current result version, especially when ordering or viewport positions change. Mark continuity across updates does not override Paprika's clearing of observations, pins and cursors on result replacement. Do not use array positions as entity identity or keep a stale definition merely to avoid updates. Distinguish source updates, resize, user filtering, and viewport movement in the host lifecycle. [T3]

### Apply a consistent visual vocabulary

Map Paprika tokens through the existing theme adapter. TanStack supports `foreground`, `muted`, `grid`, `background`, and `palette`; its six `--ts-chart-1` through `--ts-chart-6` variables allow palette changes at a container boundary. Keep severity and selection mappings explicit rather than deriving them from palette position. [T4]

Use mark paint channels for fill, stroke, opacity, stroke width, line caps, dashes, and supported corner radii. Express low-opacity area gradients through chart resources with a stable `idPrefix`; preserve the line as the exact boundary. `clip: true` constrains geometry to the plot, but does not repair an incorrect domain. Scope resource IDs across repeated dashboard panels. [T4]

Canvas nodes are not individually addressable CSS descendants. Put essential paint in mark/theme values, and verify the selected gradient type: the released renderer supports linear fill/stroke gradients and radial fills; radial gradient strokes are rejected. Validate actual text and paint under both themes. [T2]

Use tooltip tokens and the existing Paprika inspection owner. Check both the preferred Popover path and a fallback portal mounted under `document.body`: ancestor-scoped variables may be lost in the latter. Apply a suitable class or document-level fallback without introducing a second theme. [T4]

### Make motion semantics explicit

Use `svgAnimation` for brief keyed SVG updates when the current host supports the required behavior. It respects reduced motion through the host, skips resize animation by default, and begins interruptions from painted geometry. Direct use of the lower-level SVG reconciler requires the caller to enforce reduced motion. [T2, T3]

The optional SVG `motion()` renderer supports enter/update/exit policy, keyed interruption, tweens, and springs. It ignores `svgAnimation`; do not layer two animation owners. Its default entrance is 1,100 ms, which is a library default, not Paprika's recommended telemetry behavior. Explicitly choose a short functional policy and disable routine entrance playback. Use `tooltip.motion: false` when inspection must remain immediate. [T5]

Keep an immediate focus indicator in a separate `whenFocused` layer when needed: inline mark state changes can wait for data motion to settle, and a continuously updating feed may never settle. Definition-level motion is SVG-only; Canvas paints the final definition, while the default Canvas host's `svgAnimation` uses frame crossfades. Do not promise identical geometry animation across renderers. [T2, T5]

Treat rolling time-series motion as a constrained geometry operation, not arbitrary path morphing. The released rolling policy validates retained keys, unchanged retained samples, clipping, stable plot bounds, and compatible transforms; choose snap fallback when those conditions fail. Preserve real sample positions and give the app ownership of the visible window. Read the versioned guide before configuring `path.update: 'rolling'`. [T3]

## Use D3 as a precise toolkit

Prefer pure D3 scales, shape generators, formatting, statistics, and layouts under React-owned JSX. If `d3-selection`, `d3-axis`, or `d3-transition` mutates the DOM, isolate an owned ref subtree and clean it up. Never let React and D3 reconcile the same marks. [D1]

Use `line.defined(...)` to retain missing segments. A shape generator returns an SVG path unless given a drawing context; `.context(canvasContext)` is not a complete Canvas chart system. Preserve a visible isolated observation where one-point line segments would disappear. [D2]

Choose interpolation from metric meaning. Use linear segments for sampled telemetry unless there is a justified alternative; use steps for actual held states. `curveMonotoneX` avoids new local extrema between ordered x samples, but still implies values between observations. It cannot validate a metric or fill a gap. Avoid choosing a spline solely to make a trace look elegant. [D3]

Handle interruption and destruction deliberately. Same-name D3 transitions replace older transitions on their target elements; interrupting a parent does not interrupt its descendants. Clear both where appropriate and handle cancellation of transition promises. Own animation-frame cleanup for bespoke Canvas work. [D4]

Use D3's layout and interaction modules as computation tools; keep titles, focus order, exact-value access, controls, resource limits, and Paprika event integration in the chart contract. Do not advertise a built-in WebGL renderer merely because D3 geometry could feed one. [D5]

## Evaluate visx as a React composition alternative

Distinguish low-level visx packages from `@visx/xychart`. XYChart supplies shared scales, dimensions, a data registry, theme, events, and tooltip; its animated and static series are interchangeable at the component level. `buildChartTheme` exposes label, axis, grid, and palette styling. [V1]

Reuse semantic `dataKey` identity and control color assignment explicitly. SVG `LinearGradient`/`RadialGradient` resources make layered fills straightforward, but IDs must remain unique across dashboard instances. Separate brush and zoom packages provide interaction primitives; application state still owns the real time range, reset, constraints, and non-drag controls. [V3–V5]

Treat tooltip alignment as an analytical decision. XYChart reports a nearest datum and nearest candidates for each series; these do not prove that all series share the same timestamp. Apply Paprika's timestamp alignment and tolerance rules before presenting a synchronized comparison. XYChart focus hooks and SVG keyboard targeting are building blocks, not complete accessibility. [V1]

Inspect the animated component actually used. In `v4.0.0`, `AnimatedPath` uses React Spring and path interpolation with reset behavior and a short previous-path debounce. Do not infer stable high-frequency streaming or preserved interruption velocity from a smooth gallery example. Verify rapid updates and topology changes; use static marks when motion adds no investigative value. [V6]

Budget migration for host lifecycle, normalized results, context events, keyboard/touch behavior, loading/error states, SSR, resource IDs, and test coverage. Adoption is justified by a measured requirement and a coherent integration plan, not by replacing an already adequate renderer for aesthetic reasons.

## Validate extension boundaries

**Accessibility:** TanStack's released host provides naming, keyboard focus, accessible legends, and keyboard paths for brush/zoom, but the application must supply chart meaning, exact-value alternatives, and usable task flows. A keyboard brush does not by itself supply a non-drag pointer alternative. Preserve focus through updates and test transient versus pinned tooltip behavior. Apply equivalent requirements to bespoke D3 and visx implementations. [T6]

**Performance:** Record source rows, represented observations, prepared geometry, and rendered marks separately. Canvas reduces SVG DOM work, but does not remove TanStack's scene construction or interaction points; default nearest-point focus remains linear without an index. Aggregate or bound the representation first, then measure compilation, paint, interaction, and memory. Use a spatial index only when individual observations remain the appropriate target. Never adopt a universal “switch at N points” rule. [T7]

**Acceptance:** Check a repeated panel with unique gradient IDs; theme changes with an open tooltip; a zero-width container becoming visible; reduced motion; updates arriving faster than a transition; a stationary pointer during data movement; and destruction during animation. Compare exact values and gaps between renderer variants. Test only the boundaries actually changed, and distinguish source verification from browser or benchmark evidence.

## Primary sources

- **T0:** [TanStack overview and latest-documentation warning](https://tanstack.com/charts/latest/docs/overview).
- **T1:** [TanStack `v1.1.0` package manifest and exports](https://github.com/TanStack/charts/blob/v1.1.0/packages/charts-core/package.json).
- **T2:** [TanStack `v1.1.0` rendering and export](https://github.com/TanStack/charts/blob/v1.1.0/docs/reference/rendering-and-export.md).
- **T3:** [TanStack `v1.1.0` dynamic data and animation](https://github.com/TanStack/charts/blob/v1.1.0/docs/guides/dynamic-data-and-animation.md).
- **T4:** [TanStack `v1.1.0` themes and styling](https://github.com/TanStack/charts/blob/v1.1.0/docs/guides/themes-and-styling.md).
- **T5:** [TanStack `v1.1.0` motion reference](https://github.com/TanStack/charts/blob/v1.1.0/docs/reference/motion.md).
- **T6:** [TanStack `v1.1.0` accessibility](https://github.com/TanStack/charts/blob/v1.1.0/docs/guides/accessibility.md).
- **T7:** [TanStack `v1.1.0` large data](https://github.com/TanStack/charts/blob/v1.1.0/docs/guides/large-data.md).
- **D1:** [D3 getting started, including React integration](https://d3js.org/getting-started).
- **D2:** [D3 line generator, missing segments, and drawing contexts](https://d3js.org/d3-shape/line).
- **D3:** [D3 curve semantics](https://d3js.org/d3-shape/curve).
- **D4:** [D3 transition control flow and interruption](https://d3js.org/d3-transition/control-flow).
- **D5:** [D3 API index](https://d3js.org/api).
- **V1:** [visx `v4.0.0` XYChart documentation](https://github.com/airbnb/visx/blob/v4.0.0/packages/visx-xychart/README.md).
- **V2:** [visx `v4.0.0` XYChart manifest and peer dependencies](https://github.com/airbnb/visx/blob/v4.0.0/packages/visx-xychart/package.json).
- **V3:** [visx `v4.0.0` gradient primitives](https://github.com/airbnb/visx/blob/v4.0.0/packages/visx-gradient/Readme.md).
- **V4:** [visx `v4.0.0` zoom primitive](https://github.com/airbnb/visx/blob/v4.0.0/packages/visx-zoom/Readme.md).
- **V5:** [visx `v4.0.0` brush primitive](https://github.com/airbnb/visx/blob/v4.0.0/packages/visx-brush/Readme.md).
- **V6:** [visx `v4.0.0` animated path implementation](https://github.com/airbnb/visx/blob/v4.0.0/packages/visx-xychart/src/components/series/private/AnimatedPath.tsx).
- **V7:** [visx package approach](https://visx.airbnb.tech/).
