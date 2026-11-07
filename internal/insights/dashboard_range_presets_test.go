package insights

import (
	"testing"
	"time"
)

func TestDashboardPresetRanges(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		duration time.Duration
	}{
		{"30m", 30 * time.Minute}, {"30d", 30 * 24 * time.Hour},
	} {
		t.Run(test.name, func(t *testing.T) {
			doc := &dashboardReadDocument{TimeRange: test.name}
			result, from, to, err := dashboardQueryTimeRange(&dashboardQueryRequest{}, doc, now)
			if err != nil {
				t.Fatal(err)
			}
			if to-from != test.duration.Seconds() || result.StepSeconds <= 0 {
				t.Fatalf("unexpected resolved range: %#v (%v to %v)", result, from, to)
			}
			if err := validateDashboardIdentity(&dashboardDocument{SchemaVersion: 1, ID: "test", Title: "Test", TimeRange: test.name}, "test"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
