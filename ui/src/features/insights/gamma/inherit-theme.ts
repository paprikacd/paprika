/** Portals retain the originating dashboard's theme, including changes while open. */
export function inheritGammaTheme(anchor: Element, panel: HTMLElement) {
  const scope = anchor.closest<HTMLElement>("[data-insights-theme]");
  const copy = () => {
    const computed = getComputedStyle(anchor);
    for (let index = 0; index < computed.length; index++) {
      const name = computed.item(index);
      if (name.startsWith("--gamma-")) panel.style.setProperty(name, computed.getPropertyValue(name));
    }
    if (scope?.dataset.insightsTheme) panel.dataset.insightsTheme = scope.dataset.insightsTheme;
    // A reduced-motion scope zeroes the --gamma-duration-* tokens copied above; the attribute is copied so
    // the portal's own motion checks agree with its scope.
    if (scope?.dataset.motion) panel.dataset.motion = scope.dataset.motion;
    else delete panel.dataset.motion;
    panel.style.colorScheme = computed.getPropertyValue("--gamma-color-scheme").trim() || computed.colorScheme;
  };
  copy();
  const observer = scope && typeof MutationObserver !== "undefined" ? new MutationObserver(copy) : undefined;
  observer?.observe(scope!, { attributes: true, attributeFilter: ["data-insights-theme", "data-density", "data-motion", "style", "class"] });
  // Only refresh tokens at the compact desktop boundary; positioning remains
  // owned by useFloatingPanel / the chart tooltip lifecycle.
  const desktop = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)") : undefined;
  desktop?.addEventListener("change", copy);
  return () => {
    observer?.disconnect();
    desktop?.removeEventListener("change", copy);
  };
}
