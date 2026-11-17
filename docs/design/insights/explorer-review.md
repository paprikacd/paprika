# Explorer and saved-query review — 24 October 2026

Scope: per-data-source query discovery, a persistent saved-query library, dashboard and tooltip references, typed parameter bindings, full-parent-result tooltip reuse, and Gamma authoring on desktop and phones. This extends the [tooltip host review](tooltip-host-review.md), with the [explorer contract](explorer.md) defining the behavior.

## Acceptance matrix

| Area | Result and evidence |
| --- | --- |
| Query discovery and preview | Pass: actual Prometheus metadata discovery, guided/raw query input, explicit Run, typed preview values, fixed/relative ranges, loading, empty/error output and cancellation through the real Go adapters. Saving and typing do not run data queries. |
| Library lifecycle | Pass: per-provider filtering, text search, create/update/copy/delete, restart persistence, conditional ETags, stale conflict recovery, missing references and in-use guards. Local example storage has independent bounds and corruption checks. |
| Dashboard integration | Pass: Use in dashboard creates explicit variable mappings, retains existing defaults, supports remapping/constants, follows saved definition edits and preserves the custom draft. Unavailable or incompatible references never fall back to it. |
| Tooltip sources | Pass: full existing widget data includes all loaded series without another query. Saved queries bind exact hovered labels/value/timestamp/series and explicit dashboard variables. Fractional timestamps, special characters, missing context and switched-request cancellation reach the real provider correctly. |
| Documents and AI | Pass: JSON/YAML/OpenUI preserve references and bindings; the optional fourteenth OpenUI argument retains prior positional compatibility. AI prompts describe available definitions and review validates referenced provider capabilities and parameter mappings. |
| Draft lifecycle | Pass: closing/reopening Explore preserves its draft, sidebar return preserves unapplied widget edits, leaving Insights protects unsaved work, and older library snapshots cannot replace a newly saved revision. |
| Gamma and responsiveness | Pass: native 1512/390 screenshots and 320px workspace/menu/parameter checks. Inspector binding controls show complete source names. Inputs, switches, searchable menus and actions use existing scoped Gamma adapters. |
| Cross-workspace portability | Superseded by the [portable-bundle review](portable-bundles-review.md): JSON/YAML exports embed saved dependencies with provider mapping and conflict review. Legacy documents and OpenUI remain reference-based. Imported linked widgets do not require an unavailable dormant custom provider. |
| Performance | Functional limits verified: explicit execution, shared widget scheduler, caching/cancellation, bounded readonly tooltip data, no extra HTTP for full-result reuse. No production load benchmark was run. |

## Findings fixed

- Strict document validation rejected transport ETags from library reads; the shared resolver strips only that metadata.
- Numeric parameter conversion accepted null/boolean values as zero; conversion now requires a string or number and complete finite numeric syntax.
- Example-library reload did not validate template grammar, byte limits or nonempty revision tags; malformed storage now errors without overwriting it.
- Template validation artificially expanded a short token using a long dummy value; it now validates grammar without creating a synthetic length failure, while runtime expansion remains bounded.
- Refreshing the query library remounted Explore and lost drafts; its mounted workspace now survives refresh and navigation.
- Sidebar return closed the retained widget inspector; it now preserves unapplied editor work when returning from Explore.
- An earlier list response could overwrite a successful mutation; mutation generations now reject stale list data and errors.
- The browser/Back to Paprika exit guard ignored a dirty explorer; it now protects both workspaces.
- Import demanded the dormant provider on a linked widget; only active custom-query sources are remapped/validated.
- Canvas error priority claimed a configured provider was absent when the saved reference was missing; it now displays the actual reference/capability error without querying.
- Binding source text was clipped into identical prefixes in the desktop inspector; full-width controls now display complete labels. Optional parameter annotations stay inline to align fields.
- Save-conflict recovery actions appeared on unrelated delete/use failures; they are now scoped to save failures.

## Review process and evidence

The Paprika widget skill and checklist were extended with saved-query lifecycle, typed-reference, transport-metadata, draft-retention and portability checks. Gamma discovery used the installed explorer skill/MCP and the maintained search-field source; it reuses the already-adapted Gamma controls. The coordinated audit/critique, Impeccable, Premium and frontend review retains the established Insights design; design-taste’s dashboard exclusion remains respected.

Impeccable reports zero findings. Premium’s seven existing findings are six intentional test fixtures and a CSS-module inference limitation for the shared textarea. They are documented false positives, not product issues. No suppressions were added; no product design finding remains standing in this scope. The previous bounce-easing finding remains fixed with smooth easing.

Native evidence is under `artifacts/insights/explorer/`, including `parameters-1512.png`, `parameters-390.png`, `tooltip-bindings-1512.png`, `tooltip-binding-menu-390.png`, `existing-widget-results-1512.png`, `saved-tooltip-390.png` and the 320px captures. `design-review.json` records the visual review; `gamma-discovery.json` records source provenance. A transient blank tooltip capture was resolved by waiting for its required visible content and inspecting the final native image; no speculative product change was made.

Early harness failures are preserved: the Gamma switch includes its description in its accessible name; binding arrays may be stored in a different order with identical meaning; in-use deletion may be blocked by the current-dashboard guard before the server 409. Tests now assert those contracts explicitly. The missing-reference error failure was an actual product issue and received the canvas fix and regression tests above. Existing mock-backed browser suites gained the newly required empty saved-query-list response; live suites still use the service.

Final verification: **535 UI tests / 60 files**, production build and TypeScript, scoped lint, and Insights/API/auth Go race tests pass. All nine browser suites pass with **85 scenarios plus 206 widget checks**, four N/A cases; the final Explorer-only recovery change was rebuilt and its complete 12-scenario suite rerun. The preceding eight-suite runner passed on the otherwise identical implementation. See [validation.md](validation.md) for the precise build boundary. `artifacts/insights/explorer/final-report.json` records 12 passes, no page errors and 27 native screenshots. Tests use real Go storage and Prometheus/Tempo adapters against deterministic isolated endpoints. Browser mobile coverage is Chromium touch/viewport emulation, not physical-device testing or production-provider certification.
