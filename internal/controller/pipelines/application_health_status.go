package pipelines

import (
	"context"
	"errors"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

// Persist only health fields before delivery reconciliation. Concurrent release
// updates are preserved, and observations of an old probe spec are discarded.
func (r *ApplicationReconciler) reconcileHealthStatus(ctx context.Context, app *api.Application) error {
	before := app.Status.DeepCopy()
	r.evaluateHealth(ctx, app)
	if before.Health == app.Status.Health && equality.Semantic.DeepEqual(before.HealthChecks, app.Status.HealthChecks) {
		return nil
	}
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var latest api.Application
		if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
			return fmt.Errorf("health status API operation: %w", err)
		}
		if latest.UID != app.UID || !equality.Semantic.DeepEqual(latest.Spec.HealthChecks, app.Spec.HealthChecks) {
			return errors.New("health check configuration changed during observation; retrying")
		}
		base := latest.DeepCopy()
		latest.Status.Health = app.Status.Health
		latest.Status.HealthChecks = app.Status.HealthChecks
		if err := r.client.Status().Patch(ctx, &latest, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
			return fmt.Errorf("health status API operation: %w", err)
		}
		app.Status = latest.Status
		app.ResourceVersion = latest.ResourceVersion
		return nil
	})
	if err != nil {
		return fmt.Errorf("persisting health observation: %w", err)
	}
	return nil
}

func nextHealthObservation(app *api.Application, now time.Time) time.Duration {
	delay := time.Hour
	for _, check := range app.Spec.HealthChecks {
		period := applicationHealthCheckInterval(check.Interval)
		if check.SLO != nil {
			if _, p, err := health.SLODurations(check); err == nil {
				period = p
			}
		}
		until := period - time.Duration(now.UnixNano()%int64(period))
		if until < delay {
			delay = until
		}
	}
	return max(time.Second, delay)
}
