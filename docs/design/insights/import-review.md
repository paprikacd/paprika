# Reviewed import decisions — 24 October 2026

Scope: explicit per-dashboard and per-saved-query Keep / Replace / Create a copy, authoritative saved comparisons, typed field differences, dependency-aware provider mapping, replacement impact and partial-retry recovery. This extends the [portable bundle contract](portable-bundles.md); the original portability evidence remains intact.

## Decisions and critique

The shared Code/Manage panel keeps the established Gamma feature styling. Actions and comparisons are grouped by resource, with full-width selectors in the inspector. Dashboard copies remain the default. Identical queries default to Keep and differing queries to Copy; new query IDs are preserved unless Copy is selected. Replace always requires a deliberate choice and a saved revision.

Current/Incoming values stack vertically so long queries and configuration paths remain readable in narrow panels. The maintained Gamma DisclosureStack provides keyboard-operable comparison disclosure; expensive comparison bodies mount only when expanded. Typed values distinguish zero, false, null, empty strings and absent properties. A bounded field list reports truncation explicitly; individual values are not silently truncated.

Keeping a dashboard excludes all of its incoming dependencies. Keeping a compatible query is available before mapping an unavailable incoming source, and the comparison still shows the original incoming definition. Query replacement explains that all saved consumers are affected, including dashboards outside the import. Refresh resets explicit Replace choices for reselection; provider edits preserve the action and expose compatibility errors rather than silently converting Replace into Keep.

Partial imports preserve completed decisions and copy identities. Copy/existing-ID transitions lock only after a reported write attempt; Keep/Replace can still switch within an existing ID. Failed preflights leave actions repairable. Pending writes retain the source/review and disable navigation until receipts settle.

## Validation

- 29 focused tests pass across the panel, document editor, library manager and Gamma disclosure. Coverage includes authoritative ETag baselines, explicit replacement consent and affected-dashboard lists, kept dependency exclusion, unavailable incoming sources, typed comparison values, same-session refresh, locked copy destinations, late snapshot handling and safe valid IDs such as `constructor`.
- TypeScript and scoped ESLint pass.
- Gamma discovery used the maintained `disclosure-stack` brief and source; hashes and adaptation details are in `artifacts/insights/import-review/gamma-discovery.json`. Existing button/input/select owners remain unchanged.
- The initial Impeccable scan found an unnecessary decorative left border in the replacement notice. It was replaced with the ordinary full Gamma border. The final detector reports zero findings; output is recorded in `artifacts/insights/import-review/impeccable.json`; no suppression was added.
- Premium strict reports the same seven known false positives: four intentionally actionless focus/selection fixture buttons, two native form test fixtures, and the shared textarea whose `resize: none` rule lives in its CSS module. None originates in the new import UI. No suppression was added.
- The installed `paprika-widgets` skill and checklist now describe explicit reviewed replacement, ETag/compatibility requirements and the desktop/mobile visual gates. Skill validation passes.

## Native and service review

Independent native review passes on production build `0H7oxq6zswJSt47V6bxuz` at desktop 1512px, phone 390px and narrow 320px. The inspected captures include dashboard and query field diffs, replacement impact, Keep/Copy states, stale-query errors, compatibility blockers, both action menus and the typed null/false/zero/string fixtures. No additional product visual findings remain.

The initial query-diff capture stopped at its disclosure heading; the final capture was corrected to show the actual Current/Incoming query and parameter values. The final desktop comparison shows the complete query templates and parameter default 5→0. The replacement warning visibly lists saved consumers, including an external dashboard, before the query comparison. Phone errors remain readable alongside recovery controls. At 320px, long field paths wrap, typed values remain distinct, and both menus retain full option descriptions and visible selection/focus states. Measured selectors are 44px tall; the recorded menu is 244×185.89px and remains inside the viewport without position oscillation.

The new real-service suite passes **12/12 scenarios**, with **zero page errors** and **20 captures**. It exercises conditional dashboard/query replacement, live main and tooltip execution, zero-write Keep, compatible differing-query Keep, copies with rewritten references, stale-review refresh and explicit reselection, in-use parameter/identity blockers, lost acknowledgements, partial retries, and a concurrent edit between preflight and write. Existing destination documents are preserved when an action is Keep/Copy or a stale write is rejected.

Evidence is in `artifacts/insights/import-review/report.json` and `design-review.json`. Inspect `dashboard-diff-1512.png`, `query-diff-1512.png`, `replacement-impact-1512.png`, `keep-dashboard-390.png`, `copy-query-390.png`, `stale-query-390.png`, `in-use-replace-blocked-390.png`, `identity-conflict-320.png`, `dashboard-action-menu-320.png`, `query-action-menu-320.png` and `typed-*-320.png`. The broader regression results are tracked separately by the parent validation report. Coverage uses Chromium viewport/touch emulation and makes no physical-device or full accessibility certification claim.

## Final verification

The final build is `0H7oxq6zswJSt47V6bxuz`. All 622 UI tests across 66 files pass, along with TypeScript, scoped ESLint, the production export and Go race tests for Insights, the API and auth. The CLI package compiles and has no test files.

Six targeted browser suites passed independently against that frozen build: reviewed replacements 12, portable bundles 15, advanced 7, responsive 8, tooltip queries 24 and Explorer 12 — 78 scenarios with zero page errors. The eleven-suite runner includes the new replacement suite but was not invoked as a combined run. See `artifacts/insights/import-review/verification.json` for exact run boundaries and report links.

The rebuilt static example preview is served at `http://127.0.0.1:3015/dashboard/insights/?example=1`. A fresh in-app browser tab rendered all seven widgets after reload. The user's original tab had unsaved edits and was left untouched. Live mode requires an Insights API; the static preview alone does not provide `/api/insights`.
