// Package querystep chooses the step of a range query so that every caller
// that draws a time series gets the same resolution for the same range. The
// Insights UI, the Insights dashboard reader and the observability gateway
// all use For; the rule is shared with the UI port through
// docs/design/insights/conformance/query-step.json, so both ports must
// produce exactly the same steps.
package querystep

import (
	"math"
	"time"
)

// DefaultTargetPoints is the number of samples a range query aims for when a
// caller has no reason to ask for a different density.
const DefaultTargetPoints = 300

// maxPointsRatio bounds how far a step may over-sample: when the nearest rung
// would return more than this multiple of the target, the next larger rung is
// used instead.
const maxPointsRatio = 1.5

// ladder holds the rungs a computed step snaps to, in ascending order. The
// steps are round numbers so that ranges which differ slightly share one step
// and therefore one cache entry.
var ladder = []time.Duration{
	1 * time.Second,
	2 * time.Second,
	5 * time.Second,
	10 * time.Second,
	15 * time.Second,
	30 * time.Second,
	1 * time.Minute,
	2 * time.Minute,
	5 * time.Minute,
	10 * time.Minute,
	15 * time.Minute,
	30 * time.Minute,
	1 * time.Hour,
	2 * time.Hour,
	3 * time.Hour,
	6 * time.Hour,
	12 * time.Hour,
	24 * time.Hour,
}

// For returns the step for a query over span that aims at targetPoints
// samples and never goes below minStep. The minimum is the finest step the
// data source can serve (a Prometheus scrape interval, for example); it is at
// least one second, and a value that is not on the ladder is honoured
// exactly.
//
// The step is the ladder rung nearest to span/targetPoints on a log scale,
// with ties taking the larger rung. The rung moves up while span/step exceeds
// 1.5 times targetPoints. The result is then raised to the minimum. A span of
// zero or less, or a non-positive targetPoints, yields the minimum.
func For(span time.Duration, targetPoints int, minStep time.Duration) time.Duration {
	floor := max(minStep, time.Second)
	if span <= 0 || targetPoints <= 0 {
		return floor
	}
	target := float64(targetPoints)
	step := max(floor, nearestRung(span.Seconds()/target))
	for span.Seconds()/step.Seconds() > maxPointsRatio*target {
		next, ok := rungAbove(step)
		if !ok {
			break
		}
		step = next
	}
	return step
}

// nearestRung returns the ladder rung closest to raw seconds on a log scale.
// A tie goes to the larger rung. raw is positive.
func nearestRung(raw float64) time.Duration {
	logRaw := math.Log(raw)
	best := ladder[0]
	bestDistance := math.Abs(math.Log(best.Seconds()) - logRaw)
	for _, rung := range ladder[1:] {
		distance := math.Abs(math.Log(rung.Seconds()) - logRaw)
		if distance < bestDistance || distance == bestDistance {
			best, bestDistance = rung, distance
		}
	}
	return best
}

// rungAbove returns the smallest ladder rung greater than step, and false when
// step is at or above the largest rung.
func rungAbove(step time.Duration) (time.Duration, bool) {
	for _, rung := range ladder {
		if rung > step {
			return rung, true
		}
	}
	return 0, false
}
