# Portable bundle review — 24 October 2026

Historical validation note: this report records the original reuse/copy portability increment. The later explicit Keep/Replace/Copy workflow and its independent evidence are documented in [import-review.md](import-review.md).

Scope: self-contained saved-query dependencies in Code/Manage exports, a shared Gamma import review, provider mapping, safe query conflicts and retryable partial outcomes. The [portable bundle contract](portable-bundles.md) defines the supported behavior and limits.

The new panel preserves the existing Insights design. Import actions use the maintained Gamma adapters; conflict controls remain full width in the narrow inspector and on phones. Independent native review of the final production export passes at desktop 1512px, phone 390px and narrow 320px. The review covers Code/Manage, query conflicts and choices, partial results, actionable errors, open menus and live imported output.

## Findings resolved during implementation

- Code imported file contents directly into the single-document editor, which would make bundled definitions unusable. Bundle upload/paste now opens the shared review and preserves the existing source draft.
- Code file reads could overwrite newer typing and did not handle read failures. Generation checks now reject stale results, errors preserve the draft, and file-size validation permits bounded library envelopes while retaining strict individual document limits.
- A default copy choice for a new query would contradict the displayed promise to preserve its ID. New queries now omit a conflict choice; only identical/conflicting IDs receive reuse/copy behavior.
- Query status could change after review while an old explicit reuse value remained in state. The submitted action now matches the current visible state; the coordinator still rechecks the destination before writing.
- Partial review initially retained irrelevant completed provider requirements. It now shows only pending dependency requirements while preserving the original full bundle/session for safe retries.
- Close/Back could otherwise discard a pending receipt view. Shared busy state disables those actions and the host guards panel navigation during writes.
- Native Code review showed only a 4px gap between Back to source and the Import dashboards heading. The shared panel now has a 22px top margin; Manage retains its existing 24px section spacing. Final browser measurements confirm exactly 22px at both 1512px and 390px. Singular query/widget summary wording is also corrected.
- Invalid pasted bundles reported the initial single-dashboard parse error. They now report the canonical missing-definition/binding error and retain the draft. Opening the review focuses its heading once; Back restores textarea focus without stealing focus during normal edits.

## Checks completed

- 19 focused UI tests pass across the source editor, library manager and shared import review. These include draft/file races, exact edited-document exports, provider-remapped conflicts, full-source session retention, visible-status consistency, actionable invalid-bundle errors, focus transitions and pending-write navigation.
- TypeScript and scoped ESLint pass.
- Impeccable reports zero deterministic findings.
- Premium strict reports seven existing false positives: four intentional actionless buttons in focus/selection test fixtures, two native form test fixtures and the shared textarea rule whose `resize: none` lives in its CSS module. None originates in the new import UI. No suppression was added.

## Native and service verification

The standalone portability suite passes **15/15 scenarios**, with **zero page errors** and **21 native captures** on the final production export. It downloads real Code JSON and Manage YAML files, imports them into independent fresh Go stores, and executes Prometheus/Tempo queries through the real adapters. Typed defaults, exact-once special-character interpolation, dashboard variables and tooltip observation bindings remain intact. Conflicts preserve the destination definition, identical queries can be reused or copied, and failed/lost acknowledgements recover without duplicate identities. Incomplete bundles and changed definitions fail before creating broken dashboards.

The final review inspected `code-review-top-{1512,390}.png`, `code-import-review-1512.png`, `manage-import-review-390.png`, `query-conflict-1512.png`, `query-copy-choice-390.png`, `partial-query-1512.png`, `partial-dashboard-1512.png`, `reuse-race-1512.png`, `incomplete-code-bundle-390.png`, `provider-menu-320.png`, `query-choice-menu-320.png`, `import-review-320.png` and `imported-traces-390.png`. Full query-choice text remains readable at 320px. Provider/query menus fit the viewport and preserve visible selected/focus states; their measured listbox bounds are 274×44px and 244×88px. The three measured narrow selectors and the phone Back action are 44px tall. The existing trace table scrolls internally rather than widening the page.

No unresolved functional or material visual finding remains in this review. The final full UI suite passes **577 tests in 63 files**; TypeScript, production build, scoped lint and the Insights/API/auth Go race checks pass. All ten browser suites now have passing results on the same frozen export: 100 scenarios plus 206 widget checks, with four explicit N/A cases. See [validation.md](validation.md) and the verification receipt for the split-run boundary and the corrected existing live-test restart harness; the original combined invocation did not exit successfully.

Artifacts are under `artifacts/insights/portable/`. `design-review.json` records the independent native inspection, and `final-standalone-report.json` contains the scenario results, exact provider requests, conditional persistence receipts and control measurements. Early selector-only harness stops are retained separately in `harness-notes.json`; they were corrected without relaxing product assertions. Browser device coverage uses Chromium viewport/touch emulation; it does not claim physical-device or production-provider certification.
