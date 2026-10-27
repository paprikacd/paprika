package pipelines

import (
	"time"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

// Failure streaks count actual observations, never reconcile attempts. Persist
// them with the observation so a restart neither loses nor invents failures.
func nextHealthFailureCount(check api.HealthCheck, previous *api.HealthCheckResult, status api.HealthStatus, now time.Time) int32 {
	if status != api.HealthDegraded {
		return 0
	}
	if !continuesHealthFailure(check, previous, now) {
		return 1
	}
	count := min(max(int32(0), previous.ConsecutiveFailures), api.MaxHealthFailureThreshold)
	if now.After(previous.CheckedAt.Time) && count < api.MaxHealthFailureThreshold {
		count++
	}
	return min(max(int32(1), count), api.MaxHealthFailureThreshold)
}

func continuesHealthFailure(check api.HealthCheck, previous *api.HealthCheckResult, now time.Time) bool {
	if previous == nil || previous.Status != api.HealthDegraded || previous.CheckedAt == nil || previous.ConfigurationHash != health.MeasurementHash(check) {
		return false
	}
	age := now.Sub(previous.CheckedAt.Time)
	return age >= 0 && age <= 2*healthObservationInterval(check)
}

func healthObservationInterval(check api.HealthCheck) time.Duration {
	if check.SLO != nil {
		if _, period, err := health.SLODurations(check); err == nil {
			return period
		}
	}
	return applicationHealthCheckInterval(check.Interval)
}

func healthFailureThresholdReached(app *api.Application, now time.Time) bool {
	threshold := app.Spec.SelfHeal.HealthFailureThreshold
	// Keep existing installations' immediate rollback behavior, including those
	// whose old status has no per-check counter yet.
	if threshold <= 1 {
		return true
	}
	previous := healthResultsByName(app.Status.HealthChecks)
	for _, check := range app.Spec.HealthChecks {
		result := previous[check.Name]
		if result != nil && result.Status == api.HealthDegraded && result.ConsecutiveFailures >= threshold && configuredHealthResultFresh(check, result, now) {
			return true
		}
	}
	return false
}
