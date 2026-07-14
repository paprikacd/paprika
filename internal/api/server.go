//nolint:dupl // repetitive list filtering patterns
package apiserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/controller/pipelines"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/fleet"
	"github.com/benebsworth/paprika/internal/governance"
	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

// ServerOption configures a PaprikaServer via functional options.
type ServerOption func(*PaprikaServer)

// WithRenderer sets the template renderer for ResolveSource and Render methods.
func WithRenderer(r pipelines.SourceResolvingRenderer) ServerOption {
	return func(s *PaprikaServer) { s.renderer = r }
}

// WithAuthorizer sets the project/RBAC authorizer for server-side access checks.
func WithAuthorizer(a auth.Authorizer) ServerOption {
	return func(s *PaprikaServer) { s.authorizer = a }
}

// WithFleetIndex sets the narrow immutable fleet query surface.
func WithFleetIndex(reader fleet.Reader) ServerOption {
	return func(s *PaprikaServer) { s.fleetIndex = reader }
}

// WithClock sets the clock used for annotation timestamps.
func WithClock(clk clock.Clock) ServerOption {
	return func(s *PaprikaServer) { s.Clock = clk }
}

// WithK8sClient sets the raw Kubernetes clientset used for Pod logs and Job
// operations that the controller-runtime client does not expose directly.
func WithK8sClient(c kubernetes.Interface) ServerOption {
	return func(s *PaprikaServer) { s.k8sClient = c }
}

// WithDynamicClient sets the dynamic Kubernetes client used for reading live
// resource manifests of arbitrary GVK in GetResource.
func WithDynamicClient(c dynamic.Interface) ServerOption {
	return func(s *PaprikaServer) { s.dynamicClient = c }
}

// WithRESTMapper sets the RESTMapper used to resolve arbitrary Kubernetes
// kinds for dynamic resource lookups.
func WithRESTMapper(m meta.RESTMapper) ServerOption {
	return func(s *PaprikaServer) { s.restMapper = m }
}

// WithAuditor sets the audit logger used to record mutating API operations.
// If not set, auditing is disabled (NoopAuditor).
func WithAuditor(a audit.Auditor) ServerOption {
	return func(s *PaprikaServer) { s.Auditor = a }
}

// PaprikaServer implements the PaprikaService connectrpc handler.
type PaprikaServer struct {
	client                    client.Client
	k8sClient                 kubernetes.Interface
	dynamicClient             dynamic.Interface
	restMapper                meta.RESTMapper
	broker                    *events.Broker
	renderer                  pipelines.SourceResolvingRenderer
	evaluator                 Evaluator
	governanceValidator       *governance.ProjectValidator
	governancePolicyEvaluator *governance.PolicyEvaluator
	authorizer                auth.Authorizer
	fleetIndex                fleet.Reader
	// Auditor records structured audit events for mutating API operations. When
	// nil, the AuditInterceptor falls back to a NoopAuditor.
	Auditor audit.Auditor
	Clock   clock.Clock
}

// NewPaprikaServer creates a new PaprikaServer with the given Kubernetes client.
// If broker is nil, an in-memory broker is created. Pass a Redis UniversalClient
// via NewPaprikaServerWithRedis to fan-out events across API server replicas.
func NewPaprikaServer(c client.Client, broker *events.Broker, opts ...ServerOption) *PaprikaServer {
	if broker == nil {
		broker = events.NewBroker(logr.Discard())
	}
	s := &PaprikaServer{client: c, broker: broker, Clock: clock.Real{}}
	for _, opt := range opts {
		opt(s)
	}
	if s.Clock == nil {
		s.Clock = clock.Real{}
	}
	return s
}

// NewPaprikaServerWithRedis creates an API server backed by Redis pub/sub events.
func NewPaprikaServerWithRedis(ctx context.Context, c client.Client, redisClient redis.UniversalClient, opts ...ServerOption) (*PaprikaServer, error) {
	broker, err := events.NewRedisBrokerWithContext(ctx, redisClient, logr.Discard())
	if err != nil {
		return nil, fmt.Errorf("create redis broker: %w", err)
	}
	s := &PaprikaServer{client: c, broker: broker, Clock: clock.Real{}}
	for _, opt := range opts {
		opt(s)
	}
	if s.Clock == nil {
		s.Clock = clock.Real{}
	}
	return s, nil
}

func (s *PaprikaServer) now() time.Time {
	if s.Clock != nil {
		return s.Clock.Now()
	}
	return time.Now()
}

// auditor returns the configured Auditor, or a NoopAuditor when none is set so
// callers never need a nil check.
func (s *PaprikaServer) auditor() audit.Auditor {
	if s.Auditor == nil {
		return audit.NoopAuditor{}
	}
	return s.Auditor
}

// AuditInterceptor returns a connect unary interceptor that records audit
// events for mutating RPCs via the server's Auditor. Install it after the auth
// interceptor so the authenticated principal is available.
func (s *PaprikaServer) AuditInterceptor() connect.UnaryInterceptorFunc {
	return NewAuditInterceptor(s.auditor(), s.broker)
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
		return fmt.Errorf("no principal in context: %w", auth.ErrUnauthorized)
	}
	if err := s.authorizer.Authorize(ctx, p, action, resource, namespace, project); err != nil {
		return fmt.Errorf("authorize %s %s in project %q: %w", action, resource, project, err)
	}
	return nil
}

var _ v1connect.PaprikaServiceHandler = (*PaprikaServer)(nil)

// ListArtifacts returns a list of artifacts, optionally filtered by the owning
// pipeline. Artifacts without a project label are skipped, and each artifact is
// authorized via its project label before being returned.
func (s *PaprikaServer) ListArtifacts(
	ctx context.Context,
	req *connect.Request[paprikav1.ListArtifactsRequest],
) (*connect.Response[paprikav1.ListArtifactsResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.ArtifactList
	if err := s.client.List(ctx, &list, client.InNamespace(req.Msg.Namespace)); err != nil {
		recordAPIList(ctx, "artifacts", started, 0, err)
		return nil, fmt.Errorf("listing artifacts: %w", err)
	}
	artifacts := make([]*paprikav1.ArtifactRef, 0, len(list.Items))
	for i := range list.Items {
		a := &list.Items[i]
		if req.Msg.PipelineName != nil && *req.Msg.PipelineName != "" {
			if !hasPipelineOwnerRef(a.OwnerReferences, *req.Msg.PipelineName) {
				continue
			}
		}
		if a.GetLabels()[projectLabelKey] == "" {
			continue
		}
		if !s.authorizeProjectFromLabels(ctx, a, auth.ResourceArtifacts) {
			continue
		}
		artifacts = append(artifacts, convertArtifactToArtifactRef(a, nil))
	}
	recordAPIList(ctx, "artifacts", started, len(artifacts), nil)
	return connect.NewResponse(&paprikav1.ListArtifactsResponse{Artifacts: artifacts}), nil
}

// GetArtifact returns a single artifact by name and namespace. For configmap
// artifacts it fetches the backing ConfigMap to populate the resolved reference
// and a download URL (capped at 256 KiB of raw value).
func (s *PaprikaServer) GetArtifact(
	ctx context.Context,
	req *connect.Request[paprikav1.GetArtifactRequest],
) (*connect.Response[paprikav1.GetArtifactResponse], error) {
	var a pipelinesv1alpha1.Artifact
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &a); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("artifact %s/%s not found", req.Msg.Namespace, req.Msg.Name))
		}
		return nil, fmt.Errorf("getting artifact: %w", err)
	}
	if a.GetLabels()[projectLabelKey] == "" {
		return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("artifact %s/%s has no project label", a.Namespace, a.Name))
	}
	if !s.authorizeProjectFromLabels(ctx, &a, auth.ResourceArtifacts) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}

	var cm *corev1.ConfigMap
	if a.Spec.Type == "configmap" {
		if name, _, err := pipelines.ParseConfigMapReference(a.Spec.Reference); err == nil {
			var fetched corev1.ConfigMap
			if err := s.client.Get(ctx, client.ObjectKey{Namespace: a.Namespace, Name: name}, &fetched); err == nil {
				cm = &fetched
			}
		}
	}

	resp := &paprikav1.GetArtifactResponse{
		Artifact: convertArtifactToArtifactRef(&a, cm),
	}
	if cm != nil {
		resp.DownloadUrl = artifactDownloadURL(&a, cm)
	}
	return connect.NewResponse(resp), nil
}

// hasPipelineOwnerRef reports whether refs contains a controlling owner
// reference to a Pipeline with the given name in the pipelines.paprika.io/v1alpha1 group.
func hasPipelineOwnerRef(refs []metav1.OwnerReference, name string) bool {
	for i := range refs {
		ref := &refs[i]
		if ref.APIVersion == pipelineAPIVersion && ref.Kind == pipelineKind && ref.Name == name {
			return true
		}
	}
	return false
}

// Broker returns the event broker used by the API server.
func (s *PaprikaServer) Broker() *events.Broker {
	return s.broker
}

func recordAPIList(ctx context.Context, resource string, started time.Time, count int, err error) {
	attr := attribute.String("resource", resource)
	paprikametrics.APIListDuration.Record(ctx, time.Since(started).Milliseconds(), metric.WithAttributes(attr))
	paprikametrics.APIListItems.Record(ctx, int64(count), metric.WithAttributes(attr))
	if err != nil {
		paprikametrics.APIListErrors.Add(ctx, 1, metric.WithAttributes(attr))
	}
}

// ListPipelines returns a list of pipelines.
func (s *PaprikaServer) ListPipelines(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPipelinesRequest],
) (*connect.Response[paprikav1.ListPipelinesResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.PipelineList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "pipelines", started, 0, err)
		return nil, fmt.Errorf("listing pipelines: %w", err)
	}
	pipelines := make([]*paprikav1.Pipeline, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		if req.Msg.Project != "" && p.GetLabels()[projectLabelKey] != req.Msg.Project {
			continue
		}
		if !s.authorizeProjectFromLabels(ctx, p, auth.ResourcePipelines) {
			continue
		}
		pipelines = append(pipelines, convertPipeline(p))
	}
	recordAPIList(ctx, "pipelines", started, len(pipelines), nil)
	return connect.NewResponse(&paprikav1.ListPipelinesResponse{Pipelines: pipelines}), nil
}

// ResolveSource resolves a template source. Requires a renderer (via WithRenderer).
func (s *PaprikaServer) ResolveSource(
	ctx context.Context,
	req *connect.Request[paprikav1.ResolveSourceRequest],
) (*connect.Response[paprikav1.ResolveSourceResponse], error) {
	if s.renderer == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("resolveSource is not available on this server"))
	}
	tmpl, err := decodeTemplate(req.Msg.Type, req.Msg.SpecJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode template: %w", err))
	}
	tmpl.Namespace = req.Msg.Namespace
	tmpl.Name = req.Msg.Name
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

// Render renders a template into manifests. Requires a renderer (via WithRenderer).
func (s *PaprikaServer) Render(
	ctx context.Context,
	req *connect.Request[paprikav1.RenderRequest],
) (*connect.Response[paprikav1.RenderResponse], error) {
	if s.renderer == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("render is not available on this server"))
	}
	tmpl, err := decodeTemplate(req.Msg.Type, req.Msg.SpecJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode template: %w", err))
	}
	tmpl.Namespace = req.Msg.Namespace
	tmpl.Name = req.Msg.Name
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

// ListStages returns a list of stages.
func (s *PaprikaServer) ListStages(
	ctx context.Context,
	req *connect.Request[paprikav1.ListStagesRequest],
) (*connect.Response[paprikav1.ListStagesResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.StageList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "stages", started, 0, err)
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
	recordAPIList(ctx, "stages", started, len(stages), nil)
	return connect.NewResponse(&paprikav1.ListStagesResponse{Stages: stages}), nil
}

// ListApplications returns a list of applications.
func (s *PaprikaServer) ListApplications(
	ctx context.Context,
	req *connect.Request[paprikav1.ListApplicationsRequest],
) (*connect.Response[paprikav1.ListApplicationsResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.ApplicationList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "applications", started, 0, err)
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
	recordAPIList(ctx, "applications", started, len(applications), nil)
	return connect.NewResponse(&paprikav1.ListApplicationsResponse{Applications: applications}), nil
}

// ListPolicies returns a list of cluster-scoped policies.
func (s *PaprikaServer) ListPolicies(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPoliciesRequest],
) (*connect.Response[paprikav1.ListPoliciesResponse], error) {
	started := time.Now()
	var list policyv1alpha1.PolicyList
	if err := s.client.List(ctx, &list); err != nil {
		recordAPIList(ctx, "policies", started, 0, err)
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
	recordAPIList(ctx, "policies", started, len(policies), nil)
	return connect.NewResponse(&paprikav1.ListPoliciesResponse{Policies: policies}), nil
}

// ListApplicationSets returns a list of ApplicationSets.
func (s *PaprikaServer) ListApplicationSets(
	ctx context.Context,
	req *connect.Request[paprikav1.ListApplicationSetsRequest],
) (*connect.Response[paprikav1.ListApplicationSetsResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.ApplicationSetList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "applicationsets", started, 0, err)
		return nil, fmt.Errorf("listing applicationsets: %w", err)
	}
	sets := make([]*paprikav1.ApplicationSet, 0, len(list.Items))
	for i := range list.Items {
		a := &list.Items[i]
		if a.GetLabels()[projectLabelKey] == "" {
			continue
		}
		if !s.authorizeProjectFromLabels(ctx, a, auth.ResourceApplications) {
			continue
		}
		sets = append(sets, convertApplicationSet(a))
	}
	recordAPIList(ctx, "applicationsets", started, len(sets), nil)
	return connect.NewResponse(&paprikav1.ListApplicationSetsResponse{Applicationsets: sets}), nil
}

// ListNotificationConfigs returns a list of NotificationConfigs.
func (s *PaprikaServer) ListNotificationConfigs(
	ctx context.Context,
	req *connect.Request[paprikav1.ListNotificationConfigsRequest],
) (*connect.Response[paprikav1.ListNotificationConfigsResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.NotificationConfigList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "notificationconfigs", started, 0, err)
		return nil, fmt.Errorf("listing notification configs: %w", err)
	}
	configs := make([]*paprikav1.NotificationConfig, 0, len(list.Items))
	for i := range list.Items {
		configs = append(configs, convertNotificationConfig(&list.Items[i]))
	}
	recordAPIList(ctx, "notificationconfigs", started, len(configs), nil)
	return connect.NewResponse(&paprikav1.ListNotificationConfigsResponse{NotificationConfigs: configs}), nil
}

func convertNotificationConfig(c *pipelinesv1alpha1.NotificationConfig) *paprikav1.NotificationConfig {
	triggers := make([]*paprikav1.NotificationTrigger, 0, len(c.Spec.Triggers))
	for _, t := range c.Spec.Triggers {
		triggers = append(triggers, &paprikav1.NotificationTrigger{
			ResourceType: t.ResourceType,
			Phase:        t.Phase,
			Reason:       t.Reason,
		})
	}
	destinations := make([]*paprikav1.NotificationDestination, 0, len(c.Spec.Destinations))
	for _, d := range c.Spec.Destinations {
		destinations = append(destinations, &paprikav1.NotificationDestination{
			Name:            d.Name,
			WebhookUrl:      d.WebhookURL,
			SlackWebhookUrl: d.SlackWebhookURL,
			Email:           d.Email,
			SecretRef:       d.SecretRef,
			Headers:         d.Headers,
		})
	}
	cfg := &paprikav1.NotificationConfig{
		Name:         c.Name,
		Namespace:    c.Namespace,
		Triggers:     triggers,
		Destinations: destinations,
		Template:     c.Spec.Template,
	}
	if c.Spec.SMTP != nil {
		cfg.Smtp = &paprikav1.SMTPConfig{
			Host:          c.Spec.SMTP.Host,
			Port:          safeInt32(c.Spec.SMTP.Port),
			From:          c.Spec.SMTP.From,
			TlsEnabled:    c.Spec.SMTP.TLSEnabled,
			AuthSecretRef: c.Spec.SMTP.AuthSecretRef,
		}
	}
	if c.Spec.RateLimit != nil {
		cfg.RateLimit = &paprikav1.NotificationRateLimit{
			MinInterval: c.Spec.RateLimit.MinInterval,
		}
	}
	return cfg
}

// GetApplicationSet returns a single ApplicationSet by name and namespace.
func (s *PaprikaServer) GetApplicationSet(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationSetRequest],
) (*connect.Response[paprikav1.GetApplicationSetResponse], error) {
	var set pipelinesv1alpha1.ApplicationSet
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &set); err != nil {
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
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
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
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	if app.Annotations == nil {
		app.Annotations = make(map[string]string)
	}
	app.Annotations["paprika.io/sync"] = strconv.FormatInt(s.now().UnixNano(), 10)
	app.Annotations["paprika.io/manual-sync"] = strconv.FormatInt(s.now().UnixNano(), 10)
	if err := s.client.Update(ctx, &app); err != nil {
		return nil, fmt.Errorf("triggering sync: %w", err)
	}

	var refreshed pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed application: %w", err)
	}

	return connect.NewResponse(&paprikav1.SyncApplicationResponse{
		Application: convertApplication(&refreshed),
	}), nil
}

// PaprikaServer RBAC for approval gates.
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch

// ApproveGate approves a manual approval gate for an application.
func (s *PaprikaServer) ApproveGate(
	ctx context.Context,
	req *connect.Request[paprikav1.ApproveGateRequest],
) (*connect.Response[paprikav1.ApproveGateResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	found := false
	for i, g := range app.Status.Gates {
		if g.Name == req.Msg.Gate {
			app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusApproved
			app.Status.Gates[i].ApprovedBy = "api"
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("gate %s not found", req.Msg.Gate)
	}

	if err := s.client.Status().Update(ctx, &app); err != nil {
		return nil, fmt.Errorf("updating gate status: %w", err)
	}

	var refreshed pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed application: %w", err)
	}

	return connect.NewResponse(&paprikav1.ApproveGateResponse{
		Application: convertApplication(&refreshed),
	}), nil
}

// ListGateStatus returns the approval gate statuses for an application.
func (s *PaprikaServer) ListGateStatus(
	ctx context.Context,
	req *connect.Request[paprikav1.ListGateStatusRequest],
) (*connect.Response[paprikav1.ListGateStatusResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	return connect.NewResponse(&paprikav1.ListGateStatusResponse{Gates: convertGateStatuses(app.Status.Gates)}), nil
}

// RejectGate rejects a manual approval gate for an application.
func (s *PaprikaServer) RejectGate(
	ctx context.Context,
	req *connect.Request[paprikav1.RejectGateRequest],
) (*connect.Response[paprikav1.RejectGateResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	found := false
	for i := range app.Status.Gates {
		if app.Status.Gates[i].Name == req.Msg.Gate {
			app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusRejected
			app.Status.Gates[i].ApprovedBy = ""
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("gate %s not found", req.Msg.Gate)
	}

	if err := s.client.Status().Update(ctx, &app); err != nil {
		return nil, fmt.Errorf("updating gate status: %w", err)
	}

	var refreshed pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed application: %w", err)
	}

	return connect.NewResponse(&paprikav1.RejectGateResponse{
		Application: convertApplication(&refreshed),
	}), nil
}

// PaprikaServer RBAC for RollbackRelease.
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;update;patch

// PaprikaServer RBAC for Rollout RPCs.
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/status,verbs=get;update;patch

// RollbackRelease requests the release controller to roll a release back to the
// previous viable snapshot. It works for both failed and healthy releases by
// setting a rollback annotation and ensuring the release's OnFailure action is
// configured to rollback.
func (s *PaprikaServer) RollbackRelease(
	ctx context.Context,
	req *connect.Request[paprikav1.RollbackReleaseRequest],
) (*connect.Response[paprikav1.RollbackReleaseResponse], error) {
	var release pipelinesv1alpha1.Release
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &release); err != nil {
		return nil, fmt.Errorf("getting release: %w", err)
	}

	// Authorize via the owning Application when possible.
	appName := release.Labels[engine.ApplicationNameLabelKey]
	if appName != "" {
		var app pipelinesv1alpha1.Application
		if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: appName}, &app); err == nil {
			if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
				return nil, connect.NewError(connect.CodePermissionDenied, err)
			}
		}
	}

	if release.Annotations == nil {
		release.Annotations = make(map[string]string)
	}
	release.Annotations[rollbackAnnotation] = strconv.FormatInt(s.now().UnixNano(), 10)
	if release.Spec.OnFailure == nil {
		release.Spec.OnFailure = &pipelinesv1alpha1.FailureAction{}
	}
	release.Spec.OnFailure.Action = "rollback"

	if err := s.client.Update(ctx, &release); err != nil {
		return nil, fmt.Errorf("requesting rollback: %w", err)
	}

	var refreshed pipelinesv1alpha1.Release
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed release: %w", err)
	}

	return connect.NewResponse(&paprikav1.RollbackReleaseResponse{
		Release: convertRelease(&refreshed),
	}), nil
}

// ListRollouts returns a list of rollouts.
func (s *PaprikaServer) ListRollouts(
	ctx context.Context,
	req *connect.Request[paprikav1.ListRolloutsRequest],
) (*connect.Response[paprikav1.ListRolloutsResponse], error) {
	started := time.Now()
	var list rolloutsv1alpha1.RolloutList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "rollouts", started, 0, err)
		return nil, fmt.Errorf("listing rollouts: %w", err)
	}
	rollouts := make([]*paprikav1.Rollout, 0, len(list.Items))
	for i := range list.Items {
		ro := &list.Items[i]
		if !s.authorizeProjectFromLabels(ctx, ro, auth.ResourceRollouts) {
			continue
		}
		rollouts = append(rollouts, convertRollout(ro))
	}
	recordAPIList(ctx, "rollouts", started, len(rollouts), nil)
	return connect.NewResponse(&paprikav1.ListRolloutsResponse{Rollouts: rollouts}), nil
}

// GetRollout returns a single rollout by name and namespace.
func (s *PaprikaServer) GetRollout(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRolloutRequest],
) (*connect.Response[paprikav1.GetRolloutResponse], error) {
	var ro rolloutsv1alpha1.Rollout
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &ro); err != nil {
		return nil, fmt.Errorf("getting rollout: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &ro, auth.ResourceRollouts) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}
	return connect.NewResponse(&paprikav1.GetRolloutResponse{Rollout: convertRollout(&ro)}), nil
}

// PromoteRollout advances the rollout to the next step or final promotion.
func (s *PaprikaServer) PromoteRollout(
	ctx context.Context,
	req *connect.Request[paprikav1.PromoteRolloutRequest],
) (*connect.Response[paprikav1.PromoteRolloutResponse], error) {
	var ro rolloutsv1alpha1.Rollout
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &ro); err != nil {
		return nil, fmt.Errorf("getting rollout: %w", err)
	}
	if err := s.authorizeRolloutWrite(ctx, &ro); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	if ro.Annotations == nil {
		ro.Annotations = make(map[string]string)
	}
	ro.Annotations["paprika.io/promote"] = strconv.FormatInt(s.now().UnixNano(), 10)
	if err := s.client.Update(ctx, &ro); err != nil {
		return nil, fmt.Errorf("promoting rollout: %w", err)
	}
	var refreshed rolloutsv1alpha1.Rollout
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed rollout: %w", err)
	}
	return connect.NewResponse(&paprikav1.PromoteRolloutResponse{Rollout: convertRollout(&refreshed)}), nil
}

// AbortRollout cancels an in-progress rollout.
func (s *PaprikaServer) AbortRollout(
	ctx context.Context,
	req *connect.Request[paprikav1.AbortRolloutRequest],
) (*connect.Response[paprikav1.AbortRolloutResponse], error) {
	var ro rolloutsv1alpha1.Rollout
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &ro); err != nil {
		return nil, fmt.Errorf("getting rollout: %w", err)
	}
	if err := s.authorizeRolloutWrite(ctx, &ro); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	if ro.Annotations == nil {
		ro.Annotations = make(map[string]string)
	}
	ro.Annotations["paprika.io/abort"] = strconv.FormatInt(s.now().UnixNano(), 10)
	if err := s.client.Update(ctx, &ro); err != nil {
		return nil, fmt.Errorf("aborting rollout: %w", err)
	}
	var refreshed rolloutsv1alpha1.Rollout
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
		return nil, fmt.Errorf("getting refreshed rollout: %w", err)
	}
	return connect.NewResponse(&paprikav1.AbortRolloutResponse{Rollout: convertRollout(&refreshed)}), nil
}

func (s *PaprikaServer) authorizeRolloutWrite(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error {
	appName := ro.Labels[engine.ApplicationNameLabelKey]
	if appName != "" {
		var app pipelinesv1alpha1.Application
		if err := s.client.Get(ctx, client.ObjectKey{Namespace: ro.Namespace, Name: appName}, &app); err == nil {
			return s.authorizeApplication(ctx, auth.ActionWrite, &app)
		}
	}
	if !s.authorizeProjectFromLabels(ctx, ro, auth.ResourceRollouts) {
		return auth.ErrUnauthorized
	}
	return nil
}

// ListAnalysisRuns returns analysis executions, optionally scoped to namespace,
// project, and owning application.
func (s *PaprikaServer) ListAnalysisRuns(
	ctx context.Context,
	req *connect.Request[paprikav1.ListAnalysisRunsRequest],
) (*connect.Response[paprikav1.ListAnalysisRunsResponse], error) {
	started := time.Now()
	var list pipelinesv1alpha1.AnalysisRunList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		recordAPIList(ctx, "analysisruns", started, 0, err)
		return nil, fmt.Errorf("listing analysis runs: %w", err)
	}

	runs := make([]*paprikav1.AnalysisRun, 0, len(list.Items))
	for i := range list.Items {
		run := &list.Items[i]
		if req.Msg.ApplicationName != "" && run.Spec.ApplicationRef != req.Msg.ApplicationName {
			continue
		}
		if req.Msg.Project != "" && run.GetLabels()[projectLabelKey] != req.Msg.Project {
			continue
		}
		if !s.authorizeProjectFromLabels(ctx, run, auth.ResourceApplications) {
			continue
		}
		runs = append(runs, convertAnalysisRun(run))
	}
	recordAPIList(ctx, "analysisruns", started, len(runs), nil)
	return connect.NewResponse(&paprikav1.ListAnalysisRunsResponse{AnalysisRuns: runs}), nil
}

// GetAnalysisRun returns one analysis execution by namespace/name.
func (s *PaprikaServer) GetAnalysisRun(
	ctx context.Context,
	req *connect.Request[paprikav1.GetAnalysisRunRequest],
) (*connect.Response[paprikav1.GetAnalysisRunResponse], error) {
	var run pipelinesv1alpha1.AnalysisRun
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &run); err != nil {
		return nil, fmt.Errorf("getting analysis run: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &run, auth.ResourceApplications) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}
	return connect.NewResponse(&paprikav1.GetAnalysisRunResponse{AnalysisRun: convertAnalysisRun(&run)}), nil
}

func convertRollout(r *rolloutsv1alpha1.Rollout) *paprikav1.Rollout {
	out := &paprikav1.Rollout{
		Name:                  r.Name,
		Namespace:             r.Namespace,
		StrategyType:          r.Spec.Strategy.Type,
		Phase:                 string(r.Status.Phase),
		CurrentStep:           r.Status.CurrentStepIndex,
		CurrentWeight:         r.Status.CurrentStepWeight,
		StableRs:              r.Status.StableRS,
		CanaryRs:              r.Status.CanaryRS,
		ActiveService:         r.Status.ActiveService,
		PreviewService:        r.Status.PreviewService,
		ObservedGeneration:    r.Status.ObservedGeneration,
		Conditions:            convertConditions(r.Status.Conditions),
		Message:               r.Status.Message,
		TargetKind:            r.Spec.Target.Kind,
		TargetName:            r.Spec.Target.Name,
		Paused:                r.Spec.Paused,
		Abort:                 r.Status.Abort,
		StableReadyReplicas:   r.Status.StableReadyReplicas,
		CanaryReadyReplicas:   r.Status.CanaryReadyReplicas,
		CurrentPodHash:        r.Status.CurrentPodHash,
		PreviousActiveRs:      r.Status.PreviousActiveRS,
		TrafficRouter:         convertRolloutTrafficRouter(r.Spec.TrafficRouter),
		CanarySteps:           convertRolloutCanarySteps(r.Spec.Strategy.Canary),
		AnalysisChecks:        convertRolloutAnalysisChecks(&r.Spec.Strategy),
		AbRoutes:              convertRolloutABRoutes(r.Spec.Strategy.ABTest),
		MirrorPercent:         rolloutMirrorPercent(r.Spec.Strategy.Mirror),
		AutoPromotionSeconds:  rolloutAutoPromotionSeconds(r.Spec.Strategy.BlueGreen),
		ScaleDownDelaySeconds: rolloutScaleDownDelaySeconds(r.Spec.Strategy.BlueGreen),
	}
	if r.Spec.Replicas != nil {
		out.Replicas = *r.Spec.Replicas
	}
	if r.Status.CurrentStepStartedAt != nil {
		out.CurrentStepStartedAt = r.Status.CurrentStepStartedAt.Unix()
	}
	if r.Status.PromotedAt != nil {
		out.PromotedAt = r.Status.PromotedAt.Unix()
	}
	if r.Status.PreviewHealthyAt != nil {
		out.PreviewHealthyAt = r.Status.PreviewHealthyAt.Unix()
	}
	return out
}

func convertRolloutTrafficRouter(in *rolloutsv1alpha1.TrafficRouter) *paprikav1.TrafficRouter {
	if in == nil {
		return nil
	}
	out := &paprikav1.TrafficRouter{Provider: in.Provider}
	if in.Istio != nil {
		out.Istio = &paprikav1.IstioRouterConfig{
			VirtualService: in.Istio.VirtualService,
			Routes:         append([]string(nil), in.Istio.Routes...),
			Hosts:          append([]string(nil), in.Istio.Hosts...),
			StableService:  in.Istio.StableService,
			CanaryService:  in.Istio.CanaryService,
		}
	}
	if in.GatewayAPI != nil {
		out.GatewayApi = &paprikav1.GatewayAPIRouterConfig{
			HttpRoute:     in.GatewayAPI.HTTPRoute,
			StableService: in.GatewayAPI.StableService,
			CanaryService: in.GatewayAPI.CanaryService,
		}
	}
	return out
}

func convertRolloutCanarySteps(in *rolloutsv1alpha1.CanaryStrategy) []*paprikav1.RolloutStep {
	if in == nil {
		return nil
	}
	out := make([]*paprikav1.RolloutStep, 0, len(in.Steps))
	for _, step := range in.Steps {
		converted := &paprikav1.RolloutStep{SetWeight: step.SetWeight}
		if step.Duration != nil {
			converted.Duration = step.Duration.Duration.String()
		}
		out = append(out, converted)
	}
	return out
}

func convertRolloutAnalysisChecks(strategy *rolloutsv1alpha1.RolloutStrategy) []*paprikav1.RolloutAnalysisCheck {
	var checks []rolloutsv1alpha1.AnalysisCheck
	if strategy.Canary != nil && strategy.Canary.Analysis != nil {
		checks = append(checks, strategy.Canary.Analysis.Checks...)
	}
	if strategy.BlueGreen != nil && strategy.BlueGreen.Analysis != nil {
		checks = append(checks, strategy.BlueGreen.Analysis.Checks...)
	}
	if strategy.ABTest != nil && strategy.ABTest.Analysis != nil {
		checks = append(checks, strategy.ABTest.Analysis.Checks...)
	}
	if strategy.Mirror != nil && strategy.Mirror.Analysis != nil {
		checks = append(checks, strategy.Mirror.Analysis.Checks...)
	}
	out := make([]*paprikav1.RolloutAnalysisCheck, 0, len(checks))
	for _, check := range checks {
		out = append(out, &paprikav1.RolloutAnalysisCheck{
			Type:             check.Type,
			Url:              check.URL,
			HttpHeaders:      copyStringMap(check.HTTPHeaders),
			SuccessThreshold: check.SuccessThreshold,
			TimeoutSeconds:   safeInt32(check.TimeoutSeconds),
			RequestCount:     safeInt32(check.RequestCount),
			Metric:           check.Metric,
			Threshold:        check.Threshold,
			WindowSeconds:    safeInt32(check.WindowSeconds),
		})
	}
	return out
}

func convertRolloutABRoutes(in *rolloutsv1alpha1.ABTestStrategy) []*paprikav1.RolloutABRoute {
	if in == nil {
		return nil
	}
	out := make([]*paprikav1.RolloutABRoute, 0, len(in.Routes))
	for _, route := range in.Routes {
		out = append(out, &paprikav1.RolloutABRoute{
			Type:    route.Type,
			Name:    route.Name,
			Value:   route.Value,
			Service: route.Service,
		})
	}
	return out
}

func rolloutMirrorPercent(in *rolloutsv1alpha1.MirrorStrategy) int32 {
	if in == nil {
		return 0
	}
	return in.MirrorPercent
}

func rolloutAutoPromotionSeconds(in *rolloutsv1alpha1.BlueGreenStrategy) int32 {
	if in == nil || in.AutoPromotionSeconds == nil {
		return 0
	}
	return *in.AutoPromotionSeconds
}

func rolloutScaleDownDelaySeconds(in *rolloutsv1alpha1.BlueGreenStrategy) int32 {
	if in == nil || in.ScaleDownDelaySeconds == nil {
		return 0
	}
	return *in.ScaleDownDelaySeconds
}

// convertArtifactToArtifactRef maps a pipelines Artifact CR to the protobuf
// ArtifactRef. When cm is non-nil the configmap resolved key is used to build
// the resolved reference; otherwise the reference omits the key.
func convertArtifactToArtifactRef(a *pipelinesv1alpha1.Artifact, cm *corev1.ConfigMap) *paprikav1.ArtifactRef {
	phase, failedReason := artifactPhaseAndReason(a)
	return &paprikav1.ArtifactRef{
		Name:              a.Name,
		Path:              artifactPath(a),
		Kind:              a.Spec.Type,
		Reference:         a.Spec.Reference,
		ResolvedReference: artifactResolvedReference(a, cm),
		Digest:            artifactDigest(a),
		Phase:             phase,
		ProducingStep:     a.Spec.Provenance.Step,
		CreatedAt:         a.CreationTimestamp.Unix(),
		FailedReason:      failedReason,
	}
}

// artifactPath reconstructs the declared artifact path as "<type>://<reference>".
func artifactPath(a *pipelinesv1alpha1.Artifact) string {
	if a.Spec.Type == "" || a.Spec.Reference == "" {
		return ""
	}
	return a.Spec.Type + "://" + a.Spec.Reference
}

// artifactResolvedReference builds a best-effort resolved reference per the
// CRD-to-protobuf mapping: configmap references include the resolved key when a
// ConfigMap is available; oci references append the resolved digest when present.
func artifactResolvedReference(a *pipelinesv1alpha1.Artifact, cm *corev1.ConfigMap) string {
	switch a.Spec.Type {
	case "configmap":
		name, key, err := pipelines.ParseConfigMapReference(a.Spec.Reference)
		if err != nil {
			return ""
		}
		resolvedKey := key
		if cm != nil {
			if rk, err := pipelines.ResolveConfigMapKey(cm, key); err == nil {
				resolvedKey = rk
			}
		}
		ref := "configmap://" + a.Namespace + "/" + name
		if resolvedKey != "" {
			ref += "/" + resolvedKey
		}
		return ref
	case "oci":
		ref := "oci://" + a.Spec.Reference
		if a.Status.ResolvedDigest != "" {
			ref += "@" + a.Status.ResolvedDigest
		}
		return ref
	default:
		return ""
	}
}

// artifactDigest prefers the controller-resolved digest and falls back to the
// digest declared in the artifact spec.
func artifactDigest(a *pipelinesv1alpha1.Artifact) string {
	if a.Status.ResolvedDigest != "" {
		return a.Status.ResolvedDigest
	}
	return a.Spec.Digest
}

// artifactPhaseAndReason derives the lifecycle phase from the Ready condition.
// When the condition is False the artifact is Failed and the condition Reason
// is surfaced as the failure reason.
func artifactPhaseAndReason(a *pipelinesv1alpha1.Artifact) (phase, reason string) {
	for _, c := range a.Status.Conditions {
		if c.Type != conditionTypeReady {
			continue
		}
		switch c.Status {
		case metav1.ConditionTrue:
			return phaseReady, ""
		case metav1.ConditionFalse:
			return "Failed", c.Reason
		case metav1.ConditionUnknown:
			return "Pending", ""
		default:
			return "Pending", ""
		}
	}
	return "Pending", ""
}

// artifactDownloadURL returns a base64 JSON data URI for configmap artifacts
// when the resolved value fits within configMapDownloadLimit. It returns an
// empty string for oci artifacts or oversized configmap values.
//
// The data URI embeds a JSON object mapping the resolved ConfigMap key to its
// string value, e.g. data:application/json;base64,eyJteS1rZXkiOiJteS12YWx1ZSJ9.
// For binaryData keys, the raw bytes are re-encoded as a UTF-8 JSON string when
// valid UTF-8, otherwise as a base64 string.
func artifactDownloadURL(a *pipelinesv1alpha1.Artifact, cm *corev1.ConfigMap) string {
	if a.Spec.Type != "configmap" || cm == nil {
		return ""
	}
	_, key, err := pipelines.ParseConfigMapReference(a.Spec.Reference)
	if err != nil {
		return ""
	}
	resolvedKey, err := pipelines.ResolveConfigMapKey(cm, key)
	if err != nil {
		return ""
	}

	var jsonValue string
	var rawLen int
	if v, ok := cm.Data[resolvedKey]; ok {
		jsonValue = v
		rawLen = len(v)
	} else if raw, ok := cm.BinaryData[resolvedKey]; ok {
		rawLen = len(raw)
		if utf8.Valid(raw) {
			jsonValue = string(raw)
		} else {
			jsonValue = base64.StdEncoding.EncodeToString(raw)
		}
	} else {
		return ""
	}

	if rawLen > configMapDownloadLimit {
		return ""
	}

	data, err := json.Marshal(map[string]string{resolvedKey: jsonValue})
	if err != nil {
		return ""
	}
	return "data:application/json;base64," + base64.StdEncoding.EncodeToString(data)
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
	artifacts := make([]*paprikav1.ArtifactRef, 0, len(p.Status.ArtifactRefs))
	for i := range p.Status.ArtifactRefs {
		artifacts = append(artifacts, convertPipelineArtifactRef(&p.Status.ArtifactRefs[i]))
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
		Project:      p.GetLabels()[projectLabelKey],
	}
}

// convertPipelineArtifactRef maps a status PipelineArtifactRef to the protobuf
// ArtifactRef. PipelineArtifactRef.Reference stores the full "type://reference"
// path, so it populates both path and reference. failed_reason is not tracked at
// the pipeline-status level and is left empty.
func convertPipelineArtifactRef(ref *pipelinesv1alpha1.PipelineArtifactRef) *paprikav1.ArtifactRef {
	return &paprikav1.ArtifactRef{
		Name:              ref.Name,
		Path:              ref.Reference,
		Kind:              ref.Kind,
		Reference:         ref.Reference,
		ResolvedReference: ref.ResolvedReference,
		Digest:            ref.Digest,
		Phase:             string(ref.Phase),
		ProducingStep:     ref.ProducingStep,
		CreatedAt:         ref.CreatedAt,
	}
}

func convertRelease(r *pipelinesv1alpha1.Release) *paprikav1.Release {
	promos := make([]*paprikav1.Promotion, 0, len(r.Status.PromotionHistory))
	for _, ph := range r.Status.PromotionHistory {
		promos = append(promos, &paprikav1.Promotion{
			Stage:            ph.Stage,
			Result:           ph.Result,
			Timestamp:        ph.Timestamp.Unix(),
			ManifestSnapshot: ph.ManifestSnapshot,
		})
	}
	rel := &paprikav1.Release{
		Name:                     r.Name,
		Namespace:                r.Namespace,
		CreatedAt:                r.CreationTimestamp.Unix(),
		Pipeline:                 r.Spec.Pipeline,
		Target:                   r.Spec.Target,
		Phase:                    string(r.Status.Phase),
		CurrentStage:             r.Status.CurrentStage,
		PromotionHistory:         promos,
		Application:              r.Labels[engine.ApplicationNameLabelKey],
		RolledBackTo:             r.Status.RolledBackTo,
		ObservedGeneration:       r.Status.ObservedGeneration,
		Conditions:               convertConditions(r.Status.Conditions),
		RenderedManifestSnapshot: r.Status.RenderedManifestSnapshot,
		CanaryWeight:             safeInt32(r.Status.CanaryWeight),
		CanaryStepIndex:          safeInt32(r.Status.CanaryStepIndex),
		RolloutRef:               r.Status.RolloutRef,
		HookStatuses:             convertHookStatuses(r.Status.HookStatuses),
	}
	if r.Status.CanaryStepStartedAt != nil {
		rel.CanaryStepStartedAt = r.Status.CanaryStepStartedAt.Unix()
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

func convertHookStatuses(statuses []pipelinesv1alpha1.HookStatus) []*paprikav1.HookStatus {
	out := make([]*paprikav1.HookStatus, 0, len(statuses))
	for _, h := range statuses {
		converted := &paprikav1.HookStatus{
			Kind:      h.Kind,
			Name:      h.Name,
			Namespace: h.Namespace,
			Phase:     h.Phase,
			Status:    h.Status,
			Message:   h.Message,
		}
		if h.StartedAt != nil {
			converted.StartedAt = h.StartedAt.Unix()
		}
		if h.CompletedAt != nil {
			converted.CompletedAt = h.CompletedAt.Unix()
		}
		out = append(out, converted)
	}
	return out
}

const (
	phaseReady         = "Ready"
	conditionTypeReady = "Ready"

	pipelineAPIVersion = "pipelines.paprika.io/v1alpha1"
	pipelineKind       = "Pipeline"

	// configMapDownloadLimit bounds the raw ConfigMap value size (256 KiB) for
	// which GetArtifact populates a download_url. Larger values are served out
	// of band to avoid bloating API responses.
	configMapDownloadLimit = 256 * 1024
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

func convertConditions(conds []metav1.Condition) []*paprikav1.Condition {
	out := make([]*paprikav1.Condition, 0, len(conds))
	for _, c := range conds {
		out = append(out, &paprikav1.Condition{
			Type:               c.Type,
			Status:             string(c.Status),
			ObservedGeneration: c.ObservedGeneration,
			LastTransitionTime: c.LastTransitionTime.Format(time.RFC3339),
			Reason:             c.Reason,
			Message:            c.Message,
		})
	}
	return out
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
		if a.Spec.Source.OCI != nil {
			source.Oci = &paprikav1.OCISource{
				Url:       a.Spec.Source.OCI.URL,
				Tag:       a.Spec.Source.OCI.Tag,
				Insecure:  a.Spec.Source.OCI.Insecure,
				SecretRef: a.Spec.Source.OCI.SecretRef,
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
		Gates:           convertGateStatuses(a.Status.Gates),
		Conditions:      convertConditions(a.Status.Conditions),
		AnalysisResults: convertAnalysisResults(a.Status.AnalysisResults),
	}
}

func convertGateStatuses(statuses []pipelinesv1alpha1.GateStatus) []*paprikav1.GateStatus {
	out := make([]*paprikav1.GateStatus, 0, len(statuses))
	for i := range statuses {
		s := &statuses[i]
		out = append(out, &paprikav1.GateStatus{
			Name:       s.Name,
			Stage:      s.Stage,
			Type:       s.Type,
			Status:     s.Status,
			ApprovedBy: s.ApprovedBy,
			Message:    s.Message,
		})
	}
	return out
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

func convertAnalysisResults(results []pipelinesv1alpha1.AnalysisResult) []*paprikav1.AnalysisResult {
	out := make([]*paprikav1.AnalysisResult, 0, len(results))
	for _, r := range results {
		checkedAt := ""
		if r.CheckedAt != nil {
			checkedAt = r.CheckedAt.Format(time.RFC3339)
		}
		out = append(out, &paprikav1.AnalysisResult{
			Name:      r.Name,
			Phase:     string(r.Phase),
			Passed:    r.Passed,
			Message:   r.Message,
			CheckedAt: checkedAt,
		})
	}
	return out
}

func convertAnalysisRun(run *pipelinesv1alpha1.AnalysisRun) *paprikav1.AnalysisRun {
	out := &paprikav1.AnalysisRun{
		Name:               run.Name,
		Namespace:          run.Namespace,
		TemplateRef:        run.Spec.TemplateRef,
		ApplicationRef:     run.Spec.ApplicationRef,
		Args:               run.Spec.Args,
		Phase:              string(run.Status.Phase),
		CyclesExecuted:     safeInt32(run.Status.CyclesExecuted),
		ObservedGeneration: run.Status.ObservedGeneration,
		Results:            convertAnalysisRunResults(run.Status.Results),
		Conditions:         convertConditions(run.Status.Conditions),
	}
	if run.Status.StartedAt != nil {
		out.StartedAt = run.Status.StartedAt.Unix()
	}
	if run.Status.CompletedAt != nil {
		out.CompletedAt = run.Status.CompletedAt.Unix()
	}
	return out
}

func convertAnalysisRunResults(results []pipelinesv1alpha1.AnalysisRunResult) []*paprikav1.AnalysisRunResult {
	out := make([]*paprikav1.AnalysisRunResult, 0, len(results))
	for _, r := range results {
		checkedAt := ""
		if r.CheckedAt != nil {
			checkedAt = r.CheckedAt.Format(time.RFC3339)
		}
		out = append(out, &paprikav1.AnalysisRunResult{
			Name:      r.Name,
			Passed:    r.Passed,
			Message:   r.Message,
			Detail:    r.Detail,
			CheckedAt: checkedAt,
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
