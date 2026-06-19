package syncwindow

import (
	"strings"
	"testing"
	"time"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestEvaluator_IsSyncAllowed(t *testing.T) {
	t.Parallel()

	fixed := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	e := NewEvaluator()

	tests := []struct {
		name    string
		windows []paprikav1.SyncWindow
		stage   string
		manual  bool
		allowed bool
		reason  string
	}{
		{
			name:    "empty allows",
			allowed: true,
			reason:  "No sync windows configured",
		},
		{
			name:   "manual override allows",
			manual: true,
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowBlock,
				Schedule: "0 9 * * MON-FRI",
				Duration: "8h",
			}},
			allowed: true,
			reason:  "Manual sync override",
		},
		{
			name: "active allow window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "0 9 * * MON-FRI",
				Duration: "8h",
			}},
			allowed: true,
			reason:  "within allow window",
		},
		{
			name: "inactive allow window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "0 18 * * MON-FRI",
				Duration: "8h",
			}},
			allowed: false,
			reason:  "outside allow window",
		},
		{
			name: "active block window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowBlock,
				Schedule: "0 9 * * MON-FRI",
				Duration: "8h",
			}},
			allowed: false,
			reason:  "blocked by window",
		},
		{
			name: "inactive block window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowBlock,
				Schedule: "0 18 * * MON-FRI",
				Duration: "8h",
			}},
			allowed: true,
			reason:  "No blocking window active",
		},
		{
			name: "allow and block overlap prefers block",
			windows: []paprikav1.SyncWindow{
				{Kind: paprikav1.SyncWindowAllow, Schedule: "0 9 * * MON-FRI", Duration: "8h"},
				{Kind: paprikav1.SyncWindowBlock, Schedule: "0 10 * * MON-FRI", Duration: "1h"},
			},
			allowed: false,
			reason:  "blocked by window",
		},
		{
			name: "stage filter excludes window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowBlock,
				Schedule: "0 9 * * MON-FRI",
				Duration: "8h",
				Stages:   []string{"prod"},
			}},
			stage:   "dev",
			allowed: true,
			reason:  "No sync windows apply to stage",
		},
		{
			name: "stage filter includes window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowBlock,
				Schedule: "0 9 * * MON-FRI",
				Duration: "8h",
				Stages:   []string{"dev"},
			}},
			stage:   "dev",
			allowed: false,
			reason:  "blocked by window",
		},
		{
			name: "timezone shifts window",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "0 6 * * MON-FRI",
				Duration: "8h",
				Timezone: "America/New_York",
			}},
			// 10:00 UTC is 06:00 EDT in June.
			allowed: true,
			reason:  "within allow window",
		},
		{
			name: "invalid schedule blocked",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "not-a-cron",
				Duration: "8h",
			}},
			allowed: false,
			reason:  "invalid sync window",
		},
		{
			name: "invalid duration blocked",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "0 9 * * MON-FRI",
				Duration: "not-a-duration",
			}},
			allowed: false,
			reason:  "invalid sync window",
		},
		{
			name: "invalid timezone blocked",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "0 9 * * MON-FRI",
				Duration: "8h",
				Timezone: "Mars/Phobos",
			}},
			allowed: false,
			reason:  "invalid sync window",
		},
		{
			name: "non-positive duration blocked",
			windows: []paprikav1.SyncWindow{{
				Kind:     paprikav1.SyncWindowAllow,
				Schedule: "0 9 * * MON-FRI",
				Duration: "0s",
			}},
			allowed: false,
			reason:  "invalid sync window",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			res := e.IsSyncAllowed(tc.windows, tc.stage, fixed, tc.manual)
			if res.Allowed != tc.allowed {
				t.Fatalf("allowed: got %v, want %v (reason: %s)", res.Allowed, tc.allowed, res.Reason)
			}
			if tc.reason != "" && !strings.Contains(res.Reason, tc.reason) {
				t.Fatalf("reason %q does not contain %q", res.Reason, tc.reason)
			}
		})
	}
}

func TestEvaluator_IsSyncAllowed_NextTransition(t *testing.T) {
	t.Parallel()

	fixed := time.Date(2026, 6, 16, 20, 0, 0, 0, time.UTC)
	e := NewEvaluator()

	res := e.IsSyncAllowed([]paprikav1.SyncWindow{{
		Kind:     paprikav1.SyncWindowAllow,
		Schedule: "0 9 * * *",
		Duration: "8h",
	}}, "", fixed, false)

	if res.Allowed {
		t.Fatalf("expected blocked outside allow window")
	}
	if res.NextTransition == nil {
		t.Fatalf("expected next transition time")
	}
	want := time.Date(2026, 6, 17, 9, 0, 0, 0, time.UTC)
	if !res.NextTransition.Equal(want) {
		t.Fatalf("next transition = %s, want %s", res.NextTransition.UTC().Format(time.RFC3339), want.Format(time.RFC3339))
	}
}

func TestEvaluator_IsSyncAllowed_BlockNextTransition(t *testing.T) {
	t.Parallel()

	fixed := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	e := NewEvaluator()

	res := e.IsSyncAllowed([]paprikav1.SyncWindow{{
		Kind:     paprikav1.SyncWindowBlock,
		Schedule: "0 9 * * *",
		Duration: "8h",
	}}, "", fixed, false)

	if res.Allowed {
		t.Fatalf("expected blocked inside block window")
	}
	if res.NextTransition == nil {
		t.Fatalf("expected next transition time")
	}
	want := time.Date(2026, 6, 16, 17, 0, 0, 0, time.UTC)
	if !res.NextTransition.Equal(want) {
		t.Fatalf("next transition = %s, want %s", res.NextTransition.UTC().Format(time.RFC3339), want.Format(time.RFC3339))
	}
}
