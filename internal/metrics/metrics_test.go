package metrics

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"

	"github.com/benebsworth/paprika/internal/clock"
)

func TestTimerAndSince(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fake := clock.NewFake(start)

	got := Timer(fake)
	assert.Equal(t, start, got)

	fake.Add(2 * time.Second)
	assert.InDelta(t, 2.0, Since(fake, got), 0.001)
}

func TestRolloutMetricsRegistered(t *testing.T) {
	// Use a fresh registry so we don't trip duplicate-registration against
	// the global registry used by other tests in this package.
	reg := prometheus.NewRegistry()
	if err := RegisterCollectors(reg); err != nil {
		t.Fatalf("register: %v", err)
	}

	// Bump each collector and assert the registry can gather it without error.
	RolloutCanaryStepTotal.WithLabelValues("r", "ns").Inc()
	RolloutCanaryWeightGauge.WithLabelValues("r", "ns").Set(25)
	RolloutPhaseTotal.WithLabelValues("r", "ns", "Progressing").Inc()

	gathered, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	names := map[string]bool{}
	for _, mf := range gathered {
		names[mf.GetName()] = true
	}
	for _, want := range []string{
		"paprika_rollout_canary_step_total",
		"paprika_rollout_canary_weight_current",
		"paprika_rollout_phase_total",
	} {
		if !names[want] {
			t.Errorf("metric %q not registered", want)
		}
	}
}
