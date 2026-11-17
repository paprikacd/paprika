/** Magnitude uses the same ordered, theme-aware scale in distributions and
 * geographic/honeycomb heatmaps. Categorical and status colours stay separate. */
export const densityPalette = Array.from({ length: 24 }, (_, index) => `var(--gamma-density-${index})`);
