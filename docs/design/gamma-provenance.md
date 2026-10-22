# Gamma component adaptations

Paprika's static landing page and console use small adaptations of maintained Gamma components. The landing page adapts them in vanilla JavaScript and CSS; the console uses native React primitives. The source was retrieved from the Gamma MCP on 17 and 22 October 2026 with `gamma_list_component_briefs`, `gamma_get_component_brief`, and `gamma_get_component`, with each component's corresponding `gamma_get_catalogue_entry` record. No React runtime, animation package, remote component script, shader, or external reference-site asset is shipped.

| Gamma component | Maintained source returned by MCP | Catalogue record | Paprika use |
| --- | --- | --- | --- |
| MorphTabs | `src/components/MorphTabs.tsx` and component CSS | `gamma://explore/component/morph-tabs` | Directional pointer panel reveal, shared moving underline, automatic keyboard selection |
| SpotlightSurface | `src/components/SpotlightSurface.tsx` and component CSS | `gamma://explore/component/spotlight-surface` | Local pointer light behind meaningful content and native actions; centered keyboard accent |
| CopyField | `src/components/CopyField.tsx` and component CSS | `gamma://explore/component/copy-field` | Integrated command copy surfaces with visible recovery; existing Paprika clipboard behavior retained |
| DisclosureStack | `src/components/DisclosureStack.tsx` and component CSS | `gamma://explore/component/disclosure-stack` | Capability disclosures adapted to native `details`/`summary` |
| ProgressStack | `src/components/ProgressStack.tsx` and component CSS | `gamma://explore/component/progress-stack` | Layered process-card composition for clearly labelled illustrative states |

The landing implementation is in [`landing/gamma-ui.js`](../../landing/gamma-ui.js) and [`landing/gamma-ui.css`](../../landing/gamma-ui.css). Paprika's Barlow typefaces, square corners, paper/navy surfaces, and steel accents replace Gamma's default tokens. The Gamma component bundles returned no third-party copyright or license notice. The SpotlightSurface catalogue explicitly describes its behavior, markup, and token styles as original Gamma work with no external component source or assets imported. This adaptation preserves that provenance; it does not claim that external reference material grants a source-code license.

Gamma lists [Morph UI](https://morph-ui.anmol16.workers.dev/tabs) as MorphTabs' visual reference and [Forge UI](https://forgeui.in/components/onboard-card) as ProgressStack's layered-card reference. Those links are study references. No code or assets were fetched from them or copied into Paprika. SpotlightSurface's references to [Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) and [reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion) describe platform semantics.

## Console React adaptations

The console's adaptations are independent React implementations informed by
the Gamma catalogue contracts. They use Paprika tokens and native elements;
no Gamma source, build output, font, icon, or asset is imported.

| Gamma component | Paprika implementation | Console use |
| --- | --- | --- |
| MorphTabs | [`ui/src/components/ui/morph-tabs.tsx`](../../ui/src/components/ui/morph-tabs.tsx) | Application detail and resource-inspector tabs: measured moving underline, roving tabindex, Arrow/Home/End selection, directional 180ms panel reveal |
| CopyField | [`ui/src/components/ui/copy-field.tsx`](../../ui/src/components/ui/copy-field.tsx) | Source identifiers: read-only value, 22px copy control, success check, retryable failure, polite live announcement |
| EmptyState | [`ui/src/components/ui/empty-state.tsx`](../../ui/src/components/ui/empty-state.tsx) | Sync & diff workbench and resource-inspector no-diff state: context sentence plus one action, never invented data |
| BreadcrumbTrail | [`ui/src/components/ui/breadcrumb-trail.tsx`](../../ui/src/components/ui/breadcrumb-trail.tsx) | Application, pipeline, and rollout detail ancestry: wrapping crumbs, linked scope, `aria-current="page"` on the current record |
| ActionMenu | [`ui/src/components/ui/action-menu.tsx`](../../ui/src/components/ui/action-menu.tsx) | Rollouts table row actions: one visible trigger per row, grouped entries, danger state, arrow/Home/End walking that skips disabled entries |
| SplitButton | [`ui/src/components/ui/split-button.tsx`](../../ui/src/components/ui/split-button.tsx) | Rollout detail actions: `Promote to X%` stays one click away, Hold/Resume and Abort & roll back live behind the fused toggle, viewport-clamped panel |
| SearchField | [`ui/src/components/ui/search-field.tsx`](../../ui/src/components/ui/search-field.tsx) | Console header fleet search: labelled native search input, clear action that returns focus to the field, optional explicit search on Enter |
| DisclosureStack | [`ui/src/components/ui/disclosure-stack.tsx`](../../ui/src/components/ui/disclosure-stack.tsx) | Application detail gates: pending gates start open, settled ones collapse to a summary row, panels stay in the DOM so `aria-controls` always resolves |
| Tooltip | [`ui/src/components/ui/tooltip.tsx`](../../ui/src/components/ui/tooltip.tsx) | Truncated values that need their full text: the observability provider endpoint, the console's polling cadence. Hover opens after a delay, focus opens at once, Escape closes it without moving focus |
| QuickCommand | [`ui/src/components/ui/quick-command.tsx`](../../ui/src/components/ui/quick-command.tsx) | The console's command palette: one search field, grouped results, a roving selection, and ⌘/Ctrl K from anywhere. The fleet index answers the application half; the console's own pages are always offered |
| ResizablePanes | [`ui/src/components/ui/resizable-panes.tsx`](../../ui/src/components/ui/resizable-panes.tsx) | The application detail split: a focusable separator that states the ratio, moves with the arrow keys or a pointer drag, clamps between bounds, and remembers the operator's rail width |

The MorphTabs panel transition is disabled by the console's global
`prefers-reduced-motion` rule; the underline is a measured transform, not a
per-tab border. CopyField keeps the full value in the `title` and accessible
name when the dense rail truncates it. The diff and inspector empty states
carry the same rule as the boards: a missing source is hidden or explained, not
filled with a plausible zero.

ActionMenu and SplitButton share one keyboard contract
([`ui/src/components/ui/menu-behaviour.ts`](../../ui/src/components/ui/menu-behaviour.ts)):
the trigger owns the panel, Enter/Space/ArrowDown opens and focuses the first
enabled entry, ArrowUp/ArrowDown walk it, Home/End jump, Escape and Tab close
and return focus to the trigger, a pointer landing outside closes without
stealing focus, and a printable key selects the entry whose hint it matches.
That last rule is why a shortcut hint is only rendered where it actually
works. Neither menu is a home for a single action or an object's primary
decision: Promote stays a visible control in both rollout surfaces, and only
secondary or destructive work moves behind the toggle or the row trigger.

The Tooltip is an annotation, not a panel: it names a truncated value or a
piece of console vocabulary, opens on hover after a delay and at once on
focus, closes on Escape without moving focus, and is placed against the
viewport so a scrolling ancestor cannot clip it. The QuickCommand palette is
keyboard-first — the search field keeps focus while the selection moves with
`aria-activedescendant`, and Escape closes the dialog and returns focus to
whatever opened it. Its application results come from the fleet index rather
than a local list, because that search is typo-tolerant and server-counted;
the console's own pages are filtered locally and are always available.

[`ui/e2e/console-shell.spec.ts`](../../ui/e2e/console-shell.spec.ts) covers the
surfaces a unit test cannot see: that the palette opens, filters and
navigates, that ⌘K opens it and Escape closes it, that the tooltip stays
inside the viewport, and that the detail rail's divider states its ratio,
moves with both the keyboard and a pointer drag, and survives a reload.

### One vocabulary for the console

The console speaks in square corners, hairline rules and recessed surfaces:
`rounded-[2px]` for anything that holds content, `border-rule` for a
hairline, `bg-inset` for a recessed panel, and `shadow-dropdown` for
something that genuinely floats. A batch of surfaces carried over from the
component library's defaults — rounded cards, pill badges, `border-border`,
`bg-muted` — was brought onto that vocabulary so the console reads as one
thing. The values behind those names are the same ones the console already
used; only the naming changed, plus the corners, which were the difference
the eye could actually see.

Dots, progress bars and skeletons keep their circles. A circle there is a
shape, not a container.

### Console canvas typography

The fleet treemap draws to a canvas, so it cannot inherit Tailwind tokens. Its
application labels use the same Barlow stack as the DOM and are trimmed with a
measured ellipsis; narrow tiles draw only their health glyph rather than a
meaningless fragment of the application name. This is a local rendering fix,
not a new Gamma component.

## Markup contracts

Load `gamma-ui.css` after `site.css` and load `gamma-ui.js` with `defer`.

### Tabs

Use a `[data-gamma-tabs]` container with an accessibly named `[role="tablist"]`. Each native `<button type="button" role="tab">` needs a unique `id`, an `aria-controls` pointing to its own unique panel, and `aria-selected="true"` only for the initial choice. Each panel needs `role="tabpanel"`, the referenced `id`, `aria-labelledby` naming its tab, and `tabindex="0"`. Leave every panel visible in the HTML; do not set `hidden` before enhancement.

```html
<div data-gamma-tabs>
  <div role="tablist" aria-label="Delivery concepts">
    <button type="button" role="tab" id="source-tab" aria-controls="source-panel" aria-selected="true">Source</button>
    <button type="button" role="tab" id="release-tab" aria-controls="release-panel" aria-selected="false">Release</button>
  </div>
  <div role="tabpanel" id="source-panel" aria-labelledby="source-tab" tabindex="0">Source content</div>
  <div role="tabpanel" id="release-panel" aria-labelledby="release-tab" tabindex="0">Release content</div>
</div>
```

JavaScript validates the associations before hiding inactive panels. Failed initialization or disabled JavaScript leaves the content readable. Left/Right cycle enabled tabs; Home/End select the first/last; selection follows keyboard focus instantly. Pointer changes move the underline and reveal the next panel with a 12px directional motion. Reduced motion makes both changes instant. Unselected panels are removed from keyboard and accessibility navigation with the native `hidden` attribute only after initialization. The enhancement emits a bubbling `gamma:tabchange` event whose detail contains the selected `tab` and `panel` IDs.

### Spotlight surfaces

Add `data-spotlight` to a surface containing a meaningful heading, description, and native links or controls. `data-spotlight-size="320"` is optional and clamped to 80–1000px. `data-spotlight-disabled="true"` turns off only the decoration. Mouse and pen update local CSS variables directly; touch keeps normal scrolling and activation. Child focus centers the accent and retains a distinct focus outline. Reduced motion uses a static centered light. The decorative pseudo-element never intercepts input and uses no animation loop.

Use `data-gamma-theme="dark"` for an isolated dark surface or place primitives inside the existing `.on-dark` section to select Paprika's dark token mapping.

### Process cards

Use `.gamma-step-stack` on an ordered list, with `.gamma-step-card` list items. Optional `data-state` values are `done`, `active`, `pending`, and `hold`. The page composition adds a labelled `failed` state for the failed prerequisite example. Use `.gamma-step-kicker`, `.gamma-step-title`, `.gamma-step-detail`, and `.gamma-step-state` for readable labels. Include visible context saying these are illustrative configuration or process states. The adaptation retains the layered card composition but intentionally has no timer, spinner, progressbar role, fabricated percentage, live status announcement, or connection to cluster state.

## Review expectations

Verify mouse and keyboard selection, disabled-tab skipping, visible focus, 390px tab scrolling, reduced motion, touch behavior, and readable content with JavaScript disabled. Surface decoration and panel motion must never carry meaning that disappears with reduced motion or disabled JavaScript.
