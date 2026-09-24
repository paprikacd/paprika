package apiserver

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	proto "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/health"
)

func convertOperations(operations *api.ApplicationOperations) *proto.Ownership {
	result := &proto.Ownership{State: proto.DataState_DATA_STATE_NOT_CONFIGURED}
	if operations == nil {
		return result
	}
	result.State = proto.DataState_DATA_STATE_OK
	result.Source = "application"
	result.Owner = operations.Owner
	result.OwnerLabel = operations.OwnerLabel
	result.OnCall = operations.OnCall
	if operations.Tier >= 1 && operations.Tier <= 4 {
		result.Tier = proto.OwnershipTier(operations.Tier)
	}
	kinds := map[string]proto.DrilldownKind{
		"dashboard":  proto.DrilldownKind_DRILLDOWN_KIND_DASHBOARD,
		"logs":       proto.DrilldownKind_DRILLDOWN_KIND_LOGS,
		"traces":     proto.DrilldownKind_DRILLDOWN_KIND_TRACES,
		"runbook":    proto.DrilldownKind_DRILLDOWN_KIND_RUNBOOK,
		"cost":       proto.DrilldownKind_DRILLDOWN_KIND_COST,
		"repository": proto.DrilldownKind_DRILLDOWN_KIND_REPOSITORY,
		"custom":     proto.DrilldownKind_DRILLDOWN_KIND_CUSTOM,
	}
	for _, link := range operations.Links {
		kind, ok := kinds[link.Kind]
		if ok && health.SafeOperationalURL(link.URL) {
			result.Links = append(result.Links, &proto.DrilldownLink{Kind: kind, Label: link.Label, Url: link.URL})
		}
	}
	return result
}

func convertOperationalMetadata(operations *api.ApplicationOperations) map[string]string {
	if operations == nil {
		return nil
	}
	out := make(map[string]string, len(operations.Metadata))
	for key, value := range operations.Metadata {
		out[key] = string(value)
	}
	return out
}

func (s *PaprikaServer) applicationOperations(ctx context.Context, namespace, name string) (*proto.Ownership, error) {
	var app api.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &app); err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	return convertOperations(app.Spec.Operations), nil
}

func (s *PaprikaServer) operationsDataSource(ctx context.Context, namespace *string) *proto.DataSourceStatus {
	result := &proto.DataSourceStatus{DataClass: proto.DataClass_DATA_CLASS_OWNERSHIP, State: proto.DataState_DATA_STATE_NOT_CONFIGURED, UnavailableReason: ownershipUnavailableReason}
	if s.client == nil {
		return result
	}
	var apps api.ApplicationList
	var options []client.ListOption
	if namespace != nil {
		options = append(options, client.InNamespace(*namespace))
	}
	if err := s.client.List(ctx, &apps, options...); err != nil {
		result.State = proto.DataState_DATA_STATE_ERROR
		result.UnavailableReason = "application operational metadata could not be read"
		return result
	}
	for i := range apps.Items {
		app := &apps.Items[i]
		if app.Spec.Operations != nil && s.authorizeApplication(ctx, auth.ActionRead, app) == nil {
			result.State = proto.DataState_DATA_STATE_OK
			result.UnavailableReason = ""
			result.Provider = "Application.spec.operations"
			return result
		}
	}
	return result
}

func convertApplicationHealthChecks(app *api.Application, now time.Time) []*proto.HealthCheckResult {
	results := convertHealthChecks(app.Status.HealthChecks)
	checks := map[string]api.HealthCheck{}
	for _, c := range app.Spec.HealthChecks {
		checks[c.Name] = c
	}
	for i := range app.Status.HealthChecks {
		result := &app.Status.HealthChecks[i]
		results[i].DurationMillis = result.DurationMillis
		check, ok := checks[result.Name]
		if !ok || check.SLO == nil {
			continue
		}
		s := health.SummarizeSLO(check, result.SLOHistory, now)
		converted := &proto.SLOSummary{State: s.State, TargetPercentage: s.Target, WindowSeconds: s.WindowSeconds, IntervalSeconds: s.IntervalSeconds,
			AvailabilityPercentage: s.Availability, CoveragePercentage: s.Coverage, WindowCoveragePercentage: s.WindowCoverage,
			ErrorBudgetRemainingPercentage: s.BudgetRemaining, BurnRate: s.BurnRate, Healthy: s.Healthy, Unhealthy: s.Unhealthy, Unknown: s.Unknown, Expected: s.Expected}
		if !s.FirstObservedAt.IsZero() {
			converted.FirstObservedAt = s.FirstObservedAt.Unix()
		}
		if !s.LastObservedAt.IsZero() {
			converted.LastObservedAt = s.LastObservedAt.Unix()
		}
		for _, b := range s.Timeline {
			converted.Timeline = append(converted.Timeline, &proto.SLOBucket{StartedAt: b.Start.Unix(), Healthy: b.Healthy, Unhealthy: b.Unhealthy, Unknown: b.Unknown})
		}
		results[i].Slo = converted
	}
	return results
}
