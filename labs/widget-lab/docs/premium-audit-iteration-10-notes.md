# Iteration 10 — static audit triage

This note triages the captured `premium-audit-iteration-10.json` against the current implementation and baseline commit `70651a78e70972721a785158dc9c87cb55ac4919`. The original full-source manifest and 50-error report are preserved. Two supplemental directory-scoped strict runs evaluate the iteration-10 editor and domain chart controls against the explicit ownership decisions in `UX-CONTRACT.md`.

**The full-source strict audit is not a pass.** Its raw report contains **50 errors: 48 violations and 2 unresolved ownership findings**. The clean scoped results below do not replace that result. Numerical tests, browser interaction checks and build results remain separate evidence.

| Rule | Count | Attribution and interpretation |
| --- | ---: | --- |
| `ownership.native-select-conflict` | 39 | 35 files already contained native selectors at baseline. Four new widget files add native, labelled sample/contact selectors. The single global authored-only policy cannot express the existing mixed control usage. |
| `ownership.native-date-undecided` | 2 | Existing Production Planner and the shared time-window controls use native UTC date/time entry. No iteration-10 date input is introduced. Ownership remains undeclared in the audit configuration. |
| `form.novalidate-missing` | 6 | Existing forms, unchanged by this iteration. Their custom submit validation can coexist with browser constraint validation, but the recorded application-owned form policy is not explicit. These are existing consistency findings, not established scanner false positives. |
| `form.textarea-resize-missing` | 3 | The canonical GammaTextarea is a CSS Module resolution limitation; the Incident Room and Query Atlas findings reflect existing native textarea treatment and should not be dismissed with the same explanation. |

## Supplemental scoped results

The canonical UI map now assigns searchable field/visualization authoring to GammaSelect and labelled, bounded sample/interval/fixture inspection to native selects. The iteration-10 interaction contract records the same distinction. These are product control decisions, not rule suppressions. The auditor supports one ownership value per invocation and directory-valued `sourceRoots`; it does not support ownership overrides by file or capability variant.

| Supplemental manifest and report | Complete source directories scanned | Declared Select/Listbox owner | Actual strict result |
| --- | --- | --- | --- |
| `premium-audit-iteration-10-editor.config.json` → `premium-audit-iteration-10-editor.json` | `src/editor` | `authored` | Exit 0; 0 findings, errors, warnings, violations or unresolved items |
| `premium-audit-iteration-10-domain.config.json` → `premium-audit-iteration-10-domain.json` | `src/charts/clinical`, `src/charts/energy`, `src/charts/orbital`, `src/charts/wafer` | `native` | Exit 0; 0 findings, errors, warnings, violations or unresolved items |

Both manifests retain the original `product-admin` profile, `en` locale, `UX-CONTRACT.md` canonical map, required `Select/Listbox` and `Scrollbar` capabilities, and the `unit`, `typecheck` and `build` command declarations with their original package scripts. No file exclusions, rule ignores or auditor changes are used. All supported source files under each listed directory are inspected. The original `docs/premium-audit.config.json` still scans all of `src` with authored-only Select/Listbox ownership.

The supported static auditor was run in strict mode with each supplemental manifest and a separate output path. To reproduce from the project root:

```sh
AUDIT_TOOL=/root/.codex/plugins/cache/openai-curated-remote/frontend-design-premium/1.4.0/skills/frontend-design-premium/scripts/audit_project.py
python3 "$AUDIT_TOOL" . --mode strict --config docs/premium-audit-iteration-10-editor.config.json --output docs/premium-audit-iteration-10-editor.json
python3 "$AUDIT_TOOL" . --mode strict --config docs/premium-audit-iteration-10-domain.config.json --output docs/premium-audit-iteration-10-domain.json
```

These invocations are static checks. They verify the declared validation commands exist in the manifests; they do not execute unit tests, typecheck or build, and none of those commands was run for this supplemental audit task. The selected directories exclude lens headers, navigation, the shared Gamma implementation and global styles. The scoped results therefore provide no new certification of those areas, runtime accessibility or browser interaction. They establish only that the selected source directories have no findings under the documented ownership and the auditor's current static rules.

## Select ownership is broader than the existing product contract

`premium-audit.config.json` scans all of `src` and records `Select/Listbox: authored`. The auditor applies that single owner to every source file. It does not resolve capability variants from the UX contract: any literal native `select` is reported unless the manifest owner is exactly `native`.

The maintained UX contract itself contains both the GammaSelect ownership row and an explicit native lens-picker navigation contract. Older chart and lens controls also use native selectors for finite entity or sample choices. The 39 findings therefore expose a real mismatch between the global audit declaration and the established implementation. They do **not** establish 39 newly broken controls. They also cannot honestly all be called false positives: most literal native selects have been detected correctly.

The new shared authoring controls in `FieldMapping.tsx` use canonical GammaSelect, including search, disabled incompatible choices, source metadata, error associations and explicit field-binding validation. No native-select finding is reported against that new workbench.

### Four new widget findings

| File | Native control | Scope and source-level checks |
| --- | --- | --- |
| `src/charts/clinical/FollowupDistribution.tsx` | Follow-up interval inspection | Labelled bounded interval choice; selects existing bins and supports clearing inspection. It does not mutate participant data. |
| `src/charts/energy/ReserveEnvelope.tsx` | Exact observation-time inspection | Labelled choice among supplied timestamps; selects actual observations and exposes a clear action. It is not a date-entry or query-execution form. |
| `src/charts/orbital/OrbitalPassProfile.tsx` | Standalone contact picker | Labelled pass choice following the existing orbital picker pattern. The composed lens disables it because its header owns shared contact selection. |
| `src/charts/wafer/WaferTransect.tsx` | Exact die inspection | Labelled choice among section positions, within the exact-data disclosure; source IDs remain stable. |

These four controls are **new canonical-ownership inconsistencies under the preserved full-source audit declaration**. The supplemental domain manifest records their documented native ownership and reports no findings in the four domain chart directories. Source review found no inherently unsafe mutation, missing accessible name or fabricated observation caused by the native control choice. Their actual keyboard, narrow-layout and linked-selection behaviour still belongs to browser verification.

For this iteration, the maintained UX contract explicitly retains native finite-sample controls while GammaSelect owns searchable authoring. The supplemental directory manifests express that decision using the auditor's supported scope mechanism. They do not reconcile every existing lens or navigation control with the broad authored-only declaration. Changing the global owner to `native`, adding exclusions or suppressing findings solely to get a green result would not resolve that global inconsistency.

## Existing date and form findings

The shared time-window form reads native `FormData`, validates bounds and minimum span, and retains a visible error. Production Planner similarly reads submitted date input and validates a reversible proposal. These implementations provide evidence of real application validation, but their date ownership is not declared in the audit manifest and native constraint validation is still active.

The six form findings are existing debt in profiling, spectrum range entry, incident notes, materials constraints, production planning and the shared time-window owner. Some have `min`, `max`, `step` or `required` constraints, so browser validation may intercept submission before custom messages. This deserves a deliberate ownership decision and targeted verification when those forms are changed; it is not a new failure introduced by the four iteration-10 widgets. No new form or date input was added by these widget or editor changes.

## Textarea findings and stale historical notes

The GammaTextarea finding remains a supported scanner limitation. Its JSX applies `styles.input` and `styles.textarea`; `gamma/controls.module.css` defines `.input.textarea.textarea` with `resize: none`, content sizing, a maximum height and scrolling. A literal-tag scan does not resolve those CSS Module rules.

That explanation does not cover the other two textarea findings:

- Incident Room's note textarea has a minimum height but no local resize rule in its inspected CSS.
- Query Atlas explicitly uses `resize: vertical` for profile import text.

Both are pre-existing choices. The historical `premium-audit-notes.md` also says the lab does not render GammaTextarea and has no date/form workflow. Those statements describe an earlier lab and no longer describe the current shared editor and expanded lenses. They must not be used as current assurance evidence.

## Release interpretation

The preserved full-source audit establishes **unresolved global control-ownership and existing form/style findings**, including four new native-selector conflicts under its authored-only declaration. The two supplemental strict audits return zero findings for the editor and four domain chart directories under their documented ownership decisions. This is scoped evidence, not a global-clean claim or a waiver of the 50-error report. The static audit does not identify a new data-accounting, field-validation, source-identity or destructive-operation failure and does not certify those behaviours or accessibility. Preserve the raw failure and report browser and analytical verification independently.
