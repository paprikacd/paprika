/**
 * The single owner of plot hatching. A hatched fill means no observation (missing) or invalid source
 * data (warning). A flat `--gamma-chart-empty` fill means an observed zero.
 *
 * Stripes run bottom-left to top-right: 1.5px wide on a 6px pitch, the same as the `.hatch` gradient
 * in plot-hatch.module.css. The stripe is centred at x = 0.75 so the tile edge never clips it.
 */
export type PlotHatchTone = "missing" | "warning";

const TILE = 6;
const STRIPE = 1.5;

function HatchPattern({ id, stroke }: { id: string; stroke: string }) {
  return (
    <pattern id={id} width={TILE} height={TILE} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={TILE} height={TILE} fill="var(--gamma-chart-empty)" />
      <line x1={STRIPE / 2} y1={0} x2={STRIPE / 2} y2={TILE} stroke={stroke} strokeWidth={STRIPE} />
    </pattern>
  );
}

/** Patterns for one plot. Pass an id from `useId()`; the patterns are `${id}-hatch` and `${id}-hatch-warning`. */
export function PlotHatchDefs({ id }: { id: string }) {
  return (
    <defs>
      <HatchPattern id={`${id}-hatch`} stroke="var(--gamma-chart-hatch)" />
      <HatchPattern id={`${id}-hatch-warning`} stroke="var(--gamma-warning)" />
    </defs>
  );
}

/** The `fill` for a shape that uses a hatch. The matching `PlotHatchDefs` or `PlotHatchSvg` must be in the document. */
export function plotHatchFill(id: string, tone: PlotHatchTone = "missing") {
  return `url(#${id}${tone === "warning" ? "-hatch-warning" : "-hatch"})`;
}

/** Hidden SVG holding the patterns, for charts drawn in an `<svg>` we do not render. `url(#id)` resolves across inline SVGs in one document. */
export function PlotHatchSvg({ id }: { id: string }) {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute" }}>
      <PlotHatchDefs id={id} />
    </svg>
  );
}
