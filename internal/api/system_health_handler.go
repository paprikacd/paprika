package apiserver

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
	"github.com/benebsworth/paprika/internal/version"
)

const (
	defaultStuckReleaseSeconds uint32 = 1800
	minStuckReleaseSeconds     uint32 = 60
	maxStuckReleaseSeconds     uint32 = 86400

	healthStatusHealthy  = "healthy"
	healthStatusDegraded = "degraded"
	healthStatusFailed   = "failed"

	healthCheckPass = "pass"
	healthCheckWarn = "warn"
	healthCheckFail = "fail"
)

// GetSystemHealth answers the post-deployment question the fleet status alone
// cannot: is the control plane itself healthy and keeping up? It combines the
// authorized fleet view with reconcile lag, release liveness, controller pod
// readiness, and fleet-index readiness in one read-only call.
func (s *PaprikaServer) GetSystemHealth(
	ctx context.Context,
	req *connect.Request[paprikav1.GetSystemHealthRequest],
) (*connect.Response[paprikav1.GetSystemHealthResponse], error) {
	stuckAfter, err := validateSystemHealthRequest(req)
	if err != nil {
		return nil, err
	}

	reader, err := s.requireFleetIndex()
	if err != nil {
		return nil, err
	}
	snapshot, err := reader.LoadSnapshot()
	if err != nil {
		return nil, mapFleetError(err)
	}
	if snapshot == nil {
		return nil, mapFleetError(&fleet.ErrUnavailable{Reason: "fleet snapshot is unavailable"})
	}
	scope, err := buildFleetQueryScopeFromProjects(
		ctx, s.authorizer, auth.PrincipalFromContext(ctx), snapshot.ProjectKeys(nil),
	)
	if err != nil {
		return nil, mapFleetError(err)
	}
	status, err := snapshot.QueryStatus(scope, fleet.StatusQuery{})
	if err != nil {
		return nil, mapFleetError(err)
	}

	var apps pipelinesv1alpha1.ApplicationList
	if err := s.client.List(ctx, &apps); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("list applications for system health"))
	}
	var releases pipelinesv1alpha1.ReleaseList
	if err := s.client.List(ctx, &releases); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("list releases for system health"))
	}

	authorizedApps := make(map[types.NamespacedName]struct{}, len(apps.Items))
	stale := make([]*paprikav1.StaleApplication, 0)
	retriesExhausted := uint64(0)
	for i := range apps.Items {
		app := &apps.Items[i]
		project := strings.TrimSpace(app.Spec.Project)
		if project == "" {
			project = "default"
		}
		if _, authorized := scope.Projects[fleet.ProjectKey{Namespace: app.Namespace, Name: project}]; !authorized {
			continue
		}
		authorizedApps[types.NamespacedName{Namespace: app.Namespace, Name: app.Name}] = struct{}{}

		lag := app.Generation - app.Status.ObservedGeneration
		if lag > 0 {
			stale = append(stale, &paprikav1.StaleApplication{
				Application:        &paprikav1.FleetObjectKey{Namespace: app.Namespace, Name: app.Name},
				Generation:         uint64(app.Generation),
				ObservedGeneration: uint64(app.Status.ObservedGeneration),
				LagGenerations:     uint64(lag),
			})
		}
		if meta.IsStatusConditionTrue(app.Status.Conditions, pipelinesv1alpha1.ConditionReleaseRetriesExhausted) {
			retriesExhausted++
		}
	}
	sort.Slice(stale, func(i, j int) bool {
		if stale[i].Application.Namespace != stale[j].Application.Namespace {
			return stale[i].Application.Namespace < stale[j].Application.Namespace
		}
		return stale[i].Application.Name < stale[j].Application.Name
	})

	stuck := make([]*paprikav1.StuckRelease, 0)
	now := time.Now()
	threshold := time.Duration(stuckAfter) * time.Second
	for i := range releases.Items {
		release := &releases.Items[i]
		owner := metav1.GetControllerOf(release)
		if owner == nil || owner.Kind != "Application" {
			continue
		}
		if _, authorized := authorizedApps[types.NamespacedName{Namespace: release.Namespace, Name: owner.Name}]; !authorized {
			continue
		}
		phase := release.Status.Phase
		if systemHealthReleaseTerminal(phase) || phase == pipelinesv1alpha1.ReleaseAwaitingApproval {
			continue
		}
		age := now.Sub(release.CreationTimestamp.Time)
		if age <= threshold {
			continue
		}
		if age < 0 {
			age = 0
		}
		stuck = append(stuck, &paprikav1.StuckRelease{
			Release:    &paprikav1.FleetObjectKey{Namespace: release.Namespace, Name: release.Name},
			Phase:      string(phase),
			AgeSeconds: uint64(age.Seconds()),
		})
	}
	sort.Slice(stuck, func(i, j int) bool {
		if stuck[i].Release.Namespace != stuck[j].Release.Namespace {
			return stuck[i].Release.Namespace < stuck[j].Release.Namespace
		}
		return stuck[i].Release.Name < stuck[j].Release.Name
	})

	controller := s.controllerHealth(ctx)
	fleetIndexDegraded := false
	fleetIndexReason := ""
	if readyErr := reader.CheckReady(); readyErr != nil {
		fleetIndexDegraded = true
		fleetIndexReason = readyErr.Error()
	}

	response := &paprikav1.GetSystemHealthResponse{
		Status:                              healthStatusHealthy,
		ServerVersion:                       version.Version,
		ServerGitCommit:                     version.Commit,
		ServerBuildDate:                     version.Date,
		ApplicationsTotal:                   status.Total,
		ApplicationsHealthy:                 status.Health[fleet.HealthHealthy],
		ApplicationsProgressing:             status.Health[fleet.HealthProgressing],
		ApplicationsDegraded:                status.Health[fleet.HealthDegraded],
		ApplicationsFailed:                  status.Health[fleet.HealthFailed],
		ApplicationsUnknown:                 status.Health[fleet.HealthUnknown] + status.Health[fleet.HealthMissing] + status.Health[fleet.HealthUnspecified],
		ApplicationsStale:                   uint64(len(stale)),
		ApplicationsReleaseRetriesExhausted: retriesExhausted,
		ReleasesStuck:                       uint64(len(stuck)),
		StaleApplications:                   stale,
		StuckReleases:                       stuck,
		Controller:                          controller,
		IndexGeneration:                     status.Generation,
		FleetIndexDegraded:                  fleetIndexDegraded,
		FleetIndexReason:                    fleetIndexReason,
	}

	addSystemHealthCheck(response, "server", healthCheckPass,
		fmt.Sprintf("%s (%s)", version.Version, version.Commit))

	if fleetIndexDegraded {
		addSystemHealthCheck(response, "fleet_index", healthCheckFail, fleetIndexReason)
	} else {
		addSystemHealthCheck(response, "fleet_index", healthCheckPass,
			fmt.Sprintf("generation %d ready", status.Generation))
	}

	switch {
	case controller == nil || !controller.GetPresent():
		addSystemHealthCheck(response, "controller_manager", healthCheckWarn,
			"controller-manager deployment not found in the control-plane namespace")
	case !controller.GetReady():
		addSystemHealthCheck(response, "controller_manager", healthCheckFail,
			fmt.Sprintf("%d/%d replicas ready", controller.GetReadyReplicas(), controller.GetDesiredReplicas()))
	case controller.GetRestartCount() > 0:
		addSystemHealthCheck(response, "controller_manager", healthCheckWarn,
			fmt.Sprintf("%d/%d replicas ready, %d container restarts",
				controller.GetReadyReplicas(), controller.GetDesiredReplicas(), controller.GetRestartCount()))
	default:
		addSystemHealthCheck(response, "controller_manager", healthCheckPass,
			fmt.Sprintf("%d/%d replicas ready, no restarts",
				controller.GetReadyReplicas(), controller.GetDesiredReplicas()))
	}

	addSystemHealthCheck(response, "applications", healthCheckPass,
		fmt.Sprintf("%d authorized applications", status.Total))

	if unhealthy := response.GetApplicationsDegraded() + response.GetApplicationsFailed(); unhealthy > 0 {
		addSystemHealthCheck(response, "application_health", healthCheckWarn,
			fmt.Sprintf("%d degraded or failed applications", unhealthy))
	} else {
		addSystemHealthCheck(response, "application_health", healthCheckPass,
			"no degraded or failed applications")
	}

	if response.GetApplicationsStale() > 0 {
		addSystemHealthCheck(response, "application_reconcile", healthCheckWarn,
			fmt.Sprintf("%d applications behind their observed generation", response.GetApplicationsStale()))
	} else {
		addSystemHealthCheck(response, "application_reconcile", healthCheckPass,
			"all observed generations are current")
	}

	if response.GetApplicationsReleaseRetriesExhausted() > 0 {
		addSystemHealthCheck(response, "release_retries", healthCheckWarn,
			fmt.Sprintf("%d applications have exhausted automatic release retries",
				response.GetApplicationsReleaseRetriesExhausted()))
	} else {
		addSystemHealthCheck(response, "release_retries", healthCheckPass,
			"no application has exhausted automatic release retries")
	}

	if response.GetReleasesStuck() > 0 {
		addSystemHealthCheck(response, "releases_stuck", healthCheckWarn,
			fmt.Sprintf("%d active releases older than %s", response.GetReleasesStuck(), threshold))
	} else {
		addSystemHealthCheck(response, "releases_stuck", healthCheckPass,
			fmt.Sprintf("no active release older than %s", threshold))
	}

	return connect.NewResponse(response), nil
}

func validateSystemHealthRequest(
	req *connect.Request[paprikav1.GetSystemHealthRequest],
) (uint32, error) {
	if req == nil || req.Msg == nil {
		return 0, fleetInvalidArgument("request is required")
	}
	seconds := req.Msg.GetStuckReleaseSeconds()
	if seconds == 0 {
		return defaultStuckReleaseSeconds, nil
	}
	if seconds < minStuckReleaseSeconds || seconds > maxStuckReleaseSeconds {
		return 0, fleetInvalidArgument(
			"stuck_release_seconds must be between %d and %d", minStuckReleaseSeconds, maxStuckReleaseSeconds,
		)
	}
	return seconds, nil
}

func addSystemHealthCheck(
	response *paprikav1.GetSystemHealthResponse,
	name, status, message string,
) {
	response.Checks = append(response.Checks, &paprikav1.SystemHealthCheck{
		Name: name, Status: status, Message: message,
	})
	switch status {
	case healthCheckFail:
		response.Status = healthStatusFailed
	case healthCheckWarn:
		if response.Status == healthStatusHealthy {
			response.Status = healthStatusDegraded
		}
	}
}

func systemHealthReleaseTerminal(phase pipelinesv1alpha1.ReleasePhase) bool {
	switch phase {
	case pipelinesv1alpha1.ReleaseComplete,
		pipelinesv1alpha1.ReleaseFailed,
		pipelinesv1alpha1.ReleaseRolledBack,
		pipelinesv1alpha1.ReleaseSuperseded:
		return true
	default:
		return false
	}
}

// controllerHealth reads the controller-manager Deployment and its pods. It is
// deliberately best-effort: a missing Deployment or pod list degrades one
// check; it never fails the whole health call.
func (s *PaprikaServer) controllerHealth(ctx context.Context) *paprikav1.ControllerHealth {
	health := &paprikav1.ControllerHealth{}
	if s == nil || s.k8sClient == nil || s.controlPlaneNamespace == "" {
		return health
	}
	deployments, err := s.k8sClient.AppsV1().Deployments(s.controlPlaneNamespace).List(
		ctx, metav1.ListOptions{LabelSelector: "control-plane=controller-manager"},
	)
	if err != nil || len(deployments.Items) == 0 {
		return health
	}
	sort.Slice(deployments.Items, func(i, j int) bool {
		return deployments.Items[i].Name < deployments.Items[j].Name
	})
	deployment := &deployments.Items[0]

	desired := uint32(1)
	if deployment.Spec.Replicas != nil && *deployment.Spec.Replicas >= 0 {
		desired = uint32(*deployment.Spec.Replicas)
	}
	health.Present = true
	health.DesiredReplicas = desired
	health.ReadyReplicas = uint32(deployment.Status.ReadyReplicas)
	health.AvailableReplicas = uint32(deployment.Status.AvailableReplicas)
	health.Ready = desired > 0 && deployment.Status.ReadyReplicas >= int32(desired)

	if deployment.Spec.Selector == nil {
		return health
	}
	selector, err := metav1.LabelSelectorAsSelector(deployment.Spec.Selector)
	if err != nil {
		return health
	}
	pods, err := s.k8sClient.CoreV1().Pods(s.controlPlaneNamespace).List(
		ctx, metav1.ListOptions{LabelSelector: selector.String()},
	)
	if err != nil {
		return health
	}
	var restarts uint32
	for i := range pods.Items {
		for _, status := range pods.Items[i].Status.ContainerStatuses {
			restarts += uint32(status.RestartCount)
		}
	}
	health.RestartCount = restarts
	return health
}
