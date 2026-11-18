// Package capacityhint turns observed hold times into Retry-After hints. Each
// service that refuses work for capacity keeps its own Estimator, so the two
// binaries share no state.
package capacityhint

import (
	"math"
	"sync/atomic"
	"time"
)

const (
	// Alpha weights the newest hold time in the moving average.
	Alpha = 0.2
	// MinSeconds is the smallest hint. A refusal always names a retry.
	MinSeconds = 1
	// MaxSeconds keeps a hint inside the browser's replay cap (10 s). A longer
	// hint would stop the browser from replaying the refused request.
	MaxSeconds = 10
)

// Estimator is an exponentially weighted moving average of hold times, in
// seconds. The zero value has no samples. It is safe for concurrent use.
type Estimator struct {
	bits atomic.Uint64 // float64 seconds; zero means no sample yet
}

// Observe folds one hold time into the average. Non-positive durations are
// ignored, because they carry no information about capacity.
func (e *Estimator) Observe(d time.Duration) {
	if d <= 0 {
		return
	}
	sample := d.Seconds()
	for {
		old := e.bits.Load()
		next := sample
		if old != 0 {
			next = Alpha*sample + (1-Alpha)*math.Float64frombits(old)
		}
		if e.bits.CompareAndSwap(old, math.Float64bits(next)) {
			return
		}
	}
}

// Average returns the current moving average in seconds, or zero with no samples.
func (e *Estimator) Average() float64 {
	return math.Float64frombits(e.bits.Load())
}

// Seconds returns the whole-second hint for a request that has ahead requests
// in front of it and slots parallel slots: ceil((ahead+1) / slots × average),
// kept within MinSeconds to MaxSeconds. With no samples, or no slots, it is
// MinSeconds.
func (e *Estimator) Seconds(ahead, slots int) int {
	average := e.Average()
	if average <= 0 || slots <= 0 {
		return MinSeconds
	}
	ahead = max(ahead, 0)
	hint := math.Ceil(float64(ahead+1) / float64(slots) * average)
	if math.IsNaN(hint) || math.IsInf(hint, 0) {
		return MaxSeconds
	}
	return int(min(max(hint, MinSeconds), MaxSeconds))
}
