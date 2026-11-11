# Paprika Working System v1

## Status and reference

This is the proposed shared interface standard for Paprika's 29 canonical feature studies. It uses the existing main-console palette and typography, with the selected F23U artifact-composer artboard as the visual reference. The intended shell is a shallow navy global navigation bar, a compact white section rail, a light workspace, and a stable selected-detail inspector.

This document specifies intended behavior and implementation conventions. It does not establish that the proposed features, shared shell, responsive behavior, keyboard interactions or theme mappings are already implemented or tested. The native feature specifications remain the authority for values, eligibility, permissions and action effects.

The earlier creative studies remain exploration history. The canonical set uses this one system; creative-direction names do not become product navigation labels.

## 1. Visual foundation

| Role | Canonical treatment |
| --- | --- |
| Application ground | `#f2f2f3` |
| Working surfaces | White |
| Primary ink | `#1d1f20` |
| Global navigation | Navy `#1d2d3d` |
| Product accent and selection | Steel-blue `#5980a6` |
| Filled actions with small white labels | Steel-dark `#416180` with white text |
| Body and controls | Barlow |
| Page and section headings | Barlow Condensed |
| Identifiers, queries and code | System monospace |
| Geometry | Square working planes, thin rules and restrained borders |
| Emphasis | Alignment, hierarchy, selected-field rules and explicit status labels |

The drafting influence comes from exact alignment and inspection surfaces. Use flat surfaces and open rows. Keep registration marks rare and subordinate. Avoid decorative textures, heavy shadows, clipped machinery shapes, pervasive crosshairs and warning stripes around routine approval states. Panel geometry follows the maintained console token rather than incidental raster rounding.

Steel-dark is the proposed action variant for small white labels on filled controls. Use `#416180` for these button backgrounds; retain `#5980a6` for selection rules, focus and other product accents. Selected navigation items with small white labels should use the same darker variant. This is a token-level color correction, not a claim that complete component states have passed accessibility testing.

Use the maintained semantic status colors for outcomes. Selection and focus use the product accent and remain distinguishable from success, warning and failure. Color never carries a state by itself.

## 2. Canonical shell

The reference artboard establishes two levels of navigation.

- A shallow navy top bar carries Paprika and the global sections: Overview, Releases, Pipelines, Fleet and Insights. One section is active.
- A compact white or light section rail carries the selected area's local destinations. The release-composer reference uses Releases, Artifacts, Manifests, Targets and History. Other areas use their own maintained destinations with the same treatment.
- A light breadcrumb strip sits beneath the top bar and above the content. It preserves the current route without replacing the page heading.
- The page header contains the feature title, current state and the primary and secondary actions. Keep important source, environment, target, time and revision context near this header or in a compact context band.
- The body has one dominant feature-specific working surface and one stable selected-detail inspector. The artifact composer uses a broad identity/component/manifest ledger and a right-hand production-manifest inspector.

Proposed implementation starting points are a 56 px global bar, a 44 px breadcrumb strip, a 160 px section rail and a 24 px content gutter. Use a two-column working area where space permits. The inspector normally takes about one third of the available width, with a practical range of 320–480 px; wide data surfaces may instead use a lower inspection drawer. Keep the same structural rhythm across features without forcing every workflow into a table.

The canonical artboard composition target is 1600 × 1000. The generated image is a visual reference, not a pixel-exact measurement source. Study codes, the Working System label and Concept · synthetic data are prototype annotations for the study set; they do not establish production routes or controls.

## 3. Spacing, type and density

These are proposed sizing conventions for implementation, subject to verification in the actual component owners.

| Element | Starting convention |
| --- | --- |
| Spacing scale | 4, 8, 12, 16, 24 and 32 px |
| Closely related controls | 8 px gap |
| Surface padding | 16 px |
| Working-region separation | 16–24 px |
| Page title | Barlow Condensed, 32/40 px, semibold |
| Section heading | Barlow Condensed, 20/24 px, semibold |
| Body, tables and controls | Barlow, 14/20 px |
| Longer explanatory prose | Barlow, 16/24 px where the composition benefits |
| Supporting label | Barlow, 12/16 px |
| Identifier and code | Monospace, 13/18 px |
| Standard control | 36–40 px high |
| Standard table row | 40–48 px high |
| Optional compact row | 32 px, retaining labels and interaction affordances |

Use tabular numerals in quantitative ledgers. Emphasize a few decision-critical values rather than turning each measure into a separate KPI card. Titles must leave room for evidence. Compact density changes spacing, not the presence of units, provenance, missingness, action reasons or selected context.

## 4. Working surfaces and inspection

| Workflow | Dominant anatomy |
| --- | --- |
| Release, revision or cohort comparison | Aligned before/after or control/canary ledger |
| Query, trace or journey execution | Shared time reference and ordered evidence lanes |
| Coverage and fleet review | Matrix with an exact selected-source inspector |
| Runbook and casebook | Ordered procedure or readable narrative with an evidence margin |
| Artifact publishing and preflight | Identity, resource or binding ledger with unresolved-check details |
| Capacity and SLO analysis | One primary plot or allowance ledger backed by exact values |

Tables are exact ledgers. Left-align names and right-align quantities. Keep units in each value or in an unambiguous column heading. Match decimal precision within a comparison without inventing precision. Use rules and weight to separate totals from component rows.

Selection uses a steel-blue leading rule and a restrained row tint. A selected failed check still displays Failed. The inspector begins with the selected object, source, scope and revision, followed by the relevant explanation or evidence. Preserve exact long identifiers through wrapping, expansion and copy controls. Short display aliases must not become request identities.

Keep the working surface stable as selection changes. A graph, plot or timeline has an equivalent exact ledger or detail path. Use a lower drawer when a right-hand inspector would make a waterfall, profile or semantic diff unreadable. Selection does not initiate an operational action.

## 5. State semantics

Outcome, freshness, eligibility and authorization are separate facts.

| State | Meaning |
| --- | --- |
| Passed or Complete | The named check or operation succeeded |
| Pending or In progress | Work or evidence remains incomplete |
| Blocked | An explicit prerequisite prevents the next operation |
| Failed | A named check or operation failed |
| Unknown or Unavailable | The result cannot currently be established |
| Not run | Execution did not occur; this is not a zero-duration success |
| Stale | Recorded evidence exists but is no longer current |
| Approval required | Human authorization is outstanding; verification may already have passed |

An overall status must belong to the correct object. One ready application does not make a release train ready. Two admission passes do not override an unsupported required hook. Apply completed does not establish workload health. Window eligibility does not reserve or promise deployment.

Keep a blocked action visibly unavailable and place its reason beside it. Essential explanations must not require hover. Use ordinary workflow emphasis for Approval required; reserve failure treatment for actual failures.

## 6. Action hierarchy and identity

Use one primary next action for the selected task and restrained secondary actions. The reference uses Review publication as the primary action and Export manifest as the secondary action while the artifact remains Not published.

- Inspect, Open and Compare read or navigate.
- Run bounded preflight and Run historical evaluation explicitly perform their declared read or simulation.
- Preview and Review prepare a decision.
- Apply changes the session or operational state defined by that feature.
- Save, Publish and Execute perform their own distinct persisted or operational action.

Action wording must preserve these effects. Reviewing a rollback does not execute it. Publishing an artifact does not request deployment. Applying an editor change does not durably save the document. Historical evidence does not authorize a new action.

Requests bind the full identity and current version required by the maintained owner. Revalidate where the feature contract requires it. Keep future identifiers unassigned until their owning operation accepts or creates them; use Assigned after acceptance rather than an invented execution UID.

## 7. Quantitative and evidence contracts

Every quantitative surface retains its population, unit, interval and eligibility.

- A change from 0.4% to 6.2% is +5.8 percentage points, not +5.8%.
- A$1.407 per 1,000 completions must retain the per-1,000 denominator.
- A configured 10% trace sampling policy is not a measured 10% collection-coverage claim.
- Missing logs, absent metrics, unavailable providers and uninstrumented sources remain distinct from zero observations or success.
- A saved window `[09:41, 09:53)` may contain a 09:52 observation. A 09:53 capture timestamp is a separate fact.
- Occurrence time, collector observation, Paprika receipt and execution-relative elapsed time retain their labels and clock ownership.
- Exclusive timing phases, allocation rows, outcome counts and preserved/affected totals reconcile. Nested spans are not added as exclusive phases.
- Human approval, automated checks, historical receipts and simulated results retain distinct authority.

Native fixtures and exact ledgers govern concept-image meaning. Do not add plausible metrics, histories, causal links or identifiers to fill unused space. Mark chart history as schematic when it is not backed by an exact retained series.

## 8. Insights translation

The canonical 29-feature presentation uses this same light shell and drafting treatment for both the main console and Insights. Insights keeps feature-specific plots, legends and categorical or cohort colors inside the shared structure.

Where an Insights dark or compact theme is supported, map semantic tokens while preserving navigation, type hierarchy, selection behavior, state labels and inspector anatomy. Keep source/time context, series identity, missingness and exact values intact across themes. This alignment is an intended contract, not a claim that a new shared theme adapter is already implemented.

Use the canonical host query owner. Hover, theme changes, density changes and other presentation edits do not initiate queries. Explicit data reads remain bounded, cancellable and authorized.

## 9. Intended narrow-screen and keyboard behavior

These behaviors are proposed and must be verified in implementation.

On narrow screens, collapse the global destinations and section rail into labeled navigation controls that preserve the current location. Move the inspector below the selected item or into a full-width detail view. Retain the selected identity, exact scope, status and next action. Keep essential columns and values available; use an exact row-detail representation or horizontal scrolling where a numeric comparison would otherwise become ambiguous.

Use native button, link, form and disclosure semantics. Maintain a visible focus indicator distinct from selection. Keyboard selection in a ledger must not execute an action or silently move focus into an inspector. An explicit Open details action may focus the detail heading; closing the detail returns focus to its originating item. Preserve focus and selected identity when data refreshes or a view is virtualized.

Provide keyboard-accessible exact detail for chart marks and a corresponding ledger. Touch and keyboard users must be able to pin information otherwise shown on hover. State and outcome labels remain available without relying on color. Query cancellation and error recovery remain reachable in the same workflow.

No accessibility or responsive test result is claimed by the raster reference. Contrast, focus behavior, readable density and assistive-technology semantics require checks against the implemented components.

## 10. Canonical study review

Before an illustration is treated as the canonical feature study, verify:

1. The shallow navy top bar, light section rail, shared typography and white working planes match the reference.
2. The feature has one appropriate dominant working surface and a clear selected-detail path.
3. Source, target, time bounds and relevant revision are explicit.
4. Every displayed count, unit, interval and state agrees with the native fixture.
5. The next action is truthful and appropriately enabled.
6. Missing, stale, partial, sampled, unavailable and uninstrumented states remain distinct.
7. The image introduces no unsupported deployment, approval, reconciliation, collection mutation or saving behavior.
8. Proposed narrow-screen and keyboard behavior preserves identity, evidence and action context.

The implementation goal is a consistent way to read evidence and act deliberately. Preserve each feature's data and action contract while standardizing its shell and visual grammar.

## References

- [Paprika shared art-direction system](https://chatgpt.com/space/page_956c0483705c8191a694894abf25e041)
- [Frontend guidance at the reviewed source baseline](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/docs/frontend.md)
- [Deployment and release feature backlog](https://chatgpt.com/space/page_c1489ae2ec508191ab0dfa3188240ee0)
- [Reliability and operations feature backlog](https://chatgpt.com/space/page_7201ecf2dcc48191b56b5e90cae4b652)

## Runtime ownership

The documentation defines a proposed shared presentation. It does not install a theme adapter, replace the query scheduler or change a controller. Map each role into the maintained owners when implementing a feature.

| Owner | Responsibility |
| --- | --- |
| [ui/src/app/globals.css](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/ui/src/app/globals.css) | Main-console light palette, semantic roles, square panel geometry and density |
| [ui/src/app/layout.tsx](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/ui/src/app/layout.tsx) | Barlow and Barlow Condensed font ownership |
| [ui/src/features/insights/gamma/gamma-theme.module.css](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/ui/src/features/insights/gamma/gamma-theme.module.css) | Scoped Insights light, dark and compact theme adapter |
| [docs/design/insights/UX-CONTRACT.md](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/docs/design/insights/UX-CONTRACT.md) | Canonical controls, draft state, interaction, query and conditional-write contracts |
| [DESIGN.md](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/DESIGN.md) | Insights-specific design rules and contrast targets |
| [AGENTS.md](https://github.com/paprikacd/paprika/blob/17a651ab8edf20337ac5319af93ae7fb2c389b47/AGENTS.md) | Main-console and Insights boundaries and implementation verification requirements |

The main console remains light-only. Insights has its own scoped theme support. A common canonical artboard does not claim that a cross-surface adapter is implemented. The current console and Gamma geometry can be reconciled in the relevant implementation owner rather than copied from incidental raster rounding. Older dark-only Instrument Sans exploration notes are not the active font or color source for this catalogue.

### Calculated palette checks

These ratios use WCAG relative luminance for the exact solid colors; they are not a rendered-component accessibility audit.

| Foreground / background | Contrast ratio | Role |
| --- | --- | --- |
| White / selection steel `#5980a6` | 4.15:1 | Below 4.5:1 for ordinary small text; use this steel for selection, focus and accents |
| White / steel-dark `#416180` | 6.47:1 | Proposed small-label filled action and active navigation combination |
| Muted ink `#62686f` / white | 5.63:1 | Proposed supporting text on a white working surface |

[Catalogue](README.md) · [Reference token data](design-system.json) · [Generation prompts](generation-prompts.json) · [Working System in Space](https://chatgpt.com/space/page_83d1294312088191bf8b0b831d680eb2) · [Unified Space catalogue](https://chatgpt.com/space/page_33e4ede12ad88191af7ba4843bc74534)
