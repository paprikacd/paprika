# Builder, query editor and provider review — 24 October 2026

This follows the [widget review](widget-review.md) after the user supplied screenshots of cramped toolbar buttons and protruding switch thumbs. Those defects were present in the integrated production CSS. The previous review established many functional behaviors, but its visual conclusion was too broad: component imports, interaction tests and whole-page screenshots did not establish control-level quality.

## Audit and critique

The baseline fails the control-craft check. Its useful hierarchy, warm surfaces and restrained telemetry colors should remain. The problems are conflicting style ownership and insufficient rendered evidence, rather than a need for a new visual direction. No critical issue was found in this scoped review; six verified issue families are recorded below. Severity reflects this authoring workflow, not a full security or accessibility assessment.

| Priority | Location, relative to `ui/src/features/insights/` | Verified problem and impact | Resolution |
| --- | --- | --- | --- |
| High | `gamma/controls.module.css:105`, `:167`; editor/AI/source fields | The shared input rule won over textarea minimum heights, collapsing query, code and AI editors to one line. Authors could not comfortably inspect a definition before applying it. | The Gamma field owns a minimum-height variable; textarea and code variants set meaningful multiline sizes. |
| Medium | `gamma/controls.module.css:2`, `:88`; `gamma/button.tsx` | Base padding had insufficient specificity. More subtly, `svg:only-child` matches an SVG beside a raw text node, so the icon-only rule removed padding from text buttons. The user's toolbar measured zero horizontal padding. | Stable base geometry and an explicit `iconOnly` prop. Known icon-only actions are marked; SVG-plus-text actions retain normal padding. |
| Medium | `gamma/gamma.module.css:35` | Competing switch definitions produced a 36×18 border-box track with an 18px thumb, 3px inset and 18px travel. The thumb protruded 3px below and to the right, including the pressed state. | One 42×24 border-box track with contained resting and pressed geometry. The adapter retains focus and reduced-motion behavior. |
| Medium | `editor.module.css:64`, query filter layout | Broad descendant input rules styled the combobox's internal input again, creating double borders and crowded filter fields. | Scope standalone field rules to direct children; let Gamma own combobox internals and allocate appropriate filter columns. |
| Medium | `gamma/controls.module.css:365`, `gamma/gamma.module.css:408`, `editor.module.css:442` | Compact controls and 36px switch rows were retained at phone widths; coarse-pointer-only adjustments also missed narrow windows using a mouse. | Phone-width and coarse-pointer variants provide at least 44px targets for the reviewed controls. |
| Medium | `workspace-tools.module.css`, `ai.module.css`, `gamma/gamma-theme.module.css:10` | Manage hints measured 4.01:1, the Code introduction 3.08:1, and selected source-format labels 4.18:1. Handwritten colors and inconsistent headings weakened continuity across panels. | Use Gamma ink/muted/surface tokens and a darker semantic accent-text token; clarify panel headings and retain the existing primary button background. |

The critique prioritizes three things: controls must look physically contained and comfortably clickable; query/source fields must make the edited expression easy to inspect; and management panels must share the same visual vocabulary as the canvas. These changes address that order. Existing keyboard focus, explicit draft/apply/save boundaries and meaningful primary actions are strengths to preserve. No decorative cards, illustration or new component library were introduced.

## Review process changes

The installed `audit` and `critique` skills now require both full-context views and native-size control crops of the integrated application. Reviewers must inspect open, focused, disabled/error and pressed states, trace the production cascade, and distinguish behavioral, visual and accessibility evidence. A component's provenance or a passing static scan cannot substitute for that evidence.

The `paprika-widgets` skill now includes authoring/provider inventory, explicit icon-only button checks, switch containment, multiline editor height, actual hit areas and tooltip sub-widget invariants. Its coordinated design workflow retains Impeccable's Operate mode, Frontend Design Premium's canonical ownership, the local frontend-design guidance, and the dashboard scope boundary in design-taste-frontend. Gamma source retrieval and adaptations are recorded in [the adapter README](../../../ui/src/features/insights/gamma/README.md).

Updated local skill sources:

- `/Users/benebsworth/.agents/skills/audit/SKILL.md`
- `/Users/benebsworth/.agents/skills/critique/SKILL.md`
- `/Users/benebsworth/.codex/skills/paprika-widgets/SKILL.md`
- `/Users/benebsworth/.codex/skills/paprika-widgets/references/design-review.md`
- `/Users/benebsworth/.codex/skills/paprika-widgets/references/widget-checklist.md`

The widget skill passes the skill creator's validator. The generic validator rejects the audit/critique skills' pre-existing upstream `args` and `user-invocable` frontmatter keys; these were preserved rather than deleting installed skill metadata. The added Markdown changes do not alter their invocation metadata or the audit-only scope when no fix is requested.

## Tooltip history

Heatmap Style → Tooltip content now offers **Details and time series**, with three heights and independent grid/axis controls. Existing dashboards retain details-only tooltips. The view reads the hovered series from the parent widget's existing result and shows exact summaries from the full history while bounding the plotted points. No additional provider query is issued.

The reusable trusted renderer boundary contains errors and recursive sub-widget mounting. JSON, YAML, OpenUI and Go validation share the same optional configuration. See [tooltip sub-widgets](tooltip-widgets.md) for the contract and extension rules.

The final screenshot review caught an additional integration defect in the new sub-view: its history content initially touched the tooltip border while the surrounding sections had a 17px inset. The shared sub-widget wrapper now owns that inset and border-box sizing. The browser suite checks history/plot containment so this specific failure cannot be hidden by passing chart-data tests.

## Static review disposition

Impeccable reports zero deterministic findings. Frontend Design Premium's raw strict run exits with seven findings: four inert test-only focus buttons, two test-harness form detections, and one textarea resize detection that does not follow the CSS-module class. Each was inspected and recorded as a false positive or test-only case; the raw report is retained. No ignore or suppression configuration was added. The detailed evidence is in `artifacts/insights/builder/static-audit-triage.json`.

The previously flagged overshooting easing is no longer present; the scoped Gamma motion uses a smooth non-overshooting curve. No reported production design issue was intentionally left standing. These static results remain separate from browser and visual acceptance.

## Evidence

Baseline captures and computed measurements are preserved separately under `artifacts/insights/builder/baseline-*`. They cover the workspace toolbar, widget editor, guided/raw query editor, open metric menu, checked/unchecked/pressed/focused switches, dashboard management, Code, AI, provider list/form and provider-type menu at 1512px and 390px. A baseline report's `passed` capture flag means the capture completed, not that its design was acceptable.

The repeatable seventh browser suite is `ui/e2e/insights-builder.e2e.mjs`. It combines geometry/contrast assertions with query recovery, provider validation/CRUD, tooltip authoring and persistence, and pointer/keyboard/touch history behavior. The existing real-service suites separately exercise Go, deterministic Prometheus/Tempo HTTP endpoints, conditional writes and persisted documents.

The final builder suite passes all 13 scenarios with no browser page errors. Measurements from the production export:

| Measurement | Before | After |
| --- | --- | --- |
| Manage / Build with AI / Edit dashboard horizontal padding | 0px | 13px on both sides |
| Switch track and thumb | 36×18 track; thumb protruded 3px | 42×24 track; contained when checked, unchecked and pressed |
| Phone toolbar and switch-row height | 32px / 36px | 44px / 44px |
| PromQL textarea | 38px | 110.7px |
| Library import / AI definition / provider header textarea | 38px / 51.9px / 38px | 160px / 190px / 99px |
| Metric menu alignment | Not established by full-page screenshots | 6px between field border and portal border at both widths |
| Enabled normal-size text in the measured authoring surfaces | Several values below 4.5:1 | Lowest measured ratio 4.74:1 |

Full-page screenshots of a scrolled page can misrepresent fixed popup positions. The final gate therefore captures actual viewport images and measures the field and outer portal, not the small input/listbox inside them. `final-query-metric-viewport-390.png` confirms placement. This was a capture/measurement correction, not an application positioning change.

The visual confirmation reviewed toolbar, switch, query, provider, Manage, Code and AI captures at native scale. The tooltip was also reviewed with default axes/grid, at 320×600 and in 844×390 landscape; keyboard scrolling reaches its footer. Relevant local files under `artifacts/insights/builder/`:

- `final-toolbar-1512.png`, `final-switch-checked-1512.png`, `final-switch-pressed-390.png`
- `final-query-builder-1512.png`, `final-query-metric-viewport-390.png`, `final-provider-form-390.png`
- `final-manage-390.png`, `final-code-390.png`, `final-ai-390.png`
- `final-tooltip-configured-native-1512.png`, `final-tooltip-configured-native-390.png`
- `final-tooltip-native-top-320x600.png`, `final-tooltip-native-844x390.png`
- `final-report.json` for the full measurements and scenario results

The production build and TypeScript check pass; all 356 unit tests across 51 files pass; `go test -race ./internal/insights` passes. ESLint reports zero errors and the same three pre-existing warnings outside Insights. `git diff --check` passes. All seven browser-suite results are recorded in [validation](validation.md): 49 scenarios plus 206 widget checks and four explicit N/A cases.

The first combined run had one intermittent failure in the existing mobile long-trace detail check (205 of 206 widget checks passed). Its unlabelled assertion and full-page screenshot did not establish whether the failure concerned text or geometry. The original result is preserved as `artifacts/insights/widget-audit/initial-final-run-report.json`, alongside a diagnostic reproduction. The latter established a rendered-text timing issue: `textContent` already held the complete rows and the panel fit at x12/y231/330×529 within 390×844, but the immediate `innerText` read omitted the label block. A bounded animation-frame wait observed the complete visible Trace ID/Service/Operation 15ms later. Native viewport capture confirmed the rows rendered correctly.

The test now waits for those required visible strings before asserting the same exact values and geometry; it also reports nullable bounds, exact trace text and a native viewport failure capture. This is a condition-based rendering wait, not a fixed delay, a DOM-only substitute or an application fix. All five focused touch-detail checks pass. The final full widget audit passes 206/206 with zero page errors; it captures the same visible-text transition after 17ms on mobile. The first five suites passed twice unchanged, and the thirteen-scenario builder suite passes on the same production export. This records separately passing suites without claiming the earlier full-runner invocation succeeded.

This local review is Chromium desktop/mobile emulation; it does not establish physical-device coverage, production load performance, full WCAG conformance or Grafana parity. Deterministic provider fixtures verify the actual service boundary without connecting to the deployed omega providers.
