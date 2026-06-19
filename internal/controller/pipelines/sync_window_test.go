package pipelines

import (
	"testing"
	"time"
)

func TestApplicationReconciler_syncWindowRequeueAfter(t *testing.T) {
	t.Parallel()

	fixed := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	r := &ApplicationReconciler{now: func() time.Time { return fixed }}

	tests := []struct {
		name string
		next *time.Time
		want time.Duration
	}{
		{
			name: "nil next returns default requeue",
			next: nil,
			want: defaultRequeue,
		},
		{
			name: "past next returns one second",
			next: ptr(fixed.Add(-5 * time.Minute)),
			want: 1 * time.Second,
		},
		{
			name: "next more than one hour away capped at one hour",
			next: ptr(fixed.Add(2 * time.Hour)),
			want: time.Hour,
		},
		{
			name: "next within one hour returns exact duration",
			next: ptr(fixed.Add(30 * time.Minute)),
			want: 30 * time.Minute,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := r.syncWindowRequeueAfter(tc.next)
			if got != tc.want {
				t.Fatalf("syncWindowRequeueAfter() = %v, want %v", got, tc.want)
			}
		})
	}
}
