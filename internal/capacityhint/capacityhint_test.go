package capacityhint

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestEstimatorWithoutSamplesGivesTheFloor(t *testing.T) {
	var e Estimator
	assert.Equal(t, MinSeconds, e.Seconds(0, 4))
	assert.Equal(t, MinSeconds, e.Seconds(100, 4))
	e.Observe(0)
	e.Observe(-time.Second)
	assert.Equal(t, MinSeconds, e.Seconds(3, 4), "non-positive samples carry no information")
}

func TestEstimatorMovesTowardNewSamples(t *testing.T) {
	var e Estimator
	e.Observe(10 * time.Second)
	assert.InDelta(t, 10, e.Average(), 1e-9, "the first sample is taken as is")
	e.Observe(0 * time.Second)
	assert.InDelta(t, 10, e.Average(), 1e-9, "a non-positive sample does not pull the average down")
	e.Observe(5 * time.Second)
	assert.InDelta(t, Alpha*5+(1-Alpha)*10, e.Average(), 1e-9)
}

func TestEstimatorSecondsScalesWithQueueDepthAndSlots(t *testing.T) {
	var e Estimator
	e.Observe(2 * time.Second)
	// (ahead+1)/slots × 2 s, rounded up.
	assert.Equal(t, 2, e.Seconds(0, 1))
	assert.Equal(t, 4, e.Seconds(1, 1))
	assert.Equal(t, 1, e.Seconds(0, 4), "one of four slots frees within the average")
	assert.Equal(t, 2, e.Seconds(3, 4), "four waiters across four slots take two averages")
	assert.Equal(t, 2, e.Seconds(-5, 1), "a negative depth counts as none ahead, so one average")
	assert.Equal(t, MinSeconds, e.Seconds(0, 0), "no slots gives the floor")
}

func TestEstimatorCapsTheHintAtTheBrowserReplayCap(t *testing.T) {
	var e Estimator
	e.Observe(time.Hour)
	assert.Equal(t, MaxSeconds, e.Seconds(0, 1))
	assert.Equal(t, MaxSeconds, e.Seconds(1000, 1))
}

func TestEstimatorIsSafeForConcurrentUse(t *testing.T) {
	var e Estimator
	var wg sync.WaitGroup
	for range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 200 {
				e.Observe(time.Second)
				_ = e.Seconds(3, 2)
			}
		}()
	}
	wg.Wait()
	assert.InDelta(t, 1, e.Average(), 1e-9)
}
