# Shared tooltips and dashboard authoring

## Problem and scope

Several chart families positioned observation details themselves, including fixed coordinates in the literal references and inline inspectors in compound charts. Some seeded a configured entity as a pin before interaction. That made hover appear stuck and caused different collision, focus and editing behavior across routes.

This follow-up in PR #168 unifies those owners inside `labs/widget-lab`. It uses the existing Paprika widget/result/registry contracts, Gamma controls, React and chart dependencies. The deployed showcase remains a synthetic-data evaluation application; it does not execute provider queries or change the production console.

## Shared observation frame

`WidgetVisualization` now supplies `WidgetTooltipProvider`. It records pointer coordinates in an imperative store, so moving the pointer repositions the open portal without rerendering the chart tree. Keyboard inspection uses the focused element. `ObservationTooltip` owns placement, the portal, Gamma theme inheritance, density, dimensions, scrolling, dismissal and accessibility linkage.

Placement tries the preferred side, flips when necessary and shifts within the visible viewport. Both dimensions are bounded, including in narrow or offset visual viewports. Long evidence scrolls inside the frame. Resize, scroll and content-size changes trigger repositioning; direct pointer movement remains immediate. A deliberate pin freezes its anchor while retaining collision handling.

`ChartTooltip` and `DomainInspector` retain each family's exact evidence inside that common frame. The vendor rich-metric owner (stacked, directional and density) and canonical connection-map details use it too. Deliberate supporting-map details and the Threat Hunt investigation sidebar remain inline evidence. The literal references no longer use artwork coordinates for an interactive tooltip. Their query/event disclosure expands inside the same bounded popup. Obsolete inspector columns have been removed; operational summaries remain visible.

A common 180 ms handoff timer allows the pointer to cross the gap into evidence without losing it. Popup hover or focus retains the observation. Repeated empty-space movement cannot postpone dismissal indefinitely. New observations, source replacement, disabled inspection and unmount clean up pending work. Configured/linked selections can highlight an entity without automatically opening a popup or pinning hover to it. One active popup token per widget prevents competing per-row inspectors: a pin retains ownership over transient hover, while a new explicit selection can replace it without moving focus. Handoff holds the last position across the gap; unrelated chart controls cannot retain an old keyboard observation.

The shared focus helper returns focus on explicit Close/Escape and preserves the user's new target during outside dismissal. Returning focus does not reopen the popup. Chart Home/End navigation remains available; popup scrolling keys apply only to popup focus. The widget provider handles active-inspector Escape before the parent editor, preserving nested menus and dialogs. Portals inside native or ARIA modals stay inside the modal's DOM/focus scope.

## Tooltip configuration

The editor property rail has a dedicated **Tooltip** section, separate from Legend:

| Setting | Contract |
| --- | --- |
| Show tooltips | Disables inspection while retaining the saved appearance choices. |
| Density | Comfortable or Compact, using the shared frame. |
| Preferred placement | Automatic, Above, Right, Below or Left; collision handling takes priority. |
| Pointer gap | Integer 0–40 px; blank restores 12 px. |
| Maximum width | Integer 220–640 px; blank restores 330 px, or 292 px for Compact. |
| Maximum height | Integer 160–800 px; blank restores 560 px. |

Actual viewport bounds always take priority over these configured limits. The strict widget schema validates every field. Invalid input retains the last valid preview and blocks Apply; clearing an optional numeric field removes the serialized key. Compatible renderer changes retain the common tooltip preferences.

## Dashboard editing and menus

Every route is wrapped in one `DashboardWorkbench`. `useDashboardPanels` and `WidgetPanelActions` provide the same editor and menu to canonical panels in the 24 domain lenses, both analytical studies, both literal reference routes, the baseline and chart catalogue. The default route uses the same workbench.

Panel actions are **Edit panel**, **Inspect loaded data**, **View configuration** and **Reset panel edits**. Dashboard editing reveals direct Edit controls; Done keeps applied session edits. The dashboard menu resets the whole session. Menus use the existing canonical `GammaActionMenu`, copied unchanged from the pinned source.

The editor reads the live panel result and revalidates an open draft when it changes. Presentation overrides preserve the current panel ID, provider, query, queryRef, layout and controlled lens scope. Apply, Discard, Undo/Redo, reset and compatible visualization switching continue through the existing validated editor model. Authored evidence tables and supporting summaries expose their real view/details actions; they do not advertise an unsupported widget editor.

Edits last within the current dashboard route. Leaving the route or reloading restores defaults. No durable dashboard save or query execution is implied.

## Verification and limits

The regression coverage includes placement at viewport edges and offset/narrow viewports, pointer-store ownership, bounded hover/focus handoff, pin/source invalidation, outside-dismiss focus policy, editor validation and renderer switching, and shared editing coverage for all 31 route entries. Popup-intent tests inspect actual renderer output through a test adapter because a server render alone omits portals and cannot expose accidental initial pins.

Final executed checks:

| Check | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | 671 tests passed across 52 files. |
| `npm run build` | TypeScript checking and production Vite build passed. |
| `designmd lint DESIGN.md` | Zero errors and zero warnings. |
| Renderer provenance check | Current: 72 files; copied Gamma action menu matches the pinned source. |
| Reverse renderer patch application | Passed without changing files. |
| `git diff --check` | Passed; generated unified-diff context whitespace is preserved through a path-scoped Git attribute. |

The build retains dependency comment-annotation and bundle-size advisories; these did not fail compilation. Design lint reports zero errors and zero warnings. The strict premium audit reports the same 52 pre-existing findings as the prior motion extension, with no new finding signatures. This is not a passing global audit.

Browser verification remains unavailable in this session: the connected browser requires a browser-originated conversation and the cloud browser's URL policy blocks the preview. Source review, SSR and pure interaction tests do not establish rendered pointer, focus, responsive or visual behavior. Publication is verified through Sites deployment status; the live showcase is available for direct review.
