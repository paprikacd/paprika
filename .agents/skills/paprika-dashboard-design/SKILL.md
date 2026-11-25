---
name: paprika-dashboard-design
description: Design, build and review Paprika Insights dashboards, charts, maps, tooltips and widget editors so that they read truthfully and work at every size. Not for Helm charts, deployment-only work or marketing pages.
---

# Paprika Dashboard Design

Build an operational instrument: the data carries the visual weight, and scope, comparison, missingness and
the next step stay legible. This file holds only Paprika's rules. The contracts live in the repository docs
linked below; the references load on demand.

## Minimal path

| Task | Read first |
| --- | --- |
| New dashboard | [visual system](references/visual-system.md), [chart families](references/chart-families.md), then the Observe skill procedure |
| Chart editor or authoring UI | [dashboard authoring](references/dashboard-authoring.md) |
| One chart or renderer | [chart families](references/chart-families.md), [Paprika integration](references/paprika-integration.md) |
| Map, or financial and allocation view | [geographic charts](references/geographic-charts.md), [financial charts](references/financial-charts.md) |
| Review or audit | [validation](references/validation.md) (the review protocol), [widget checklist](references/widget-checklist.md) |
| Dashboard about Paprika itself | [Paprika signals](references/paprika-signals.md) |

## Contracts: read them, do not restate them

- Design context: [DESIGN.md](../../../DESIGN.md) for Insights; [.impeccable.md](../../../.impeccable.md) for the console audience and shell.
- Behaviour owners, status, breach and attention rules, number display: [UX-CONTRACT.md](../../../docs/design/insights/UX-CONTRACT.md).
- Everything else (schema, variables and drilldowns, `query_dashboard`, patching and revisions, coverage and embed mode,
  Kubernetes widgets): the index in [docs/design/insights/README.md](../../../docs/design/insights/README.md).
- Composition rules: served by `get_insights_schema` and the Observe server instructions, generated from
  `internal/insights/guidance`. The authoring procedure is the
  [Observe skill](../../../plugins/paprika-observe/skills/paprika-observe/SKILL.md).
- Local loop, browser suites and lint: [the Insights dev loop](../../../docs/guides/insights-dev-loop.md).

## Start with the existing product

1. Target `/dashboard/insights`. Its Light, Dark and System themes never redefine the console.
2. Inspect one related renderer, its pure transform, its tests, the normalized result and a current render.
3. Extend the existing owners: Gamma controls, the theme adapter, the registry, the scheduler and the document
   model. Do not add a chart library or a second dashboard schema to get a look. Documents never load code.
4. Discover live metrics, labels and provider capabilities through the Observe skill. Never invent them, or
   alert policies.
5. Other design skills (frontend-design, Impeccable in Operate mode) are optional lenses, never blockers.

| Request | Do this |
| --- | --- |
| One chart | Keep the surface; state the panel's question and semantics; change the canonical owner; verify affected states. |
| A dashboard | Name the audience, decision and shared scope; map each evidence role to an implemented family before layout. |
| A chart family | Data adapter, renderer, config validation, exact inspection, context emission and tests as one capability, shown on independent data. |
| An audit | Inspect the real target; report reproducible findings with severity, impact, evidence and remedy. |
| Reproduce a supplied screenshot | Literal reproduction mode in the widget lab: [reference fidelity](../../../labs/widget-lab/docs/references/reference-fidelity.md) and [pixel reproduction](../../../labs/widget-lab/docs/references/pixel-reproduction.md). |

Ask only when an unknown fact changes the outcome and the repository or data cannot answer it.

## Paprika rules

- **Decide the representation before marks:** metric kind, base and display unit, time (Unix seconds on
  requests, milliseconds in results), encoding and baseline, what a summary means, and stable identity.
  `unit` is a display suffix; it never converts.
- **Keep states apart:** zero, null, absent series, stale, partial and failed are different. Rate counters
  before aggregating; never average percentiles; weight ratios by population. Resizing never changes a KPI,
  threshold outcome or summary.
- **Numbers:** every displayed number honours the widget's `decimals`; Auto never prints float noise.
  [Number display](../../../docs/design/insights/UX-CONTRACT.md#number-display) has the full rules.
- **Status and colour:** use the vocabulary in DESIGN.md (Status and series vocabulary). Status words never
  decorate; status colours come from the status tokens and series colours from the palette and roles.
- **Phone:** at 600 px and below each full-width stat costs about 110 px. Keep leading KPIs to what an
  on-call reader needs and put the first chart early when the chart is the reading.
- **Investigation:** share time by timestamp, never array index. Build hover and pin previews on
  `useObservationOwner`, not a local timer. View controls (range, refresh, variables, selections, brushes)
  never edit the document. Presentation edits are query-free.
- **Ranked tables:** for "which entity is worst", declare the record table's `rank` with a status source
  instead of relying on the query's ORDER BY; the rank orders loaded rows only.
- **Distribution heatmaps** with a per-second density unit need an input that is already a rate.

## Variables and filters

Declare a shared filter as a dashboard variable with a `defaultValue` and `options` (or a `source`).
Ship a default. An unset variable is an error for any query that uses it, not an empty filter.
Several values, All, sources, SQL list binding and click-to-filter (`selectionBindings`) are specified in
[drilldowns.md](../../../docs/design/insights/drilldowns.md). `query_dashboard` reports each variable under
`variableDefinitions` and names an override outside the declared options in `warnings`.

## Repair a live dashboard

Use the tested toolkit before writing new queries: the patch applier and its usage are in
[hack/insights-patch/README.md](../../../hack/insights-patch/README.md), and the rest of the toolkit and its
CI command are in AGENTS.md under "Repairing a live dashboard". MCP clients use `patch_dashboard` with
`widget_edits` instead of the CLI.

## Verify: six gates

Follow the [review protocol](references/validation.md). Record each gate as **pass**, **fail**,
**unverified** or **not applicable with reason**:

1. Analytical truth and numerical consistency.
2. Task hierarchy and visual readability.
3. Context and interaction fidelity.
4. Accessibility and non-drag operation.
5. Resilience, authoring and persistence.
6. Measured performance and bounded resource use.

Check every changed surface at 1512, 1024, 768 and 390 px, light and dark, and in narrow tiles, with
screenshots you have opened. Never average a failed gate into a good score. Never claim runtime verification
from a manifest, a source scan, a screenshot alone or an unexecuted command.

## Finish with evidence

Report the outcome, the checks run and what remains unverified, and say whether evidence came from source,
fixtures, a browser or live data. For tool throttling and capacity errors, follow the Observe skill's
"Rate limits and capacity" section.

## References, loaded on demand

| Reference | Read when |
| --- | --- |
| [Paprika integration](references/paprika-integration.md) | Locating code owners, plugin extension steps, hazards and validation commands. |
| [Chart families](references/chart-families.md) | Choosing anatomy, auditing renderer support, promoting a fixture into a capability. |
| [Visual system](references/visual-system.md) | Building a new dashboard or generalizing a reference. |
| [Dashboard authoring](references/dashboard-authoring.md) | Editors, live previews, Apply/Discard, persistence. |
| [Geographic charts](references/geographic-charts.md), [financial charts](references/financial-charts.md) | Maps; portfolio and allocation views. |
| [Schema discovery and generation](references/schema-discovery-and-generation.md) | Mapping fields and generating dashboard documents. |
| [Validation](references/validation.md), [widget checklist](references/widget-checklist.md) | Planning checks, running a review, reporting evidence. |
| [Paprika signals](references/paprika-signals.md) | `paprika_*` metric names, labels and healthy ranges. |
| [Contract format](references/contract-format.md) | The optional review-side checker, `python3 scripts/check_chart_contract.py <contract.json>`; it is not Paprika's validator. |

Background, read only when the task needs it: [chart grammar](references/chart-grammar.md), [visual craft](references/visual-craft.md),
[interaction and performance](references/interaction-and-performance.md), [frameworks and rendering](references/frameworks-and-rendering.md),
[motion and effects](references/motion-and-effects.md), [chart system evolution](references/chart-system-evolution.md) and
[research sources](references/research-sources.md).
