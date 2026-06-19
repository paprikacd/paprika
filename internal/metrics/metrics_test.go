package metrics

import (
	"testing"
	"time"

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
