// The query step policy, shared with internal/querystep. Both ports follow the
// same rule and both run docs/design/insights/conformance/query-step.json, so
// change the ladder or the rule in both places and in that fixture together.

// DEFAULT_TARGET_POINTS is the sample count a range query aims for.
export const DEFAULT_TARGET_POINTS = 300;

// MAX_POINTS_RATIO bounds over-sampling: a step whose range would hold more
// than this multiple of the target moves up one rung.
const MAX_POINTS_RATIO = 1.5;

// LADDER_SECONDS holds the rungs a computed step snaps to, in ascending order.
const LADDER_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

// queryStep returns the step in seconds for a query over spanSeconds that aims
// at targetPoints samples and never goes below minStepSeconds. The minimum is
// at least one second and is honoured exactly even when it is off the ladder.
//
// The step is the rung nearest to span / targetPoints on a log scale, with a
// tie taking the larger rung. The rung moves up while span / step exceeds
// 1.5 times targetPoints. The result is then raised to the minimum. A span of
// zero or less, or a non-positive target, yields the minimum.
export function queryStep(spanSeconds: number, targetPoints = DEFAULT_TARGET_POINTS, minStepSeconds = 0): number {
  const floor = Math.max(minStepSeconds, 1);
  if (!(spanSeconds > 0) || !(targetPoints > 0)) return floor;
  let step = Math.max(floor, nearestRung(spanSeconds / targetPoints));
  while (spanSeconds / step > MAX_POINTS_RATIO * targetPoints) {
    const next = LADDER_SECONDS.find((rung) => rung > step);
    if (next === undefined) break;
    step = next;
  }
  return step;
}

// nearestRung returns the ladder rung closest to raw seconds on a log scale.
// A tie goes to the larger rung, because the ladder is scanned in ascending
// order and a rung at an equal distance replaces the one before it.
function nearestRung(raw: number): number {
  const logRaw = Math.log(raw);
  let best = LADDER_SECONDS[0];
  let bestDistance = Math.abs(Math.log(best) - logRaw);
  for (const rung of LADDER_SECONDS.slice(1)) {
    const distance = Math.abs(Math.log(rung) - logRaw);
    if (distance <= bestDistance) {
      best = rung;
      bestDistance = distance;
    }
  }
  return best;
}

// MAX_ALIGN_GRAIN_SECONDS caps the grain a relative window ends on. Matches querystep.MaxAlignGrain.
export const MAX_ALIGN_GRAIN_SECONDS = 15;

/** The grain a relative window of spanSeconds ends on: its default-density step, capped. */
export function alignGrain(spanSeconds: number): number {
  return Math.min(queryStep(spanSeconds), MAX_ALIGN_GRAIN_SECONDS);
}

/** A relative window's end: nowSeconds floored to the grain of its span. Viewers that share a range share the end. */
export function alignedWindowEnd(nowSeconds: number, spanSeconds: number): number {
  const grain = alignGrain(spanSeconds);
  return Math.floor(nowSeconds / grain) * grain;
}
