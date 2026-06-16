//nolint:dupl // repetitive list filtering patterns
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/redis/go-redis/v9"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/policy"
)

// PaprikaServer implements the PaprikaService connectrpc handler.
type PaprikaServer struct {
	client.Client
	broker                    *events.Broker
	renderer                  engine.TemplateRenderer
	evaluator                 policy.Evaluator
	governanceValidator       *governance.ProjectValidator
	governancePolicyEvaluator *governance.PolicyEvaluator
	authorizer                auth.Authorizer
}

// NewPaprikaServer creates a new PaprikaServer with the given Kubernetes client.
// If broker is nil, an in-memory broker is created. Pass a Redis UniversalClient
// via NewPaprikaServerWithRedis to fan-out events across API server replicas.
func NewPaprikaServer(c client.Client, broker *events.Broker) *PaprikaServer {
	if broker == nil {
		broker = events.NewBroker()
	}
	return &PaprikaServer{Client: c, broker: broker}
}

// NewPaprikaServerWithRedis creates an API server backed by Redis pub/sub events.
func NewPaprikaServerWithRedis(c client.Client, redisClient redis.UniversalClient) (*PaprikaServer, error) {
	broker, err := events.NewRedisBroker(redisClient)
	if err != nil {
		return nil, fmt.Errorf("create redis broker: %w", err)
	}
	return &PaprikaServer{Client: c, broker: broker}, nil
}

// SetRenderer sets the template renderer for ResolveSource and Render methods.
func (s *PaprikaServer) SetRenderer(r engine.TemplateRenderer) {
	s.renderer = r
}

// SetAuthorizer sets the project/RBAC authorizer for server-side access checks.
func (s *PaprikaServer) SetAuthorizer(a auth.Authorizer) {
	s.authorizer = a
}

func (s *PaprikaServer) authorizeApplication(ctx context.Context, action auth.Action, app *pipelinesv1alpha1.Application) error {
	project := app.Spec.Project
	if project == "" {
		project = defaultProjectName
	}
	return s.authorizeProject(ctx, action, auth.ResourceApplications, app.Namespace, project)
}

func (s *PaprikaServer) authorizeProjectFromLabels(ctx context.Context, obj client.Object, resource auth.Resource) bool {
	project := obj.GetLabels()[projectLabelKey]
	if project == "" {
		project = defaultProjectName
	}
	if err := s.authorizeProject(ctx, auth.ActionRead, resource, obj.GetNamespace(), project); err != nil {
		return false
	}
	return true
}

func (s *PaprikaServer) authorizeProject(ctx context.Context, action auth.Action, resource auth.Resource, namespace, project string) error {
	if s.authorizer == nil {
		return nil
	}
	p := auth.PrincipalFromContext(ctx)
	if p == nil {
		return fmt.Errorf("%w: no principal in context", auth.ErrUnauthorized)
	}
	if err := s.authorizer.Authorize(ctx, p, action, resource, namespace, project); err != nil {
		return fmt.Errorf("authorize %s %s in project %q: %w", action, resource, project, err)
	}
	return nil
}

var _ v1connect.PaprikaServiceHandler = (*PaprikaServer)(nil)

// Broker returns the event broker used by the API server.
func (s *PaprikaServer) Broker() *events.Broker {
	return s.broker
}

// ListPipelines returns a list of pipelines.
func (s *PaprikaServer) ListPipelines(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPipelinesRequest],
) (*connect.Response[paprikav1.ListPipelinesResponse], error) {
	var list pipelinesv1alpha1.PipelineList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.List(ctx, &list, opts...); err != nil {
		return nil, fmt.Errorf("listing pipelines: %w", err)
	}
	pipelines := make([]*paprikav1.Pipeline, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		if !s.authorizeProjectFromLabels(ctx, p, auth.ResourcePipelines) {
			continue
		}
		pipelines = append(pipelines, convertPipeline(p))
	}
	return connect.NewResponse(&paprikav1.ListPipelinesResponse{Pipelines: pipelines}), nil
}

// ResolveSource resolves a template source. Requires a renderer (via SetRenderer).
func (s *PaprikaServer) ResolveSource(
	ctx context.Context,
	req *connect.Request[paprikav1.ResolveSourceRequest],
) (*connect.Response[paprikav1.ResolveSourceResponse], error) {
	if s.renderer == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("ResolveSource is not available on this server"))
	}
	tmpl, err := decodeTemplate(req.Msg.Type, req.Msg.SpecJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode template: %w", err))
	}
	result, err := s.renderer.ResolveSource(ctx, tmpl)
	if err != nil {
		return nil, fmt.Errorf("resolve source: %w", err)
	}
	if result == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("source type %q produced no result", req.Msg.Type))
	}
	return connect.NewResponse(&paprikav1.ResolveSourceResponse{
		LocalPath: result.LocalPath,
		Hash:      result.Hash,
		Revision:  result.Revision,
	}), nil
}

// Render renders a template into manifests. Requires a renderer (via SetRenderer).
func (s *PaprikaServer) Render(
	ctx context.Context,
	req *connect.Request[paprikav1.RenderRequest],
) (*connect.Response[paprikav1.RenderResponse], error) {
	if s.renderer == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("Render is not available on this server"))
	}
	tmpl, err := decodeTemplate(req.Msg.Type, req.Msg.SpecJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode template: %w", err))
	}
	values, err := decodeValues(req.Msg.ValuesJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode values: %w", err))
	}
	manifests, err := s.renderer.Render(ctx, tmpl, values)
	if err != nil {
		return nil, fmt.Errorf("render template: %w", err)
	}
	return connect.NewResponse(&paprikav1.RenderResponse{Manifests: manifests}), nil
}

// ListReleases returns a list of releases.
func (s *PaprikaServer) ListReleases(
	ctx context.Context,
	req *connect.Request[paprikav1.ListReleasesRequest],
) (*connect.Response[paprikav1.ListReleasesResponse], error) {
	var list pipelinesv1alpha1.ReleaseList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.List(ctx, &list, opts...); err != nil {
		return nil, fmt.Errorf("listing releases: %w", err)
	}
	releases := make([]*paprikav1.Release, 0, len(list.Items))
	for i := range list.Items {
		rel := &list.Items[i]
		if !s.authorizeProjectFromLabels(ctx, rel, auth.ResourceReleases) {
			continue
		}
		releases = append(releases, convertRelease(rel))
	}
	return connect.NewResponse(&paprikav1.ListReleasesResponse{Releases: releases}), nil
}

// ListStages returns a list of stages.
func (s *PaprikaServer) ListStages(
	ctx context.Context,
	req *connect.Request[paprikav1.ListStagesRequest],
) (*connect.Response[paprikav1.ListStagesResponse], error) {
	var list pipelinesv1alpha1.StageList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.List(ctx, &list, opts...); err != nil {
		return nil, fmt.Errorf("listing stages: %w", err)
	}
	stages := make([]*paprikav1.Stage, 0, len(list.Items))
	for i := range list.Items {
		st := &list.Items[i]
		if !s.authorizeProjectFromLabels(ctx, st, auth.ResourceStages) {
			continue
		}
		stages = append(stages, convertStage(st))
	}
	return connect.NewResponse(&paprikav1.ListStagesResponse{Stages: stages}), nil
}

// ListApplications returns a list of applications.
func (s *PaprikaServer) ListApplications(
	ctx context.Context,
	req *connect.Request[paprikav1.ListApplicationsRequest],
) (*connect.Response[paprikav1.ListApplicationsResponse], error) {
	var list pipelinesv1alpha1.ApplicationList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.List(ctx, &list, opts...); err != nil {
		return nil, fmt.Errorf("listing applications: %w", err)
	}
	applications := make([]*paprikav1.Application, 0, len(list.Items))
	for i := range list.Items {
		app := &list.Items[i]
		project := app.Spec.Project
		if project == "" {
			project = defaultProjectName
		}
		if err := s.authorizeProject(ctx, auth.ActionRead, auth.ResourceApplications, app.Namespace, project); err != nil {
			continue
		}
		applications = append(applications, convertApplication(app))
	}
	return connect.NewResponse(&paprikav1.ListApplicationsResponse{Applications: applications}), nil
}

// ListPolicies returns a list of cluster-scoped policies.
func (s *PaprikaServer) ListPolicies(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPoliciesRequest],
) (*connect.Response[paprikav1.ListPoliciesResponse], error) {
	var list policyv1alpha1.PolicyList
	if err := s.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("listing policies: %w", err)
	}
	policies := make([]*paprikav1.Policy, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		policies = append(policies, &paprikav1.Policy{
			Name:          p.Name,
			Severity:      string(p.Spec.Severity),
			DefaultAction: string(p.Spec.DefaultAction),
			Description:   p.Spec.Description,
		})
	}
	return connect.NewResponse(&paprikav1.ListPoliciesResponse{Policies: policies}), nil
}

// ListApplicationSets returns a list of ApplicationSets.
func (s *PaprikaServer) ListApplicationSets(
	ctx context.Context,
	req *connect.Request[paprikav1.ListApplicationSetsRequest],
) (*connect.Response[paprikav1.ListApplicationSetsResponse], error) {
	var list pipelinesv1alpha1.ApplicationSetList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.List(ctx, &list, opts...); err != nil {
		return nil, fmt.Errorf("listing applicationsets: %w", err)
	}
	sets := make([]*paprikav1.ApplicationSet, 0, len(list.Items))
	for i := range list.Items {
		sets = append(sets, convertApplicationSet(&list.Items[i]))
	}
	return connect.NewResponse(&paprikav1.ListApplicationSetsResponse{Applicationsets: sets}), nil
}

// GetApplicationSet returns a single ApplicationSet by name and namespace.
func (s *PaprikaServer) GetApplicationSet(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationSetRequest],
) (*connect.Response[paprikav1.GetApplicationSetResponse], error) {
	var set pipelinesv1alpha1.ApplicationSet
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &set); err != nil {
		return nil, fmt.Errorf("getting applicationset: %w", err)
	}
	return connect.NewResponse(&paprikav1.GetApplicationSetResponse{
		Applicationset: convertApplicationSet(&set),
	}), nil
}

// GetApplication returns a single application by name and namespace.
func (s *PaprikaServer) GetApplication(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationRequest],
) (*connect.Response[paprikav1.GetApplicationResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	return connect.NewResponse(&paprikav1.GetApplicationResponse{
		Application: convertApplication(&app),
	}), nil
}

// SyncApplication triggers a resync of an application.
func (s *PaprikaServer) SyncApplication(
	ctx context.Context,
	req *connect.Request[paprikav1.SyncApplicationRequest],
) (*connect.Response[paprikav1.SyncApplicationResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	if app.Annotations == nil {
		app.Annotations = make(map[string]string)
	}
	app.Annotations["paprika.io/resync"] = strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := s.Update(ctx, &app); err != nil {
		return nil, fmt.Errorf("triggering resync: %w", err)
	}

	var refreshed pipelinesv1alpha1.Application
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed application: %w", err)
	}

	return connect.NewResponse(&paprikav1.SyncApplicationResponse{
		Application: convertApplication(&refreshed),
	}), nil
}

// ApproveGate approves a manual approval gate for an application.
func (s *PaprikaServer) ApproveGate(
	ctx context.Context,
	req *connect.Request[paprikav1.ApproveGateRequest],
) (*connect.Response[paprikav1.ApproveGateResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	found := false
	for i, g := range app.Status.Gates {
		if g.Name == req.Msg.Gate {
			app.Status.Gates[i].Status = "Approved"
			app.Status.Gates[i].ApprovedBy = "api"
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("gate %s not found", req.Msg.Gate)
	}

	if err := s.Status().Update(ctx, &app); err != nil {
		return nil, fmt.Errorf("updating gate status: %w", err)
	}

	var refreshed pipelinesv1alpha1.Application
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed application: %w", err)
	}

	return connect.NewResponse(&paprikav1.ApproveGateResponse{
		Application: convertApplication(&refreshed),
	}), nil
}

// PaprikaServer RBAC for RollbackRelease.
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;update;patch

// RollbackRelease requests the release controller to roll a release back to the
// previous viable snapshot. It works for both failed and healthy releases by
// setting a rollback annotation and ensuring the release's OnFailure action is
// configured to rollback.
func (s *PaprikaServer) RollbackRelease(
	ctx context.Context,
	req *connect.Request[paprikav1.RollbackReleaseRequest],
) (*connect.Response[paprikav1.RollbackReleaseResponse], error) {
	var release pipelinesv1alpha1.Release
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &release); err != nil {
		return nil, fmt.Errorf("getting release: %w", err)
	}

	// Authorize via the owning Application when possible.
	appName := release.Labels[engine.ApplicationNameLabelKey]
	if appName != "" {
		var app pipelinesv1alpha1.Application
		if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: appName}, &app); err == nil {
			if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
				return nil, connect.NewError(connect.CodePermissionDenied, err)
			}
		}
	}

	if release.Annotations == nil {
		release.Annotations = make(map[string]string)
	}
	release.Annotations[rollbackAnnotation] = strconv.FormatInt(time.Now().UnixNano(), 10)
	if release.Spec.OnFailure == nil {
		release.Spec.OnFailure = &pipelinesv1alpha1.FailureAction{}
	}
	release.Spec.OnFailure.Action = "rollback"

	if err := s.Update(ctx, &release); err != nil {
		return nil, fmt.Errorf("requesting rollback: %w", err)
	}

	var refreshed pipelinesv1alpha1.Release
	if err := s.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed release: %w", err)
	}

	return connect.NewResponse(&paprikav1.RollbackReleaseResponse{
		Release: convertRelease(&refreshed),
	}), nil
}

func convertPipeline(p *pipelinesv1alpha1.Pipeline) *paprikav1.Pipeline {
	steps := make([]*paprikav1.Step, 0, len(p.Spec.Steps))
	for _, s := range p.Spec.Steps {
		steps = append(steps, &paprikav1.Step{
			Name:    s.Name,
			Image:   s.Image,
			Script:  s.Script,
			Depends: s.Depends,
		})
	}
	stepStatuses := make([]*paprikav1.StepStatus, 0, len(p.Status.StepStatuses))
	for _, s := range p.Status.StepStatuses {
		ss := &paprikav1.StepStatus{
			Name:  s.Name,
			Phase: string(s.Phase),
		}
		if s.StartedAt != nil {
			ss.StartedAt = ptr(s.StartedAt.Unix())
		}
		if s.CompletedAt != nil {
			ss.CompletedAt = ptr(s.CompletedAt.Unix())
		}
		stepStatuses = append(stepStatuses, ss)
	}
	artifacts := make([]*paprikav1.ArtifactRef, 0, len(p.Spec.Artifacts))
	for _, a := range p.Spec.Artifacts {
		artifacts = append(artifacts, &paprikav1.ArtifactRef{
			Name: a.Name,
			Path: a.Path,
		})
	}
	return &paprikav1.Pipeline{
		Name:         p.Name,
		Namespace:    p.Namespace,
		CreatedAt:    p.CreationTimestamp.Unix(),
		Steps:        steps,
		MaxParallel:  safeInt32(p.Spec.MaxParallel),
		Phase:        string(p.Status.Phase),
		StepStatuses: stepStatuses,
		Artifacts:    artifacts,
	}
}

func convertRelease(r *pipelinesv1alpha1.Release) *paprikav1.Release {
	promos := make([]*paprikav1.Promotion, 0, len(r.Status.PromotionHistory))
	for _, ph := range r.Status.PromotionHistory {
		promos = append(promos, &paprikav1.Promotion{
			Stage:     ph.Stage,
			Result:    ph.Result,
			Timestamp: ph.Timestamp.Unix(),
		})
	}
	rel := &paprikav1.Release{
		Name:             r.Name,
		Namespace:        r.Namespace,
		CreatedAt:        r.CreationTimestamp.Unix(),
		Pipeline:         r.Spec.Pipeline,
		Target:           r.Spec.Target,
		Phase:            string(r.Status.Phase),
		CurrentStage:     r.Status.CurrentStage,
		PromotionHistory: promos,
		Application:      r.Labels[engine.ApplicationNameLabelKey],
		RolledBackTo:     r.Status.RolledBackTo,
	}
	if r.Spec.ManifestSource != nil {
		rel.ManifestSource = &paprikav1.ManifestSource{
			ConfigMapRef: r.Spec.ManifestSource.ConfigMapRef,
		}
	}
	rel.PolicyResults = make([]*paprikav1.PolicyResult, 0, len(r.Status.PolicyResults))
	for _, pr := range r.Status.PolicyResults {
		rel.PolicyResults = append(rel.PolicyResults, &paprikav1.PolicyResult{
			Name:     pr.Name,
			Severity: pr.Severity,
			Action:   pr.Action,
			Passed:   pr.Passed,
			Message:  pr.Message,
		})
	}
	return rel
}

const (
	phaseReady         = "Ready"
	conditionTypeReady = "Ready"
)

func convertStage(st *pipelinesv1alpha1.Stage) *paprikav1.Stage {
	phase := "Pending"
	if st.Status.LastPromotion != nil {
		phase = phaseReady
	}
	return &paprikav1.Stage{
		Name:      st.Name,
		Namespace: st.Namespace,
		CreatedAt: st.CreationTimestamp.Unix(),
		Ring:      safeInt32(st.Spec.Ring),
		StageName: st.Spec.Name,
		Phase:     phase,
	}
}

func convertApplication(a *pipelinesv1alpha1.Application) *paprikav1.Application {
	stages := make([]*paprikav1.ApplicationStage, 0, len(a.Status.Stages))
	for _, s := range a.Status.Stages {
		stages = append(stages, &paprikav1.ApplicationStage{
			Name:     s.Name,
			Ring:     safeInt32(s.Ring),
			Phase:    s.Phase,
			Release:  s.Release,
			Revision: s.Revision,
		})
	}
	var source *paprikav1.ApplicationSource
	if a.Spec.Source.Type != "" {
		source = &paprikav1.ApplicationSource{
			Type:         a.Spec.Source.Type,
			RepoUrl:      a.Spec.Source.RepoURL,
			Revision:     a.Spec.Source.Revision,
			Path:         a.Spec.Source.Path,
			Bucket:       a.Spec.Source.Bucket,
			Key:          a.Spec.Source.Key,
			Region:       a.Spec.Source.Region,
			Endpoint:     a.Spec.Source.Endpoint,
			SecretRef:    a.Spec.Source.SecretRef,
			PollInterval: a.Spec.Source.PollInterval,
			Chart: &paprikav1.ChartRef{
				Repo:    a.Spec.Source.Chart.Repo,
				Name:    a.Spec.Source.Chart.Name,
				Version: a.Spec.Source.Chart.Version,
				Path:    a.Spec.Source.Chart.Path,
			},
		}
		if a.Spec.Source.Inline != nil {
			source.Inline = &paprikav1.InlineSource{
				ConfigMapRef: a.Spec.Source.Inline.ConfigMapRef,
			}
		}
	}
	return &paprikav1.Application{
		Name:            a.Name,
		Namespace:       a.Namespace,
		Project:         a.Spec.Project,
		Phase:           string(a.Status.Phase),
		CurrentStage:    a.Status.CurrentStage,
		Revision:        a.Status.Revision,
		Synced:          a.Status.Synced,
		TemplateRef:     a.Status.TemplateRef,
		PipelineRef:     a.Status.PipelineRef,
		ReleaseRef:      a.Status.ReleaseRef,
		Stages:          stages,
		Source:          source,
		Strategy:        string(a.Spec.Strategy),
		SyncPolicy:      string(a.Spec.SyncPolicy),
		Parameters:      a.Spec.Parameters,
		SourceHash:      a.Status.SourceHash,
		SourceRevision:  a.Status.SourceRevision,
		Health:          string(a.Status.Health),
		HealthChecks:    convertHealthChecks(a.Status.HealthChecks),
		Resources:       convertResourceSyncs(a.Status.Resources),
		ResourceHealth:  convertResourceHealth(a.Status.ResourceHealth),
		OutOfSync:       safeInt32(a.Status.OutOfSync),
		PrunedResources: safeInt32(a.Status.PrunedResources),
	}
}

func convertApplicationSet(set *pipelinesv1alpha1.ApplicationSet) *paprikav1.ApplicationSet {
	phase := "NotReady"
	for _, c := range set.Status.Conditions {
		if c.Type == conditionTypeReady {
			if c.Status == "True" {
				phase = phaseReady
			}
			break
		}
	}
	return &paprikav1.ApplicationSet{
		Name:         set.Name,
		Namespace:    set.Namespace,
		Applications: safeInt32(int(set.Status.Applications)),
		Phase:        phase,
	}
}

func convertResourceSyncs(syncs []pipelinesv1alpha1.ResourceSync) []*paprikav1.ResourceSync {
	out := make([]*paprikav1.ResourceSync, 0, len(syncs))
	for _, s := range syncs {
		out = append(out, &paprikav1.ResourceSync{
			Kind:      s.Kind,
			Name:      s.Name,
			Namespace: s.Namespace,
			Status:    s.Status,
		})
	}
	return out
}

func convertResourceHealth(healths []pipelinesv1alpha1.ResourceHealth) []*paprikav1.ResourceHealth {
	out := make([]*paprikav1.ResourceHealth, 0, len(healths))
	for _, h := range healths {
		out = append(out, &paprikav1.ResourceHealth{
			Kind:      h.Kind,
			Name:      h.Name,
			Namespace: h.Namespace,
			Health:    h.Health,
			Message:   h.Message,
		})
	}
	return out
}

func convertHealthChecks(results []pipelinesv1alpha1.HealthCheckResult) []*paprikav1.HealthCheckResult {
	out := make([]*paprikav1.HealthCheckResult, 0, len(results))
	for _, r := range results {
		hcr := &paprikav1.HealthCheckResult{
			Name:           r.Name,
			Status:         string(r.Status),
			Message:        r.Message,
			HttpStatusCode: safeInt32(r.HTTPStatusCode),
			HttpBody:       r.HTTPBody,
		}
		if r.CheckedAt != nil {
			hcr.CheckedAt = ptr(r.CheckedAt.Unix())
		}
		out = append(out, hcr)
	}
	return out
}

func ptr[T any](v T) *T {
	return &v
}

func safeInt32(v int) int32 {
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	return int32(v)
}

func decodeTemplate(sourceType string, data []byte) (*pipelinesv1alpha1.Template, error) {
	if len(data) == 0 {
		return nil, errors.New("empty spec json")
	}
	var spec pipelinesv1alpha1.TemplateSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("unmarshal spec: %w", err)
	}
	spec.Type = sourceType
	return &pipelinesv1alpha1.Template{Spec: spec}, nil
}

func decodeValues(data []byte) (map[string]string, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var values map[string]string
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("unmarshal values: %w", err)
	}
	return values, nil
}
