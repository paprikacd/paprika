package metrics

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"k8s.io/apimachinery/pkg/api/meta"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// A non-terminal release younger than this is still making progress; older
// than this, it is reported as stuck. AwaitingApproval is excluded separately
// because waiting for a human gate is a valid steady state.
const stuckReleaseAge = 30 * time.Minute

func observeApplications(ctx context.Context, c client.Client, obs metric.Observer) error {
	var apps pipelinesv1alpha1.ApplicationList
	if err := c.List(ctx, &apps); err != nil {
		return fmt.Errorf("list applications: %w", err)
	}

	obs.ObserveInt64(ActiveApplications, int64(len(apps.Items)))

	byPhase := map[string]int64{}
	stale := int64(0)
	retriesExhausted := int64(0)
	for i := range apps.Items {
		app := &apps.Items[i]
		phase := string(app.Status.Phase)
		if phase == "" {
			phase = "Unknown"
		}
		byPhase[phase]++

		lag := app.Generation - app.Status.ObservedGeneration
		if lag < 0 {
			lag = 0
		}
		obs.ObserveInt64(ApplicationReconcileLag, lag, metric.WithAttributes(
			attribute.String("application", app.Name),
			attribute.String("namespace", app.Namespace),
		))
		if lag > 0 {
			stale++
		}
		if meta.IsStatusConditionTrue(app.Status.Conditions, pipelinesv1alpha1.ConditionReleaseRetriesExhausted) {
			retriesExhausted++
		}
	}
	for phase, count := range byPhase {
		obs.ObserveInt64(ApplicationsByPhase, count, metric.WithAttributes(attribute.String("phase", phase)))
	}
	obs.ObserveInt64(ApplicationsStale, stale)
	obs.ObserveInt64(ApplicationsReleaseRetriesExhausted, retriesExhausted)
	return nil
}

func observeReleases(ctx context.Context, c client.Client, obs metric.Observer) error {
	var releases pipelinesv1alpha1.ReleaseList
	if err := c.List(ctx, &releases); err != nil {
		return fmt.Errorf("list releases: %w", err)
	}

	active := int64(0)
	stuck := int64(0)
	byPhase := map[string]int64{}
	for i := range releases.Items {
		release := &releases.Items[i]
		phase := release.Status.Phase
		label := string(phase)
		if label == "" {
			label = "Unknown"
		}
		byPhase[label]++
		if !isTerminalReleasePhase(phase) {
			active++
			if phase != pipelinesv1alpha1.ReleaseAwaitingApproval &&
				time.Since(release.CreationTimestamp.Time) > stuckReleaseAge {
				stuck++
			}
		}
	}
	obs.ObserveInt64(ActiveReleases, active)
	obs.ObserveInt64(ReleasesStuck, stuck)

	for phase, count := range byPhase {
		obs.ObserveInt64(ReleasesByPhase, count, metric.WithAttributes(attribute.String("phase", phase)))
	}
	return nil
}

func RegisterKubernetesGaugeCallbacks(c client.Client) error {
	_, err := meter.RegisterCallback(func(ctx context.Context, obs metric.Observer) error {
		if err := observeApplications(ctx, c, obs); err != nil {
			return err
		}
		return observeReleases(ctx, c, obs)
	},
		ActiveApplications,
		ActiveReleases,
		ApplicationsByPhase,
		ReleasesByPhase,
		ApplicationReconcileLag,
		ApplicationsStale,
		ApplicationsReleaseRetriesExhausted,
		ReleasesStuck,
	)
	if err != nil {
		return fmt.Errorf("register kubernetes gauge callbacks: %w", err)
	}
	return nil
}

func isTerminalReleasePhase(phase pipelinesv1alpha1.ReleasePhase) bool {
	switch phase {
	case pipelinesv1alpha1.ReleaseComplete,
		pipelinesv1alpha1.ReleaseFailed,
		pipelinesv1alpha1.ReleaseRolledBack,
		pipelinesv1alpha1.ReleaseSuperseded:
		return true
	case pipelinesv1alpha1.ReleasePending,
		pipelinesv1alpha1.ReleasePromoting,
		pipelinesv1alpha1.ReleaseCanarying,
		pipelinesv1alpha1.ReleaseVerifying,
		pipelinesv1alpha1.ReleaseAwaitingApproval:
		return false
	}
	return false
}
