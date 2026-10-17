# Gamma component adaptations

Paprika's static landing page uses small vanilla JavaScript and CSS adaptations of maintained Gamma components. The source was retrieved from the Gamma MCP on 17 October 2026 with `gamma_get_component` and its corresponding `gamma_get_catalogue_entry` record. No React runtime, animation package, remote component script, shader, or external reference-site asset is shipped.

| Gamma component | Maintained source returned by MCP | Catalogue record | Paprika use |
| --- | --- | --- | --- |
| MorphTabs | `src/components/MorphTabs.tsx` and component CSS | `gamma://explore/component/morph-tabs` | Directional pointer panel reveal, shared moving underline, automatic keyboard selection |
| SpotlightSurface | `src/components/SpotlightSurface.tsx` and component CSS | `gamma://explore/component/spotlight-surface` | Local pointer light behind meaningful content and native actions; centered keyboard accent |
| CopyField | `src/components/CopyField.tsx` and component CSS | `gamma://explore/component/copy-field` | Integrated command copy surfaces with visible recovery; existing Paprika clipboard behavior retained |
| DisclosureStack | `src/components/DisclosureStack.tsx` and component CSS | `gamma://explore/component/disclosure-stack` | Capability disclosures adapted to native `details`/`summary` |
| ProgressStack | `src/components/ProgressStack.tsx` and component CSS | `gamma://explore/component/progress-stack` | Layered process-card composition for clearly labelled illustrative states |

The implementation is in [`landing/gamma-ui.js`](../../landing/gamma-ui.js) and [`landing/gamma-ui.css`](../../landing/gamma-ui.css). Paprika's Barlow typefaces, square corners, paper/navy surfaces, and steel accents replace Gamma's default tokens. The Gamma component bundles returned no third-party copyright or license notice. The SpotlightSurface catalogue explicitly describes its behavior, markup, and token styles as original Gamma work with no external component source or assets imported. This adaptation preserves that provenance; it does not claim that external reference material grants a source-code license.

Gamma lists [Morph UI](https://morph-ui.anmol16.workers.dev/tabs) as MorphTabs' visual reference and [Forge UI](https://forgeui.in/components/onboard-card) as ProgressStack's layered-card reference. Those links are study references. No code or assets were fetched from them or copied into Paprika. SpotlightSurface's references to [Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) and [reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion) describe platform semantics.

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
