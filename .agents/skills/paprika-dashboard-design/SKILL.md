---
name: paprika-dashboard-design
description: Design, build, refine, reproduce, and review beautiful charts and observability dashboards for Paprika Insights. Use for time-series panels, telemetry, profiling/flamegraphs, financial/portfolio lenses, allocation treemaps, dashboard composition and generation, data/schema discovery, field mapping, literal screenshot and pixel reproduction, reusable chart families and coverage, zoomable geographic maps, quantitative tables, timelines, calendars, chart plugins, D3/visx/TanStack rendering decisions, Mebius-inspired styling, animation/effects, legends, tooltips, synchronized inspection, themes, responsive density, chart editing/authoring, and quality audits. Guides visual grammar, metric semantics, canonical integration, accessible interactions, performance, fixtures, and validation. Not for Helm charts, deployment-only work, or generic marketing pages.
---

# Paprika Dashboard Design

Build an operational instrument that makes a difficult question easy to answer. Give the data the strongest visual voice; make scope, comparison, uncertainty, and the next investigation step legible. Earn distinction through precision and useful interactions.

Treat analytical truth and operational usability as release gates for analytical dashboards. For literal reproduction of a supplied concept, preserve the authored visual fixture and identify it as synthetic; document any source inconsistency instead of presenting the replica as reconciled analytics or live telemetry. Select the matching mode before changing the design.

## Start with the existing product

1. Read the repository's applicable agent instructions, current `DESIGN.md`, and Insights behavior contract. Follow [Paprika integration](references/paprika-integration.md) to locate the runtime owners and refresh the dated architecture snapshot. Confirm the target is Insights; its independently scoped themes do not redefine the main application.
2. Inspect one related renderer, its pure data transformation, its tests, the normalized result schema, and a current rendered example or checked-in visual fixture. Treat missing runtime access as an evidence limitation, never as evidence that a design works.
3. Reuse the existing Gamma controls, theme adapter, chart lifecycle, registry, scheduler, and document model. Extend their owner for recurring behavior; a trusted registry extension can render an authored HTML/SVG reference fixture. Do not install a new chart library or create a competing dashboard schema merely to achieve a look. Record extension and asset provenance.
4. Compose with installed `frontend-design` and `frontend-design-premium` for visual direction and production behavior, and Impeccable's **Operate** guidance for craft. Preserve the product's typography and geometry during adaptation; in explicit reproduction, match the reference's typography and geometry. Generic aesthetic preferences must not turn a requested replica into another design. This skill remains usable without those plugins; do not copy their full instructions or make their absence a blocker.
5. Use the repository's `paprika-observe` skill when the task requires live provider discovery, metric metadata, querying, or dashboard persistence. A design request does not authorize unrelated deployment actions. Never invent available metrics, labels, provider capabilities, or alert policies.

## Choose the scope of work

| Request | Do this |
| --- | --- |
| Add or refine one chart | Preserve the surface; define the panel question and semantics; change the canonical owner; verify affected states. |
| Build a dashboard | Establish its audience, decision and shared context; read visual-system and chart-family guidance; map each evidence role to an implemented family before layout. |
| Add or generalize a chart family | Check the existing registry and support level; implement data adapter, renderer, config validation, exact inspection, truthful controls, context emission and tests as one capability; demonstrate independent data. |
| Build or improve a map | Read geographic-chart guidance; declare location/encoding semantics and implement a bounded camera, selection, exact-data access and usable non-drag controls. |
| Build a financial lens or allocation treemap | Read financial-chart guidance; define valuation, currency, return and weight populations; reconcile totals and use nonnegative area with stable signed-change color. |
| Build or improve chart editing | Read dashboard-authoring guidance; reuse the schema and renderer for a live preview, compatible options and exact data; define draft, Apply/Discard and persistence behavior. |
| Discover data or generate a dashboard | Read schema-discovery-and-generation guidance; discover real source and renderer capabilities, validate semantic bindings, and emit the existing dashboard document with explicit interaction coverage. |
| Audit or critique | Inspect the actual target; report reproducible findings with severity, user impact, evidence, and a specific remedy. Do not redesign unrelated screens. |
| Explore concepts | Use clearly labelled deterministic synthetic data; compare compositions against the same analytical question and data. Never treat a generated image as measured chart evidence. |
| Reproduce a supplied screenshot | Use literal reproduction mode: copy the measured composition, authored fixture content, assets and initial state, then compare equal-size rendered captures. |

Ask only when an unresolved fact materially changes the outcome and cannot be learned from the repository or data. Otherwise state the assumption briefly and continue. Do not require a concept approval ritual for a routine extension.

## Select adaptation or literal reproduction

Use **adaptation** for requests to take inspiration, apply a style, or improve an existing analytical dashboard. Preserve its data contract and product behavior while adapting the reference's visual relationships.

Use **literal reproduction** for requests such as “pixel reproduction,” “replicate this,” “match exactly,” or corrections that the result still looks significantly different. Read [pixel reproduction](references/pixel-reproduction.md). Match the source canvas, shell, component bounds, typography, content density, labels/values and selected state before generalizing. Do not substitute approximate density budgets, force separate references into one shared shell, remove a defining panel, or redesign the source fixture. Keep the reference's synthetic/concept disclosure visible; record unresolved source contradictions and reconstructed geometry. Existing analytical studies may remain reachable when useful; a separate product is not universally required.

For new dashboards, substantial adaptation, reusable components, or lessons from a successful replica, read [the transferable visual system](references/visual-system.md) and [chart families and coverage](references/chart-families.md). Keep semantic data, visual grammar and authored reference fixtures separate. Preserve the relationships that made the reference readable—plot allocation, mark density, text geometry, aligned comparisons and selected-state composition—while deriving analytical values and geometry from actual data. Do not promote traced curves, index-based time positions, decorative map points or fixed tooltip coordinates into general chart algorithms.

## 1. Define the decision before the panel

For schema discovery, field mapping, generation, or converting a lens into a portable dashboard, read [schema discovery and generation](references/schema-discovery-and-generation.md). Discover source and renderer capabilities separately, validate their semantic binding against actual results, and compile into the existing dashboard document. A registered renderer does not establish whole-lens authorability or portable interactions.

For multi-family expansion, process reflection, or repeated integration failures, read [chart system evolution](references/chart-system-evolution.md). Consolidate recurring presentation and interaction behavior in maintained owners. Run a canonical-data and real-host preflight before scaling to more families; a longer checklist alone does not replace shared implementation.

Write a compact brief using [the brief template](assets/chart-brief.template.md) for substantial work; for a small fix, keep the same decisions in working notes:

- **Who and when:** on-call engineer, platform owner, developer investigating a release, or another actual audience.
- **Question and consequence:** what must they learn, and what action or next investigation follows?
- **Population and scope:** service, cluster, environment, tenant, grouping, filter, and comparison cohort.
- **Time:** range, timezone, sample cadence, query step, aggregation window, freshness, and refresh behavior.
- **Evidence:** metric kind, base/display unit, numerator/denominator, aggregation, missingness, uncertainty, and source limitations.
- **Visual coverage:** each important evidence role → family → registered owner or reusable primitive → missing capability → resting/selected/degraded state. Distinguish source availability, runtime registration, scene fixtures and proposals.

Choose the primary question, then rank secondary questions. A useful sequence is health or outcome → change → breakdown → evidence, but do not force every dashboard into four KPI cards or equal tiles. Give the critical comparison more space. Remove panels that do not change understanding or action.

Budget each family's anatomy before effects: title/actions, plot, legend, exact values and interaction surface. Design supporting maps, state histories and quantitative tables as carefully as the main line chart. Record whether each action inspects, highlights, filters locally, changes shared scope/time or navigates; identify its owner, affected panels and reset path.

Read [chart grammar and semantics](references/chart-grammar.md) before selecting an unfamiliar encoding or changing calculations. Read [visual craft](references/visual-craft.md) before visual planning.

For financial, portfolio or allocation views, read [financial charts](references/financial-charts.md). Define currency, valuation time and accounting population before comparing returns or assigning treemap area; keep snapshot and historical evidence reconciled.

For screenshot matching or widget-lab iteration, read [reference fidelity](references/reference-fidelity.md), open its two bundled reference images, and inspect the actual target. In adaptation, set an appropriate density budget and preserve the analytical fixture. In literal reproduction, also read [pixel reproduction](references/pixel-reproduction.md), measure the exact source canvas and bounds, and compare captures at the same pixel dimensions and state. Both bundled primary references are 1592 × 988; similar content widths alone are insufficient.

For a rendering-library decision, read [frameworks and rendering](references/frameworks-and-rendering.md). For animated or especially refined charts, also read [motion and effects](references/motion-and-effects.md); use [Mebius patterns](references/mebius-patterns.md) when adapting that reference. Choose the visual result independently from the implementation library. Inspect installed versions and released exports before using an API from a live documentation site.

## 2. Establish a truthful representation

Record the following before writing mark geometry:

| Contract | Required decision |
| --- | --- |
| Metric meaning | Gauge, counter, rate, ratio, distribution, state, event, trace, or record; valid population and aggregation. |
| Units | Base unit, displayed unit, actual conversion, denominator, precision, and threshold units. A suffix alone does not convert a value. Readings choose the display unit per value (`1 s` for 999.5 ms); set `decimals` to keep one authored unit and fixed precision. |
| Time | Authoritative bounds/timezone, sample timestamps, gaps, query step, and any visible panel override. |
| Encoding | Position/length/area/color meaning; domain; baseline; linear/log scale; stacking and interpolation policy. |
| Summary | What the large value and delta mean; original semantic result; comparison window; zero-denominator and stale-tail behavior. |
| Identity | Stable entity key, consistent categorical mapping, and distinction between category, severity, selection, and comparison. |

Apply these invariants:

- Preserve zero, null, absent series, stale data, partial/truncated results, and query errors as different states. Show imputation only when justified and explicitly distinguish it from observations.
- Apply counter rates before aggregation; derive fleet percentiles from compatible distributions, never averages of per-instance percentiles. Compute ratios from aggregated numerators and denominators where the question calls for population weighting.
- Preserve semantic values before visual reduction. Resizing, device pixel ratio, and renderer changes must not change a KPI, threshold decision, or exported semantic summary for the same data/window.
- Include zero for bar lengths and magnitude areas. Use a focused line domain when it helps comparison and remains clearly labelled. Treat true interval/range encodings separately. Require a reason for dual axes; prefer aligned panels for incompatible units.
- Retain gaps, meaningful extrema, and exact timestamps. Do not hide an incident with a smooth curve, stride sampler, or cosmetic average. Show aggregation and approximation where they affect interpretation.
- Keep observation value/time and latest value/time separately named. Unknown is not healthy. A deployment annotation is temporal context, not proof of causation.

For analytical dashboards, fix contradictory semantics before polishing. For a literal concept replica, preserve the requested authored fixture while identifying its synthetic nature and documenting source inconsistencies; do not silently change its composition or claim that traced geometry recovers measured telemetry. The reproduction contract supplements, rather than establishes, analytical validation.

## 3. Compose a distinctive, calm surface

Use the current Paprika identity for adaptation. In literal reproduction, first match the supplied identity, composition, and state. Make investigation improvements when the scope warrants them; do not insert a redesign into a screenshot-reproduction task.

- Maximize useful plot area; put configuration in the editor and provenance in inspection. Keep ordinary widget chrome focused on title, telemetry, and relevant actions.
- Align related plot edges, units, time domains, baselines, and legends. Use small multiples when overlays prevent comparison. Let density follow the task and viewport.
- Use the product sans face, tabular numerals for live or aligned values, and monospace for identifiers/query syntax. Distinguish title, value, unit, axis, and detail without marketing-sized headings.
- Separate structural lines, reference grid, data marks, thresholds, focus, and selection. Quiet grids are acceptable; unreadable axes and essential marks are not.
- Use categorical colors for identity, sequential scales for ordered magnitude, and diverging scales around a meaningful midpoint. Retain explicit authored colors and explain conflicts. Do not use severity colors as arbitrary decoration.
- Preserve full labels and exact values through accessible inspection. Reduce ticks, relocate legends, reflow panels, or add an intentional detail view before shrinking type.
- Reserve geometry for loading, failure, and menus. Use functional motion only; no routine entrance choreography or counting values up from zero. Respect reduced motion.

Do not transplant isometric perspective, ambient animation, or illustrative chart shapes from Anatomy/Hairline into quantitative plots. Borrow their model discipline, restrained stroke system, reusable geometry, and concrete audits.

Translate Mebius's comparison cards, selected intervals, controlled gradients, range marks, and interaction detail into Paprika's existing tokens and semantics. Use its actual code/design references as evidence for particular techniques; do not assume that every decorative demo treatment suits continuous telemetry. Choose and document one owner for each animated property. Keep direct pointer feedback immediate, preserve identity through updates, and validate interruption, reduced motion, and multiple widgets with unique SVG resource IDs.

## 4. Make investigation coherent

Read [interaction, access, and performance](references/interaction-and-performance.md) for interactive or streaming work.

- Share time, filters, and timezone through the existing dashboard state. Synchronize by timestamp, never series-array index. Verify the actual plot domains as well as request bounds; sparse series must not shift the meaning of a shared cursor.
- Preserve Paprika's transient hover/focus, click/tap or Enter pinning, Escape dismissal, and current refresh invalidation. Clear transient focus on blur without discarding a pin; provide a reachable pin-clear action and preserve keyboard focus on dismissal. Do not retain an observation after its result is replaced unless an explicitly designed snapshot feature owns that behavior.
- Supply keyboard and touch access to exact values, legends, selection, inspection, and navigation. Provide non-drag pointer controls for brush/resize/reorder features as well as keyboard support.
- Preserve applicable scope when drilling into a destination; distinguish view parameters from saved document defaults. Give a predictable return/reset path.
- Keep presentation edits query-free. Use host-owned, bounded, cancellable queries; only explicit query-backed tooltip configurations may fetch. A renderer consumes normalized results and must not invent a private network path.
- Keep guided editor, JSON/YAML/OpenUI authoring, schema validation, preview, explicit Apply/Save, and undo/redo consistent. A configuration control must change an implemented renderer behavior. Preserve drafts on errors and conflicts. For editor work, follow [dashboard authoring](references/dashboard-authoring.md): retain the last valid preview, check actual field compatibility, and distinguish session Apply from durable Save.

For time-window zoom, use the brushing contract in [interaction and performance](references/interaction-and-performance.md#time-window-brushing): distinguish chart-local and shared query scope, map pointers through actual time scales, arbitrate click/drag/inspection, and supply cancel, exact non-drag input, undo and reset. For responsive dashboards, reflow layouts and recompute chart geometry instead of shrinking an entire desktop artboard.

For maps, read [geographic charts](references/geographic-charts.md). Keep source coordinates/values separate from the camera; use one projection for all layers and actual screen-coordinate conversion. When navigation is requested, implement bounded zoom, pan, reset, keyboard and non-drag pointer controls together. Declare wheel ownership, honor the user's requested gesture, retain browser zoom and page-scroll escape. Keep selected entity and marker/hit-target semantics stable through camera transforms; reconcile selection when filtering or replacing its source.

Do not promise logs, alerting, arbitrary remote plugins, or Grafana import parity from a chart design task. Verify each current capability or name it as future work.

## 5. Verify in independent layers

Validate configuration and input compatibility before promoting a last-valid preview. A field-name string passing a configuration parser does not prove that the field exists, has the right unit/grain, or satisfies the family invariant. Reuse the trusted adapter or owner-level compatibility hook; preserve an invalid mapping as recoverable work and block Apply. Show unresolved roles and valid repair candidates instead of relying on a generic renderer exception.

Use [validation and acceptance](references/validation.md). For substantial new panels or chart families, adapt [the review-side contract example](assets/chart-contract.example.json) and run:

```sh
python3 <skill-dir>/scripts/check_chart_contract.py <chart-contract.json>
```

Read [the contract format](references/contract-format.md) first. This checks author-declared contradictions and explicit color pairs. It is **not** Paprika's document validator, a query evaluator, a browser audit, or proof of accessibility. Do not copy its schema into the product. Use it only where a written review contract adds value.

Run the repository's relevant transformation, schema, component, and browser tests. Honor its maintained required validation commands. Add tests for new numerical/interaction behavior, not tests that merely restate CSS or mirror an implementation.

Use the bundled [adversarial fixtures](assets/adversarial-fixtures.json) and relevant repository fixtures to exercise risks. These are deterministic synthetic observations, never live product claims. Include narrow spikes, missing tails, resets, unequal denominators, cumulative buckets, reordered entities, and mismatched sample times when applicable.

Inspect a batch of actual renders: supported themes, meaningful desktop and narrow panel sizes, dense/long content, a selected observation, and relevant failure states. Check text zoom, keyboard, pointer, and touch behavior. Fix material findings together, then confirm once. Continue only for a concrete correctness defect or required gate; avoid open-ended cosmetic loops.

For promoted/reusable families, exercise a clean route and an independent dataset with different entity names/order, values, cadence or geography. Verify registration, strict configuration, empty/missing states and actual interaction, not only the reference screenshot. Keep a family/state evidence matrix; a polished primary chart cannot stand in for unverified maps or tables. Follow the map-specific acceptance cases when camera or geographic behavior changes.

Record each gate as **pass**, **fail**, **unverified**, or **not applicable with reason**:

1. Analytical truth and numerical consistency.
2. Task hierarchy and visual readability.
3. Context and interaction fidelity.
4. Accessibility and non-drag operation.
5. Resilience, authoring, and persistence.
6. Measured performance and bounded resource use.

Never average a failed gate into a high beauty score. Never claim runtime verification from a manifest, source scan, screenshot alone, or an unexecuted test command.

## Repair a live dashboard

Before writing new queries for a dashboard whose data has drifted, use the tested repair
toolkit. These are local repository tools for the named deployments, not MCP tools; run
them from a checkout with access to the target.

- `hack/dashboard-presentation/patches.json`: reviewed widget edits for three operational
  dashboards, applied with `patch_dashboard` after the matching UI release is deployed.
  Use each document's exact ETag and read its README first.
- `hack/service-overview/`: exact-ETag patches for the six HTTP saved queries of
  `service-overview`. `queries.json` holds the patches; `migrate.mjs` exports
  `migrate(call, {expectedProviderId})`, which previews first and writes only with
  `{apply: true}`, through an authenticated Observe MCP client.
- `hack/shorted-queries/`: the Shorted query fixtures and their promtool tests, run by the
  same CI step.
- `ui/e2e/service-overview-coverage.mjs`: the coverage gate CI runs with the hack tests.
  Missing telemetry stays empty. An absent error-class series may become zero only against
  observed request traffic, and zero-traffic ratios and quantiles stay undefined.
- Promtool: the PromQL fixtures run `promtool test rules` in a pinned Prometheus image with
  networking disabled, or in a local binary named by `PROMTOOL`. Follow
  `hack/service-overview/promql.test.mjs` for the pattern.

After a change, run `node --test hack/service-overview/*.test.mjs hack/shorted-queries/*.test.mjs ui/e2e/service-overview-coverage.test.mjs`,
which is the command CI runs.
Source requirements and the reasoning behind them are in
[dashboard data coverage](../../../docs/guides/dashboard-data-coverage.md).

## Finish with evidence

Use [the review report template](assets/review-report.template.md) for substantial work. Report the concrete outcome, the analytical/design decisions that matter, checks actually run, and any remaining limitation. Identify whether evidence came from static source, fixtures, measured browser behavior, or live data. Keep the final answer proportional to the request.

For an audit, lead with material findings, exact affected owner, user consequence, and remedy. For implementation, include a rendered result when available and the commands/results needed to assess it. Describe unimplemented capabilities as proposals.

## Reference routing

| Resource | Read when |
| --- | --- |
| [Paprika integration](references/paprika-integration.md) | Starting work in the repository; locating current owners or extension paths. |
| [Chart grammar](references/chart-grammar.md) | Choosing charts; changing queries, units, scales, summaries, or data transforms. |
| [Visual craft](references/visual-craft.md) | Planning or refining a chart or dashboard's appearance. |
| [Transferable visual system](references/visual-system.md) | Building a new dashboard, adapting references, generalizing a replica, or encoding lessons from visual review. |
| [Chart families and coverage](references/chart-families.md) | Selecting the visual anatomy, auditing renderer support, building a coverage suite, or promoting a fixture into a reusable capability. |
| [Financial charts](references/financial-charts.md) | Building financial/portfolio lenses, allocation treemaps, pooled returns, contribution views or reconciled holdings evidence. |
| [Dashboard authoring](references/dashboard-authoring.md) | Building chart editors, live previews, compatible visualization choices, guided/structured drafts, Apply/Discard or persistence. |
| [Schema discovery and generation](references/schema-discovery-and-generation.md) | Discovering source/chart capabilities, mapping fields, recommending compatible visuals, generating canonical dashboards or scoped regeneration patches. |
| [Chart system evolution](references/chart-system-evolution.md) | Reflecting on iterations, expanding families, consolidating shared anatomy/inspection, planning vertical slices and reproducible evaluation. |
| [Geographic charts](references/geographic-charts.md) | Building or reviewing maps, location data, marker semantics, camera navigation, zoom/pan/reset or geographic selection. |
| [Reference fidelity](references/reference-fidelity.md) | Matching the supplied dashboard images; iterating density, telemetry texture, inspector composition, or a pinned-owner widget lab. |
| [Pixel reproduction](references/pixel-reproduction.md) | The user asks for a replica, exact matching, or closer pixel reproduction; includes measured geometry for both primary screenshots. |
| [Frameworks and rendering](references/frameworks-and-rendering.md) | Choosing D3/visx/TanStack capabilities, extending a renderer, or considering a dependency change. |
| [Motion and effects](references/motion-and-effects.md) | Adding transitions, gradients, focus effects, SVG resources, or Canvas rendering. |
| [Mebius patterns](references/mebius-patterns.md) | Adapting Mebius chart composition, styling, and documented animation techniques. |
| [Interaction and performance](references/interaction-and-performance.md) | Building interactive, responsive, accessible, streaming, or dense views. |
| [Validation](references/validation.md) | Planning acceptance checks and reporting evidence. |
| [Contract format](references/contract-format.md) | Using the optional declared-contract checker. |
| [Research sources](references/research-sources.md) | Checking rationale, external standards, provenance, or new architecture decisions. |
| [Paprika platform signals](references/paprika-signals.md) | Dashboards about Paprika's own health: `paprika_*` metric names, labels, documented healthy ranges and PromQL. |
