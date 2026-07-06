package metrics

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func observeApplications(ctx context.Context, c client.Client, obs metric.Observer) error {
	var apps pipelinesv1alpha1.ApplicationList
	if err := c.List(ctx, &apps); err != nil {
		return fmt.Errorf("list applications: %w", err)
	}

	obs.ObserveInt64(ActiveApplications, int64(len(apps.Items)))

	byPhase := map[string]int64{}
	for i := range apps.Items {
		phase := string(apps.Items[i].Status.Phase)
		if phase == "" {
			phase = "Unknown"
		}
		byPhase[phase]++
	}
	for phase, count := range byPhase {
		obs.ObserveInt64(ApplicationsByPhase, count, metric.WithAttributes(attribute.String("phase", phase)))
	}
	return nil
}

func observeReleases(ctx context.Context, c client.Client, obs metric.Observer) error {
	var releases pipelinesv1alpha1.ReleaseList
	if err := c.List(ctx, &releases); err != nil {
		return fmt.Errorf("list releases: %w", err)
	}

	active := int64(0)
	byPhase := map[string]int64{}
	for i := range releases.Items {
		phase := string(releases.Items[i].Status.Phase)
		if phase == "" {
			phase = "Unknown"
		}
		byPhase[phase]++
		if !isTerminalReleasePhase(pipelinesv1alpha1.ReleasePhase(phase)) {
			active++
		}
	}
	obs.ObserveInt64(ActiveReleases, active)

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
	}, ActiveApplications, ActiveReleases, ApplicationsByPhase, ReleasesByPhase)
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
