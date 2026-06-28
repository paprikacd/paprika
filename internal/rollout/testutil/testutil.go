// Package testutil provides shared helpers for rollout strategy tests.
package testutil

import (
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/rollout/core"
)

// FakeNow is a deterministic anchor time for strategy tests: 2026-01-01 12:00:00 UTC.
var FakeNow = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

// FakeClock returns a clock.Fake anchored at FakeNow.
func FakeClock() *clock.Fake { return clock.NewFake(FakeNow) }

// Inputs returns a SyncInputs backed by FakeClock with zero readiness.
func Inputs() core.SyncInputs { return core.NewSyncInputs(FakeClock()) }

// InputsReady returns a SyncInputs backed by FakeClock with the given readiness.
func InputsReady(stable, canary int32) core.SyncInputs {
	return core.NewSyncInputs(FakeClock()).WithReadyReplicas(stable, canary)
}

// TimeAt returns a metav1.Time offset from FakeNow by the given duration.
// Useful for seeding status fields like CurrentStepStartedAt in tests.
func TimeAt(offset time.Duration) metav1.Time {
	return metav1.NewTime(FakeNow.Add(offset))
}
