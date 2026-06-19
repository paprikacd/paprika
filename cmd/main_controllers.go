/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"context"
	"fmt"
	"net/http"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	k8sevents "k8s.io/client-go/tools/events"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/analysis"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/clock"
	clusterscontroller "github.com/benebsworth/paprika/internal/controller/clusters"
	corecontroller "github.com/benebsworth/paprika/internal/controller/core"
	controller "github.com/benebsworth/paprika/internal/controller/pipelines"
	policycontroller "github.com/benebsworth/paprika/internal/controller/policy"
	rolloutscontroller "github.com/benebsworth/paprika/internal/controller/rollouts"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/gates"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/health"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/ratelimit"
	reposerverclient "github.com/benebsworth/paprika/internal/reposerverclient"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/internal/syncwindow"
	"github.com/benebsworth/paprika/internal/traffic"
	webhookcorev1alpha1 "github.com/benebsworth/paprika/internal/webhook/core/v1alpha1"
	webhookpipelinesv1alpha1 "github.com/benebsworth/paprika/internal/webhook/pipelines/v1alpha1"
	webhookpolicyv1alpha1 "github.com/benebsworth/paprika/internal/webhook/policy/v1alpha1"
	webhookrollouts "github.com/benebsworth/paprika/internal/webhook/rollouts/v1alpha1"
)

// legacyEventRecorderAdapter bridges the new k8sevents.EventRecorder API to the
// legacy record.EventRecorder interface used by existing reconcilers.
// TODO(GBP-030): migrate reconcilers to k8sevents.EventRecorder and remove this adapter.
type legacyEventRecorderAdapter struct {
	rec k8sevents.EventRecorder
}

func newLegacyEventRecorder(rec k8sevents.EventRecorder) record.EventRecorder {
	return &legacyEventRecorderAdapter{rec: rec}
}

func (a *legacyEventRecorderAdapter) Event(object runtime.Object, eventtype, reason, message string) {
	a.rec.Eventf(object, nil, eventtype, reason, reason, "%s", message)
}

func (a *legacyEventRecorderAdapter) Eventf(object runtime.Object, eventtype, reason, messageFmt string, args ...interface{}) {
	a.rec.Eventf(object, nil, eventtype, reason, reason, messageFmt, args...)
}

func (a *legacyEventRecorderAdapter) AnnotatedEventf(object runtime.Object, annotations map[string]string, eventtype, reason, messageFmt string, args ...interface{}) {
	_ = annotations
	a.rec.Eventf(object, nil, eventtype, reason, reason, messageFmt, args...)
}

// manifestCache is the smallest cache surface needed by controllers that render
// templates through the cached renderer.
type manifestCache interface {
	cache.Getter
	cache.Setter
}

func setupOperatorControllers(ctx context.Context, mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, deps *operatorDependencies, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, rateLimiter *ratelimit.ControllerRateLimit, enableWebhooks bool) error {
	if err := registerProjectLabelIndexers(ctx, mgr); err != nil {
		return fmt.Errorf("register project label indexers: %w", err)
	}

	if err := setupPipelineControllers(ctx, mgr, k8sClient, operatorNamespace, deps, projectValidator, policyEvaluator, rateLimiter); err != nil {
		return fmt.Errorf("setup pipeline controllers: %w", err)
	}

	if err := setupNotificationController(mgr, deps.broker); err != nil {
		return fmt.Errorf("setup notification controller: %w", err)
	}

	if err := setupWebhooks(mgr, enableWebhooks); err != nil {
		return fmt.Errorf("setup webhooks: %w", err)
	}

	if err := setupCoreControllers(mgr); err != nil {
		return fmt.Errorf("setup core controllers: %w", err)
	}
	// +kubebuilder:scaffold:builder

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return fmt.Errorf("failed to set up health check: %w", err)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return fmt.Errorf("failed to set up ready check: %w", err)
	}
	return nil
}

func setupPipelineControllers(ctx context.Context, mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, deps *operatorDependencies, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, rateLimiter *ratelimit.ControllerRateLimit) error {
	controllers := []struct {
		name  string
		setup func() error
	}{
		{"analysisrun", func() error { return setupAnalysisRunController(mgr, k8sClient, operatorNamespace, deps.broker) }},
		{"pipeline", func() error { return setupPipelineController(mgr, k8sClient, operatorNamespace, deps.shardFilter) }},
		{"stage", func() error { return setupStageController(mgr, deps.shardFilter) }},
		{"release", func() error {
			return setupReleaseController(ctx, mgr, k8sClient, operatorNamespace, deps.cache, deps.shardFilter, rateLimiter, projectValidator, policyEvaluator, deps.broker, deps.telemetry, deps.repoServerAddr)
		}},
		{"rollout", func() error {
			return setupRolloutController(mgr, k8sClient, operatorNamespace, deps.shardFilter, rateLimiter, projectValidator, policyEvaluator, deps.broker)
		}},
		{"template", func() error { return setupTemplateController(mgr, deps.shardFilter) }},
		{"applicationset", func() error { return setupApplicationSetController(mgr, deps.shardFilter) }},
		{"artifact", func() error { return setupArtifactController(mgr, deps.shardFilter) }},
		{"application", func() error {
			return setupApplicationController(ctx, mgr, k8sClient, operatorNamespace, deps.cache, deps.shardFilter, rateLimiter, projectValidator, deps.broker, deps.telemetry, deps.repoServerAddr)
		}},
	}

	for _, c := range controllers {
		if err := c.setup(); err != nil {
			return fmt.Errorf("failed to create controller %s: %w", c.name, err)
		}
	}
	return nil
}

func setupNotificationController(mgr ctrl.Manager, broker *events.Broker) error {
	if err := controller.NewNotificationConfigReconciler(nil, broker, controller.NewNotificationSender(), nil, clock.Real{}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("failed to create controller notification: %w", err)
	}
	return nil
}

func setupPipelineController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, shardFilter *sharding.Filter) error {
	if err := (&controller.PipelineReconciler{
		Scheme:    mgr.GetScheme(),
		K8sClient: k8sClient, Namespace: operatorNamespace,
		WorkflowEngine: engine.NewWorkflowEngine(k8sClient, operatorNamespace),
		ShardFilter:    shardFilter,
		Clock:          clock.Real{},
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up pipeline controller: %w", err)
	}
	return nil
}

func setupStageController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.StageReconciler{
		Scheme:      mgr.GetScheme(),
		ShardFilter: shardFilter,
		Clock:       clock.Real{},
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up stage controller: %w", err)
	}
	return nil
}

func newTrafficRouter(cfg *pipelinesv1alpha1.TrafficRouter, client dynamic.Interface, stableSvc, canarySvc, ns string) (traffic.WeightRouter, error) {
	router, err := traffic.NewRouter(cfg, client, stableSvc, canarySvc, ns)
	if err != nil {
		return nil, fmt.Errorf("create traffic router: %w", err)
	}
	return router, nil
}

func newDynamicClientForManager(mgr ctrl.Manager) (dynamic.Interface, error) {
	dc, err := dynamic.NewForConfig(mgr.GetConfig())
	if err != nil {
		return nil, fmt.Errorf("create dynamic client: %w", err)
	}
	return dc, nil
}

func newTemplateRenderer(ctx context.Context, mgr ctrl.Manager, cacheClient manifestCache, workDir, repoServerAddr string) *engine.RepoServerRenderer {
	_ = ctx // reserved for future cancellation/observability
	base := engine.NewHelmSDKRendererWithClient(workDir, mgr.GetClient())
	cached := engine.NewCachedTemplateRenderer(base, cacheClient, workDir, 0)
	return engine.NewRepoServerRenderer(reposerverclient.New(repoServerAddr), cached)
}

func clientsetFromInterface(k8sClient kubernetes.Interface) (*kubernetes.Clientset, error) {
	cs, ok := k8sClient.(*kubernetes.Clientset)
	if !ok {
		return nil, fmt.Errorf("expected *kubernetes.Clientset, got %T", k8sClient)
	}
	return cs, nil
}

func setupReleaseController(ctx context.Context, mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, cacheClient manifestCache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, broker *events.Broker, telemetry *observability.Telemetry, repoServerAddr string) error {
	dynamicClient, err := newDynamicClientForManager(mgr)
	if err != nil {
		return fmt.Errorf("create dynamic client for release controller: %w", err)
	}
	renderer := newTemplateRenderer(ctx, mgr, cacheClient, "/tmp/paprika-helm", repoServerAddr)
	clusterMgr := controller.NewClusterConnectionPoolWithContext(ctx, mgr.GetClient(), mgr.GetConfig())
	clusterMgr.Clock = clock.Real{}
	releaseRec := controller.NewReleaseReconciler(mgr.GetClient())
	releaseRec.Scheme = mgr.GetScheme()
	releaseRec.K8sClient = k8sClient
	releaseRec.Namespace = operatorNamespace
	releaseRec.DynamicClient = dynamicClient
	releaseRec.RestConfig = mgr.GetConfig()
	releaseRec.ClusterMgr = clusterMgr
	releaseRec.Clock = clock.Real{}
	releaseRec.GateExecutor = gates.NewSmokeGate(http.DefaultClient)
	releaseRec.Analyzer = analysis.NewCELAnalyzer(k8sClient, operatorNamespace, mgr.GetConfig(), http.DefaultClient)
	releaseRec.TemplateRenderer = renderer
	releaseRec.TrafficRouterFactory = newTrafficRouter
	releaseRec.ShardFilter = shardFilter
	releaseRec.RateLimiter = rateLimiter
	releaseRec.EventRecorder = newLegacyEventRecorder(mgr.GetEventRecorder("release-controller"))
	releaseRec.ProjectValidator = projectValidator
	releaseRec.PolicyEvaluator = policyEvaluator
	releaseRec.EventBroker = broker
	releaseRec.Telemetry = telemetry
	if err := releaseRec.SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up release controller: %w", err)
	}
	return nil
}

func setupRolloutController(mgr ctrl.Manager, k8sClient kubernetes.Interface, _ string, shardFilter *sharding.Filter, _ *ratelimit.ControllerRateLimit, _ *governance.ProjectValidator, _ *governance.PolicyEvaluator, _ *events.Broker) error {
	_ = shardFilter // rollouts inherit the namespace of their parent Release; sharding is applied there.
	dynamicClient, err := newDynamicClientForManager(mgr)
	if err != nil {
		return fmt.Errorf("create dynamic client for rollout controller: %w", err)
	}
	if err := (&rolloutscontroller.RolloutReconciler{
		Scheme:        mgr.GetScheme(),
		DynamicClient: dynamicClient,
		Analyzer:      analysis.NewCELAnalyzer(k8sClient, "paprika-system", mgr.GetConfig(), http.DefaultClient),
		EventRecorder: newLegacyEventRecorder(mgr.GetEventRecorder("rollout-controller")),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up rollout controller: %w", err)
	}
	return nil
}

func setupTemplateController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.TemplateReconciler{
		Scheme:      mgr.GetScheme(),
		ShardFilter: shardFilter,
		Clock:       clock.Real{},
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up template controller: %w", err)
	}
	return nil
}

func setupArtifactController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.ArtifactReconciler{
		Scheme:      mgr.GetScheme(),
		ShardFilter: shardFilter,
		Clock:       clock.Real{},
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up artifact controller: %w", err)
	}
	return nil
}

func setupApplicationSetController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.ApplicationSetReconciler{
		Scheme:      mgr.GetScheme(),
		ShardFilter: shardFilter,
		Clock:       clock.Real{},
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up applicationset controller: %w", err)
	}
	return nil
}

func setupAnalysisRunController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, broker *events.Broker) error {
	if err := (&controller.AnalysisRunReconciler{
		Scheme:        mgr.GetScheme(),
		Analyzer:      analysis.NewCELAnalyzer(k8sClient, operatorNamespace, mgr.GetConfig(), http.DefaultClient),
		EventRecorder: newLegacyEventRecorder(mgr.GetEventRecorder("analysisrun-controller")),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up analysisrun controller: %w", err)
	}
	return nil
}

func setupApplicationController(ctx context.Context, mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, cacheClient manifestCache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator, broker *events.Broker, telemetry *observability.Telemetry, repoServerAddr string) error {
	dynClient, err := newDynamicClientForManager(mgr)
	if err != nil {
		return fmt.Errorf("create dynamic client for application controller: %w", err)
	}
	k8sClientset, err := clientsetFromInterface(k8sClient)
	if err != nil {
		return fmt.Errorf("create kubernetes clientset for application controller: %w", err)
	}
	renderer := newTemplateRenderer(ctx, mgr, cacheClient, "/tmp/paprika-sources", repoServerAddr)
	diffEngine := engine.NewScalableDiffEngine(dynClient)
	appClusterMgr := controller.NewClusterConnectionPoolWithContext(ctx, mgr.GetClient(), mgr.GetConfig())
	appClusterMgr.Clock = clock.Real{}
	if err := mgr.Add(manager.RunnableFunc(func(stopCtx context.Context) error {
		<-stopCtx.Done()
		diffEngine.Stop()
		return nil
	})); err != nil {
		return fmt.Errorf("register diff engine shutdown: %w", err)
	}
	appRec := controller.NewApplicationReconciler(mgr.GetClient())
	appRec.Scheme = mgr.GetScheme()
	appRec.K8sClient = k8sClientset
	appRec.Namespace = operatorNamespace
	appRec.RestConfig = mgr.GetConfig()
	appRec.WorkDir = "/tmp/paprika-sources"
	appRec.HealthEval = health.NewCELEvaluator()
	appRec.DiffEngine = diffEngine
	appRec.ResHealth = health.NewResourceHealthChecker(mgr.GetClient())
	appRec.ClusterMgr = appClusterMgr
	appRec.TemplateRenderer = renderer
	appRec.ShardFilter = shardFilter
	appRec.RateLimiter = rateLimiter
	appRec.EventRecorder = newLegacyEventRecorder(mgr.GetEventRecorder("application-controller"))
	appRec.ProjectValidator = projectValidator
	appRec.EventBroker = broker
	appRec.SyncWindowEvaluator = syncwindow.NewEvaluator()
	appRec.Telemetry = telemetry
	appRec.Clock = clock.Real{}
	if err := appRec.SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up application controller: %w", err)
	}
	return nil
}

func setupWebhooks(mgr ctrl.Manager, enableWebhooks bool) error {
	if !enableWebhooks {
		return nil
	}
	// +kubebuilder:scaffold:webhook
	webhooks := []struct {
		name string
		fn   func(ctrl.Manager) error
	}{
		{"Pipeline", webhookpipelinesv1alpha1.SetupPipelineWebhookWithManager},
		{"Stage", webhookpipelinesv1alpha1.SetupStageWebhookWithManager},
		{"Release", webhookpipelinesv1alpha1.SetupReleaseWebhookWithManager},
		{"Template", webhookpipelinesv1alpha1.SetupTemplateWebhookWithManager},
		{"Application", webhookpipelinesv1alpha1.SetupApplicationWebhookWithManager},
		{"AppProject", webhookcorev1alpha1.SetupAppProjectWebhookWithManager},
		{"Repository", webhookcorev1alpha1.SetupRepositoryWebhookWithManager},
		{"Policy", webhookpolicyv1alpha1.SetupPolicyWebhookWithManager},
		{"Rollout", webhookrollouts.SetupRolloutWebhookWithManager},
	}
	for _, w := range webhooks {
		if err := w.fn(mgr); err != nil {
			return fmt.Errorf("failed to create webhook %s: %w", w.name, err)
		}
	}
	return nil
}

type coreController interface {
	SetupWithManager(ctrl.Manager) error
}

func setupCoreControllers(mgr ctrl.Manager) error {
	controllers := []struct {
		name string
		rec  coreController
	}{
		{"clusters-cluster", &clusterscontroller.ClusterReconciler{Scheme: mgr.GetScheme()}},
		{"core-appproject", &corecontroller.AppProjectReconciler{Scheme: mgr.GetScheme()}},
		{"core-repository", &corecontroller.RepositoryReconciler{Scheme: mgr.GetScheme()}},
		{"policy-policy", &policycontroller.PolicyReconciler{Scheme: mgr.GetScheme()}},
	}
	for _, c := range controllers {
		if err := c.rec.SetupWithManager(mgr); err != nil {
			return fmt.Errorf("failed to create controller %s: %w", c.name, err)
		}
	}
	return nil
}

func registerProjectLabelIndexers(ctx context.Context, mgr ctrl.Manager) error {
	indexer := mgr.GetFieldIndexer()
	types := []client.Object{
		&pipelinesv1alpha1.Release{},
		&pipelinesv1alpha1.Stage{},
		&pipelinesv1alpha1.Pipeline{},
		&pipelinesv1alpha1.Template{},
	}
	for _, t := range types {
		if err := indexer.IndexField(ctx, t, "projectLabel", func(obj client.Object) []string {
			return []string{obj.GetLabels()["app.paprika.io/project"]}
		}); err != nil {
			return fmt.Errorf("index project label for %T: %w", t, err)
		}
	}
	return nil
}
