package apiserver

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	appsv1 "k8s.io/api/apps/v1"
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

type systemHealthApplications struct {
	stale            []*paprikav1.StaleApplication
	authorized       map[types.NamespacedName]struct{}
	retriesExhausted uint64
}

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

	applications, err := s.systemHealthApplications(ctx, scope)
	if err != nil {
		return nil, err
	}
	threshold := time.Duration(stuckAfter) * time.Second
	stuck, err := s.systemHealthStuckReleases(ctx, applications.authorized, threshold, time.Now())
	if err != nil {
		return nil, err
	}
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
		ApplicationsStale:                   uint64(len(applications.stale)),
		ApplicationsReleaseRetriesExhausted: applications.retriesExhausted,
		ReleasesStuck:                       uint64(len(stuck)),
		StaleApplications:                   applications.stale,
		StuckReleases:                       stuck,
		Controller:                          controller,
		IndexGeneration:                     status.Generation,
		FleetIndexDegraded:                  fleetIndexDegraded,
		FleetIndexReason:                    fleetIndexReason,
	}
	appendSystemHealthChecks(response, controller, fleetIndexDegraded, fleetIndexReason, threshold)
	return connect.NewResponse(response), nil
}

func (s *PaprikaServer) systemHealthApplications(
	ctx context.Context,
	scope fleet.QueryScope,
) (systemHealthApplications, error) {
	var apps pipelinesv1alpha1.ApplicationList
	if err := s.client.List(ctx, &apps); err != nil {
		return systemHealthApplications{}, connect.NewError(
			connect.CodeInternal, errors.New("list applications for system health"),
		)
	}

	result := systemHealthApplications{
		authorized: make(map[types.NamespacedName]struct{}, len(apps.Items)),
	}
	for i := range apps.Items {
		app := &apps.Items[i]
		project := strings.TrimSpace(app.Spec.Project)
		if project == "" {
			project = "default"
		}
		if _, authorized := scope.Projects[fleet.ProjectKey{Namespace: app.Namespace, Name: project}]; !authorized {
			continue
		}
		result.authorized[types.NamespacedName{Namespace: app.Namespace, Name: app.Name}] = struct{}{}

		lag := app.Generation - app.Status.ObservedGeneration
		if lag > 0 {
			result.stale = append(result.stale, &paprikav1.StaleApplication{
				Application:        &paprikav1.FleetObjectKey{Namespace: app.Namespace, Name: app.Name},
				Generation:         nonNegativeUint64(app.Generation),
				ObservedGeneration: nonNegativeUint64(app.Status.ObservedGeneration),
				LagGenerations:     nonNegativeUint64(lag),
			})
		}
		if meta.IsStatusConditionTrue(app.Status.Conditions, pipelinesv1alpha1.ConditionReleaseRetriesExhausted) {
			result.retriesExhausted++
		}
	}
	sort.Slice(result.stale, func(i, j int) bool {
		if result.stale[i].Application.Namespace != result.stale[j].Application.Namespace {
			return result.stale[i].Application.Namespace < result.stale[j].Application.Namespace
		}
		return result.stale[i].Application.Name < result.stale[j].Application.Name
	})
	return result, nil
}

func (s *PaprikaServer) systemHealthStuckReleases(
	ctx context.Context,
	authorized map[types.NamespacedName]struct{},
	threshold time.Duration,
	now time.Time,
) ([]*paprikav1.StuckRelease, error) {
	var releases pipelinesv1alpha1.ReleaseList
	if err := s.client.List(ctx, &releases); err != nil {
		return nil, connect.NewError(
			connect.CodeInternal, errors.New("list releases for system health"),
		)
	}

	stuck := make([]*paprikav1.StuckRelease, 0)
	for i := range releases.Items {
		release := &releases.Items[i]
		age, isStuck := systemHealthStuckAge(release, authorized, threshold, now)
		if !isStuck {
			continue
		}
		stuck = append(stuck, &paprikav1.StuckRelease{
			Release:    &paprikav1.FleetObjectKey{Namespace: release.Namespace, Name: release.Name},
			Phase:      string(release.Status.Phase),
			AgeSeconds: uint64(age.Seconds()),
		})
	}
	sort.Slice(stuck, func(i, j int) bool {
		if stuck[i].Release.Namespace != stuck[j].Release.Namespace {
			return stuck[i].Release.Namespace < stuck[j].Release.Namespace
		}
		return stuck[i].Release.Name < stuck[j].Release.Name
	})
	return stuck, nil
}

func systemHealthStuckAge(
	release *pipelinesv1alpha1.Release,
	authorized map[types.NamespacedName]struct{},
	threshold time.Duration,
	now time.Time,
) (time.Duration, bool) {
	owner := metav1.GetControllerOf(release)
	if owner == nil || owner.Kind != "Application" {
		return 0, false
	}
	if _, ok := authorized[types.NamespacedName{Namespace: release.Namespace, Name: owner.Name}]; !ok {
		return 0, false
	}
	phase := release.Status.Phase
	if systemHealthReleaseTerminal(phase) || phase == pipelinesv1alpha1.ReleaseAwaitingApproval {
		return 0, false
	}
	age := now.Sub(release.CreationTimestamp.Time)
	if age <= threshold {
		return 0, false
	}
	if age < 0 {
		age = 0
	}
	return age, true
}

func appendSystemHealthChecks(
	response *paprikav1.GetSystemHealthResponse,
	controller *paprikav1.ControllerHealth,
	fleetIndexDegraded bool,
	fleetIndexReason string,
	threshold time.Duration,
) {
	addSystemHealthCheck(response, "server", healthCheckPass,
		fmt.Sprintf("%s (%s)", version.Version, version.Commit))

	if fleetIndexDegraded {
		addSystemHealthCheck(response, "fleet_index", healthCheckFail, fleetIndexReason)
	} else {
		addSystemHealthCheck(response, "fleet_index", healthCheckPass,
			fmt.Sprintf("generation %d ready", response.GetIndexGeneration()))
	}

	controllerStatus, controllerMessage := controllerHealthCheck(controller)
	addSystemHealthCheck(response, "controller_manager", controllerStatus, controllerMessage)

	addSystemHealthCheck(response, "applications", healthCheckPass,
		fmt.Sprintf("%d authorized applications", response.GetApplicationsTotal()))

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
}

func controllerHealthCheck(controller *paprikav1.ControllerHealth) (status, message string) {
	switch {
	case controller == nil || !controller.GetPresent():
		return healthCheckWarn, "controller-manager deployment not found in the control-plane namespace"
	case !controller.GetReady():
		return healthCheckFail, fmt.Sprintf("%d/%d replicas ready",
			controller.GetReadyReplicas(), controller.GetDesiredReplicas())
	case controller.GetRestartCount() > 0:
		return healthCheckWarn, fmt.Sprintf("%d/%d replicas ready, %d container restarts",
			controller.GetReadyReplicas(), controller.GetDesiredReplicas(), controller.GetRestartCount())
	default:
		return healthCheckPass, fmt.Sprintf("%d/%d replicas ready, no restarts",
			controller.GetReadyReplicas(), controller.GetDesiredReplicas())
	}
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
	case pipelinesv1alpha1.ReleasePending,
		pipelinesv1alpha1.ReleasePromoting,
		pipelinesv1alpha1.ReleaseCanarying,
		pipelinesv1alpha1.ReleaseVerifying,
		pipelinesv1alpha1.ReleaseAwaitingApproval:
		return false
	}
	return false
}

// controllerHealth reads the controller-manager Deployment and its pods. It is
// deliberately best-effort: a missing Deployment or pod list degrades one
// check; it never fails the whole health call.
func (s *PaprikaServer) controllerHealth(ctx context.Context) *paprikav1.ControllerHealth {
	health := &paprikav1.ControllerHealth{}
	if s == nil || s.k8sClient == nil || s.controlPlaneNamespace == "" {
		return health
	}
	deployment, found := s.controllerDeployment(ctx)
	if !found {
		return health
	}
	health.Present = true
	health.DesiredReplicas = controllerDesiredReplicas(deployment)
	health.ReadyReplicas = nonNegativeUint32(deployment.Status.ReadyReplicas)
	health.AvailableReplicas = nonNegativeUint32(deployment.Status.AvailableReplicas)
	health.Ready = health.DesiredReplicas > 0 && health.ReadyReplicas >= health.DesiredReplicas
	health.RestartCount = s.controllerRestartCount(ctx, deployment)
	return health
}

func (s *PaprikaServer) controllerDeployment(ctx context.Context) (*appsv1.Deployment, bool) {
	deployments, err := s.k8sClient.AppsV1().Deployments(s.controlPlaneNamespace).List(
		ctx, metav1.ListOptions{LabelSelector: "control-plane=controller-manager"},
	)
	if err != nil || len(deployments.Items) == 0 {
		return nil, false
	}
	sort.Slice(deployments.Items, func(i, j int) bool {
		return deployments.Items[i].Name < deployments.Items[j].Name
	})
	return &deployments.Items[0], true
}

func controllerDesiredReplicas(deployment *appsv1.Deployment) uint32 {
	if deployment.Spec.Replicas == nil {
		return 1
	}
	return nonNegativeUint32(*deployment.Spec.Replicas)
}

func (s *PaprikaServer) controllerRestartCount(ctx context.Context, deployment *appsv1.Deployment) uint32 {
	if deployment.Spec.Selector == nil {
		return 0
	}
	selector, err := metav1.LabelSelectorAsSelector(deployment.Spec.Selector)
	if err != nil {
		return 0
	}
	pods, err := s.k8sClient.CoreV1().Pods(s.controlPlaneNamespace).List(
		ctx, metav1.ListOptions{LabelSelector: selector.String()},
	)
	if err != nil {
		return 0
	}
	var restarts uint32
	for i := range pods.Items {
		statuses := pods.Items[i].Status.ContainerStatuses
		for j := range statuses {
			restarts += nonNegativeUint32(statuses[j].RestartCount)
		}
	}
	return restarts
}

func nonNegativeUint64(value int64) uint64 {
	if value <= 0 {
		return 0
	}
	return uint64(value)
}

func nonNegativeUint32(value int32) uint32 {
	if value <= 0 {
		return 0
	}
	return uint32(value)
}
