package controller

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	logr "github.com/go-logr/logr"
	"go.opentelemetry.io/otel/attribute"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/benebsworth/paprika/analysis"
	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/gates"
	agentclient "github.com/benebsworth/paprika/internal/agent/client"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/ratelimit"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/metrics"
	"github.com/benebsworth/paprika/traffic"
)

const releaseFinalizer = "paprika.io/release-cleanup"

var managedGVRs = []schema.GroupVersionResource{
	{Group: "apps", Version: "v1", Resource: "deployments"},
	{Group: "", Version: "v1", Resource: "services"},
	{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
}

var knownGVRs = map[string]schema.GroupVersionResource{
	"Deployment":            {Group: "apps", Version: "v1", Resource: "deployments"},
	"Service":               {Group: "", Version: "v1", Resource: "services"},
	"Ingress":               {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
	"ConfigMap":             {Group: "", Version: "v1", Resource: "configmaps"},
	"Secret":                {Group: "", Version: "v1", Resource: "secrets"},
	"Namespace":             {Group: "", Version: "v1", Resource: "namespaces"},
	"Job":                   {Group: "batch", Version: "v1", Resource: "jobs"},
	"Pod":                   {Group: "", Version: "v1", Resource: "pods"},
	"ServiceAccount":        {Group: "", Version: "v1", Resource: "serviceaccounts"},
	"ClusterRole":           {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
	"ClusterRoleBinding":    {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
	"Role":                  {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
	"RoleBinding":           {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
	"PersistentVolumeClaim": {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
}

// TrafficRouterFactory creates a traffic router for the given configuration.
type TrafficRouterFactory func(cfg *paprikav1.TrafficRouter, client dynamic.Interface, stableSvc, canarySvc, ns string) (traffic.Router, error)

// ReleaseReconciler reconciles Release resources.
type ReleaseReconciler struct {
	client.Client
	Scheme               *runtime.Scheme
	K8sClient            kubernetes.Interface
	Namespace            string
	RestConfig           *rest.Config
	ClusterMgr           ClusterClientManager
	DynamicClient        dynamic.Interface
	GateExecutor         gates.GateExecutor
	Analyzer             analysis.Analyzer
	TemplateRenderer     engine.TemplateRenderer
	TrafficRouterFactory TrafficRouterFactory
	ShardFilter          *sharding.Filter
	RateLimiter          *ratelimit.ControllerRateLimit
	AgentClientBuilder   func(baseURL string) AgentClient
}

// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=ingresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.istio.io,resources=virtualservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch

// Reconcile handles Release reconciliation.
func (r *ReleaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	ctx, span := observability.StartSpan(ctx, "ReleaseReconcile",
		attribute.String("namespace", req.Namespace),
		attribute.String("name", req.Name),
	)
	defer span.End()

	result := resultSuccess
	start := metrics.Timer()
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("release", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("release").Observe(metrics.Since(start))
	}()

	logger := logf.FromContext(ctx)
	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		logger.Info("Skipping release not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	if r.RateLimiter != nil {
		if !r.RateLimiter.AllowGlobal() {
			logger.Info("Global rate limit exceeded, requeueing", "release", req.Name)
			return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
		}
		if !r.RateLimiter.AllowApp(ratelimit.ReconcileKey(req.Namespace, req.Name)) {
			logger.Info("Per-application rate limit exceeded, requeueing", "release", req.Name)
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
	}

	release, getErr := r.getRelease(ctx, req)
	if getErr != nil {
		result = resultError
		return ctrl.Result{}, getErr
	}

	if !release.DeletionTimestamp.IsZero() {
		return r.handleReleaseDeletion(ctx, &release)
	}

	if !controllerutil.ContainsFinalizer(&release, releaseFinalizer) {
		if err := r.ensureReleaseFinalizer(ctx, &release); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	return r.reconcileReleasePhase(ctx, req, &release, start, &result)
}

func (r *ReleaseReconciler) reconcileReleasePhase(ctx context.Context, req ctrl.Request, release *paprikav1.Release, start time.Time, result *string) (ctrl.Result, error) {
	if r.isReleaseTerminal(release) {
		return ctrl.Result{}, nil
	}

	if release.Status.Phase == paprikav1.ReleasePending {
		return r.handlePendingPhase(ctx, release, result)
	}

	if err := r.checkConcurrentRelease(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, err
	}

	if release.Status.Phase == "" {
		return r.initiateRelease(ctx, release, req.Namespace, result)
	}

	if release.Status.Phase == paprikav1.ReleasePromoting {
		return r.handlePromotingPhase(ctx, release, result)
	}

	if release.Status.Phase == paprikav1.ReleaseCanarying {
		return r.reconcileCanary(ctx, release, start, result)
	}

	if release.Status.Phase == paprikav1.ReleaseVerifying {
		return r.handleVerifyingPhase(ctx, release, result)
	}

	if r.shouldRollback(release) {
		return r.handleFailedRollback(ctx, release, result)
	}

	return ctrl.Result{}, nil
}

func (r *ReleaseReconciler) getRelease(ctx context.Context, req ctrl.Request) (paprikav1.Release, error) {
	var release paprikav1.Release
	if err := r.Get(ctx, req.NamespacedName, &release); err != nil {
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			return release, fmt.Errorf("getting release: %w", k8sErr)
		}
		return release, nil
	}
	return release, nil
}

func (r *ReleaseReconciler) ensureReleaseFinalizer(ctx context.Context, release *paprikav1.Release) error {
	if controllerutil.ContainsFinalizer(release, releaseFinalizer) {
		return nil
	}
	controllerutil.AddFinalizer(release, releaseFinalizer)
	if err := r.Update(ctx, release); err != nil {
		return fmt.Errorf("adding release finalizer: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) handleReleaseDeletion(ctx context.Context, release *paprikav1.Release) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(release, releaseFinalizer) {
		return ctrl.Result{}, nil
	}
	if err := r.cleanup(ctx, release); err != nil {
		return ctrl.Result{}, fmt.Errorf("cleaning up release: %w", err)
	}
	controllerutil.RemoveFinalizer(release, releaseFinalizer)
	if err := r.Update(ctx, release); err != nil {
		return ctrl.Result{}, fmt.Errorf("removing release finalizer: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *ReleaseReconciler) isReleaseTerminal(release *paprikav1.Release) bool {
	return release.Status.Phase == paprikav1.ReleaseComplete ||
		release.Status.Phase == paprikav1.ReleaseFailed ||
		release.Status.Phase == paprikav1.ReleaseRolledBack ||
		release.Status.Phase == paprikav1.ReleaseSuperseded
}

func (r *ReleaseReconciler) hasCanarySteps(stage *paprikav1.Stage) bool {
	return stage.Spec.Canary != nil && len(stage.Spec.Canary.Steps) > 0
}

func (r *ReleaseReconciler) transitionToVerifying(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	release.Status.Phase = paprikav1.ReleaseVerifying
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to transition to verifying: %w", err)
	}
	return ctrl.Result{Requeue: true}, nil
}

func (r *ReleaseReconciler) getCanaryInterval(canaryCfg *paprikav1.CanaryConfig) time.Duration {
	if canaryCfg.IntervalSeconds > 0 {
		return time.Duration(canaryCfg.IntervalSeconds) * time.Second
	}
	return 30 * time.Second
}

func (r *ReleaseReconciler) shouldRollback(release *paprikav1.Release) bool {
	return release.Status.Phase == paprikav1.ReleaseFailed &&
		release.Spec.OnFailure != nil &&
		release.Spec.OnFailure.Action == "rollback"
}

func (r *ReleaseReconciler) handlePendingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	if hasActiveConcurrent, _ := r.hasActiveConcurrentRelease(ctx, release); hasActiveConcurrent {
		return ctrl.Result{}, nil
	}
	release.Status.Phase = paprikav1.ReleasePromoting
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Promoting").Inc()
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		return ctrl.Result{}, fmt.Errorf("failed to transition from pending to promoting: %w", err)
	}
	return ctrl.Result{Requeue: true}, nil
}

func (r *ReleaseReconciler) initiateRelease(ctx context.Context, release *paprikav1.Release, namespace string, result *string) (ctrl.Result, error) {
	var stage paprikav1.Stage
	if err := r.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: namespace}, &stage); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("target stage %q not found: %w", release.Spec.Target, err)
	}

	release.Status.Phase = paprikav1.ReleasePromoting
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Promoting").Inc()
	release.Status.CurrentStage = release.Spec.Target
	release.Status.PromotionHistory = append(release.Status.PromotionHistory, paprikav1.PromotionEntry{
		Stage:     release.Spec.Target,
		Result:    "Pending",
		Timestamp: metav1.Now(),
	})
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to set release promoting: %w", err)
	}
	return ctrl.Result{Requeue: true}, nil
}

func (r *ReleaseReconciler) handlePromotingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	if err := r.promote(ctx, release); err != nil {
		log.Error(err, "Promotion failed", "release", release.Name)
		release.Status.Phase = paprikav1.ReleaseFailed
		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
		if updateErr := r.patchReleaseStatus(ctx, release); updateErr != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", updateErr)
		}
		return ctrl.Result{}, nil
	}

	var stage paprikav1.Stage
	if err := r.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: release.Namespace}, &stage); err != nil {
		release.Status.Phase = paprikav1.ReleaseVerifying
		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
	} else if stage.Spec.Canary != nil && len(stage.Spec.Canary.Steps) > 0 {
		release.Status.Phase = paprikav1.ReleaseCanarying
		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Canarying").Inc()
		release.Status.CanaryStepIndex = 0
		if len(stage.Spec.Canary.Steps) > 0 {
			release.Status.CanaryWeight = stage.Spec.Canary.Steps[0]
		}
	} else {
		release.Status.Phase = paprikav1.ReleaseVerifying
		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
	}
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to update release phase: %w", err)
	}
	return ctrl.Result{Requeue: true}, nil
}

func (r *ReleaseReconciler) handleVerifyingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	if r.verify(ctx, release) {
		return r.completeRelease(ctx, release, result)
	}
	return r.failRelease(ctx, release, result)
}

func (r *ReleaseReconciler) completeRelease(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	release.Status.Phase = paprikav1.ReleaseComplete
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Complete").Inc()
	if len(release.Status.PromotionHistory) > 0 {
		release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "Passed"
	}
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to set release complete: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *ReleaseReconciler) failRelease(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	release.Status.Phase = paprikav1.ReleaseFailed
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
	if len(release.Status.PromotionHistory) > 0 {
		release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "Failed"
	}
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *ReleaseReconciler) handleFailedRollback(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
	if err := r.rollback(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("rollback failed: %w", err)
	}
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "RolledBack").Inc()
	return ctrl.Result{}, nil
}

func (r *ReleaseReconciler) patchReleaseStatus(ctx context.Context, release *paprikav1.Release) error {
	patch := client.MergeFromWithOptions(release.DeepCopy(), client.MergeFromWithOptimisticLock{})
	release.Status.ObservedGeneration = release.Generation
	return r.Status().Patch(ctx, release, patch) //nolint:wrapcheck // wrapped by callers
}

func (r *ReleaseReconciler) hasActiveConcurrentRelease(ctx context.Context, release *paprikav1.Release) (bool, error) {
	var releaseList paprikav1.ReleaseList
	if err := r.List(ctx, &releaseList, client.InNamespace(release.Namespace)); err != nil {
		return false, fmt.Errorf("listing releases: %w", err)
	}

	for i := range releaseList.Items {
		other := &releaseList.Items[i]
		if other.Name == release.Name {
			continue
		}
		if other.Spec.Target == release.Spec.Target &&
			(other.Status.Phase == paprikav1.ReleasePromoting ||
				other.Status.Phase == paprikav1.ReleaseVerifying) {
			return true, nil
		}
	}
	return false, nil
}

func (r *ReleaseReconciler) checkConcurrentRelease(ctx context.Context, release *paprikav1.Release) error {
	hasActive, err := r.hasActiveConcurrentRelease(ctx, release)
	if err != nil {
		return err
	}
	if hasActive && release.Status.Phase == "" {
		release.Status.Phase = paprikav1.ReleasePending
		if err := r.patchReleaseStatus(ctx, release); err != nil {
			return fmt.Errorf("failed to set release pending: %w", err)
		}
	}
	return nil
}

func (r *ReleaseReconciler) promote(ctx context.Context, release *paprikav1.Release) error {
	log := logf.FromContext(ctx)

	stage, templates, err := r.fetchStageAndTemplates(ctx, release)
	if err != nil {
		return err
	}

	params := r.buildPromoteParams(release)

	manifests, err := r.TemplateRenderer.RenderAll(ctx, templates, params)
	if err != nil {
		return fmt.Errorf("template rendering failed: %w", err)
	}

	snapshotName := stage.Name + "-manifest-snapshot"
	if err = r.storeManifestSnapshot(ctx, release, stage, snapshotName, manifests); err != nil {
		return fmt.Errorf("failed to store manifest snapshot: %w", err)
	}

	release.Status.RenderedManifestSnapshot = snapshotName

	if err := r.applyPromotedManifests(ctx, release, stage, manifests); err != nil {
		return err
	}
	log.Info("Applied rendered manifests to cluster", "stage", stage.Name, "bytes", len(manifests))

	log.Info("Promotion rendered manifests", "stage", stage.Name, "bytes", len(manifests))
	return nil
}

func (r *ReleaseReconciler) applyManifests(ctx context.Context, manifests []byte, namespace, kubeconfigSecret, appName string) error {
	log := logf.FromContext(ctx)

	dynClient, err := r.resolveDynamicClient(ctx, kubeconfigSecret, namespace)
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}

	docs := engine.SplitYAMLDocuments(manifests)
	applied := r.applyAllDocuments(ctx, log, dynClient, docs, namespace, appName)
	log.Info("Successfully applied manifests", "count", applied)
	return nil
}

func (r *ReleaseReconciler) fetchStageAndTemplates(ctx context.Context, release *paprikav1.Release) (*paprikav1.Stage, []paprikav1.Template, error) {
	var stage paprikav1.Stage
	if err := r.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: release.Namespace}, &stage); err != nil {
		return nil, nil, fmt.Errorf("failed to fetch stage %q: %w", release.Spec.Target, err)
	}

	var templates []paprikav1.Template
	for _, tmplName := range stage.Spec.Templates {
		var tmpl paprikav1.Template
		if err := r.Get(ctx, types.NamespacedName{Name: tmplName, Namespace: release.Namespace}, &tmpl); err != nil {
			return nil, nil, fmt.Errorf("failed to fetch template %q: %w", tmplName, err)
		}
		templates = append(templates, tmpl)
	}

	return &stage, templates, nil
}

func (r *ReleaseReconciler) buildPromoteParams(release *paprikav1.Release) map[string]string {
	params := map[string]string{
		"release-name": release.Name,
	}
	if release.Spec.From != "" {
		params["from"] = release.Spec.From
	}
	for k, v := range release.Spec.Parameters {
		params[k] = v
	}
	return params
}

func (r *ReleaseReconciler) applyPromotedManifests(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, manifests []byte) error {
	resolvedCluster, err := r.resolveClusterRef(ctx, &stage.Spec.Cluster, release.Namespace)
	if err != nil {
		return fmt.Errorf("failed to resolve cluster ref: %w", err)
	}
	appName := release.Labels["app.paprika.io/name"]
	return r.applyManifestsForCluster(ctx, release.Namespace, &resolvedCluster, appName, manifests)
}

func (r *ReleaseReconciler) applyManifestsForCluster(ctx context.Context, namespace string, cluster *paprikav1.ClusterRef, appName string, manifests []byte) error {
	if cluster.Mode == paprikav1.ClusterModeAgent || cluster.AgentAddress != "" {
		return r.applyViaAgent(ctx, cluster, namespace, appName, manifests)
	}
	kubeconfigSecret := ""
	if cluster.KubeconfigSecret != "" {
		kubeconfigSecret = cluster.KubeconfigSecret
	}
	if err := r.applyManifests(ctx, manifests, namespace, kubeconfigSecret, appName); err != nil {
		return fmt.Errorf("failed to apply manifests: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) applyViaAgent(ctx context.Context, cluster *paprikav1.ClusterRef, namespace, appName string, manifests []byte) error {
	baseURL := cluster.AgentAddress
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://%s.%s.svc.cluster.local:8083", cluster.Name, cluster.Namespace)
	}
	builder := r.AgentClientBuilder
	if builder == nil {
		builder = func(baseURL string) AgentClient {
			return agentclient.NewControllerClient(baseURL)
		}
	}
	cli := builder(baseURL)
	resp, err := cli.Apply(ctx, &agentserver.ApplyRequest{
		Namespace: namespace,
		AppName:   appName,
		Manifests: manifests,
	})
	if err != nil {
		return fmt.Errorf("agent apply to %s failed: %w", baseURL, err)
	}
	if len(resp.Errors) > 0 {
		return fmt.Errorf("agent apply to %s returned errors: %v", baseURL, resp.Errors)
	}
	return nil
}

func (r *ReleaseReconciler) resolveDynamicClient(ctx context.Context, kubeconfigSecret, namespace string) (dynamic.Interface, error) {
	if r.ClusterMgr != nil && kubeconfigSecret != "" {
		dynClient, err := r.ClusterMgr.GetClient(ctx, kubeconfigSecret, namespace)
		if err != nil {
			return nil, fmt.Errorf("getting cluster client: %w", err)
		}
		return dynClient, nil
	}
	dynClient, err := dynamic.NewForConfig(r.RestConfig)
	if err != nil {
		return nil, fmt.Errorf("creating dynamic client: %w", err)
	}
	return dynClient, nil
}

func (r *ReleaseReconciler) resolveClusterRef(ctx context.Context, ref *paprikav1.ClusterRef, defaultNs string) (paprikav1.ClusterRef, error) {
	if ref.Name == "" {
		return *ref, nil
	}
	ns := ref.Namespace
	if ns == "" {
		ns = defaultNs
	}

	var cluster clustersv1alpha1.Cluster
	if err := r.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: ns}, &cluster); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return *ref, fmt.Errorf("getting cluster %s/%s: %w", ns, ref.Name, err)
		}
		return *ref, nil
	}

	out := *ref
	if cluster.Spec.KubeconfigSecretRef != nil {
		out.KubeconfigSecret = cluster.Spec.KubeconfigSecretRef.Name
		if cluster.Spec.KubeconfigSecretRef.Namespace != "" {
			out.Namespace = cluster.Spec.KubeconfigSecretRef.Namespace
		}
	}
	if cluster.Spec.Server != "" {
		out.Server = cluster.Spec.Server
	}
	if cluster.Spec.ServiceAccount != "" {
		out.ServiceAccount = cluster.Spec.ServiceAccount
	}
	return out, nil
}

func (r *ReleaseReconciler) applyAllDocuments(ctx context.Context, log logr.Logger, dynClient dynamic.Interface, docs [][]byte, namespace, appName string) int {
	applied := 0
	for _, doc := range docs {
		obj, ok := r.parseManifest(doc)
		if !ok {
			continue
		}
		if r.applyDocument(ctx, log, dynClient, obj, namespace, appName) {
			applied++
		}
	}
	return applied
}

func (r *ReleaseReconciler) parseManifest(doc []byte) (map[string]interface{}, bool) {
	var obj map[string]interface{}
	if err := yaml.Unmarshal(doc, &obj); err != nil {
		return nil, false
	}
	if obj == nil {
		return nil, false
	}
	if kind, ok := obj["kind"].(string); !ok || kind == "" {
		return nil, false
	}
	return obj, true
}

func (r *ReleaseReconciler) applyDocument(ctx context.Context, log logr.Logger, dynClient dynamic.Interface, obj map[string]interface{}, namespace, appName string) bool {
	kind, ok := obj["kind"].(string)
	if !ok || kind == "" {
		return false
	}
	apiVersion, _ := obj["apiVersion"].(string)
	group, version := parseAPIVersion(apiVersion)

	metadata, ok := obj["metadata"].(map[string]interface{})
	if !ok || metadata == nil {
		return false
	}
	name, _ := metadata["name"].(string)
	if name == "" {
		return false
	}

	setPaprikaLabels(metadata, appName)
	targetNamespace := setTargetNamespace(obj, metadata, namespace)

	gvr, err := r.gvrFromKind(kind, group, version)
	if err != nil {
		log.Error(err, "Could not determine GVR, skipping", "kind", kind, "apiVersion", apiVersion)
		return false
	}

	unstructuredObj := &unstructured.Unstructured{Object: obj}
	_, err = dynClient.Resource(gvr).Namespace(targetNamespace).Apply(ctx, name, unstructuredObj, metav1.ApplyOptions{FieldManager: "paprika", Force: true})
	if err != nil {
		log.Error(err, "Failed to apply resource", "kind", kind, "name", name)
		return false
	}
	return true
}

func setPaprikaLabels(metadata map[string]interface{}, appName string) {
	labelsRaw, ok := metadata["labels"].(map[string]interface{})
	if !ok || labelsRaw == nil {
		labelsRaw = make(map[string]interface{})
		metadata["labels"] = labelsRaw
	}
	labelsRaw[engine.ManagedByLabelKey] = engine.ManagedByLabelValue
	if appName != "" {
		labelsRaw[engine.ApplicationNameLabelKey] = appName
	}
}

func parseAPIVersion(apiVersion string) (group, version string) {
	parts := strings.Split(apiVersion, "/")
	switch len(parts) {
	case 2:
		return parts[0], parts[1]
	case 1:
		return "", parts[0]
	}
	return "", ""
}

func setTargetNamespace(obj, metadata map[string]interface{}, fallback string) string {
	if ns, ok := metadata["namespace"].(string); ok && ns != "" {
		return ns
	}
	metadata["namespace"] = fallback
	obj["metadata"] = metadata
	return fallback
}

func (r *ReleaseReconciler) gvrFromKind(kind, group, version string) (schema.GroupVersionResource, error) {
	if gvr, ok := knownGVRs[kind]; ok {
		return gvr, nil
	}

	if group == "" || version == "" {
		return schema.GroupVersionResource{}, fmt.Errorf("cannot determine GVR for kind %s with apiVersion %s/%s", kind, group, version)
	}

	resourceName := strings.ToLower(kind) + "s"
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resourceName}, nil
}

func (r *ReleaseReconciler) storeManifestSnapshot(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, name string, manifests []byte) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: r.Namespace,
			Labels: map[string]string{
				"paprika.io/stage":   stage.Name,
				"paprika.io/release": release.Name,
			},
		},
		Data: map[string]string{"manifests.yaml": string(manifests)},
	}

	existing := &corev1.ConfigMap{}
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: r.Namespace}, existing); err == nil {
		existing.Data = cm.Data
		existing.Labels = cm.Labels
		if err := r.Update(ctx, existing); err != nil {
			return fmt.Errorf("updating manifest snapshot: %w", err)
		}
		return nil
	}

	if err := r.Create(ctx, cm); err != nil {
		return fmt.Errorf("creating manifest snapshot: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) verify(ctx context.Context, release *paprikav1.Release) bool {
	log := logf.FromContext(ctx)

	gateConfigs := release.Spec.Verify
	if len(gateConfigs) == 0 {
		return true
	}

	for _, cfg := range gateConfigs {
		gateCfg := gates.GateConfig{
			Type:     cfg.Type,
			Endpoint: cfg.Endpoint,
			Timeout:  cfg.Timeout,
		}
		result := r.GateExecutor.Execute(ctx, gateCfg)
		if !result.Passed {
			log.Info("Gate failed", "type", cfg.Type, "message", result.Message)
			return false
		}
		log.Info("Gate passed", "type", cfg.Type, "message", result.Message)
	}

	return true
}

func (r *ReleaseReconciler) rollback(ctx context.Context, release *paprikav1.Release) error {
	log := logf.FromContext(ctx)

	if release.Status.RenderedManifestSnapshot == "" {
		log.Info("No manifest snapshot available for rollback", "release", release.Name)
		release.Status.Phase = paprikav1.ReleaseRolledBack
		release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
			Type:               "RolledBack",
			Status:             metav1.ConditionTrue,
			LastTransitionTime: metav1.Now(),
			Reason:             "NoSnapshot",
			Message:            "No manifest snapshot available for rollback",
		})
		if len(release.Status.PromotionHistory) > 0 {
			release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "RolledBack"
		}
		if err := r.patchReleaseStatus(ctx, release); err != nil {
			return fmt.Errorf("updating release status for rollback: %w", err)
		}
		return nil
	}

	var cm corev1.ConfigMap
	if err := r.Get(ctx, types.NamespacedName{
		Name:      release.Status.RenderedManifestSnapshot,
		Namespace: r.Namespace,
	}, &cm); err != nil {
		return fmt.Errorf("failed to fetch manifest snapshot %q: %w", release.Status.RenderedManifestSnapshot, err)
	}

	log.Info("Rolling back to manifest snapshot", "snapshot", cm.Name, "bytes", len(cm.Data["manifests.yaml"]))

	release.Status.Phase = paprikav1.ReleaseRolledBack
	release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
		Type:               "RolledBack",
		Status:             metav1.ConditionTrue,
		LastTransitionTime: metav1.Now(),
		Reason:             "VerificationFailed",
		Message:            "Rolled back due to verification failure",
	})
	if len(release.Status.PromotionHistory) > 0 {
		release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "RolledBack"
	}

	if err := r.patchReleaseStatus(ctx, release); err != nil {
		return fmt.Errorf("updating release status after rollback: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) cleanup(ctx context.Context, release *paprikav1.Release) error {
	log := logf.FromContext(ctx)

	// Use the name recorded in status; fall back to label-based search if empty
	cmName := release.Status.RenderedManifestSnapshot
	if cmName != "" {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      cmName,
				Namespace: r.Namespace,
			},
		}
		if err := r.Delete(ctx, cm); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("deleting manifest snapshot ConfigMap: %w", err)
		}
		log.Info("Deleted manifest snapshot ConfigMap", "configmap", cmName)
	}

	labelSelector := labels.Set{"paprika.io/release": release.Name}.String()
	for _, gvr := range managedGVRs {
		items, err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).List(ctx, metav1.ListOptions{
			LabelSelector: labelSelector,
		})
		if err != nil {
			return fmt.Errorf("listing %s: %w", gvr.Resource, err)
		}
		for _, item := range items.Items {
			if err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("deleting %s/%s: %w", gvr.Resource, item.GetName(), err)
			}
			log.Info("Deleted managed resource", "resource", gvr.Resource, "name", item.GetName())
		}
	}

	return nil
}

func (r *ReleaseReconciler) applyTrafficWeight(ctx context.Context, stage *paprikav1.Stage, release *paprikav1.Release, weight int, log logr.Logger, result *string) error {
	router, routerErr := r.routerForStage(ctx, stage, release)
	if routerErr != nil {
		log.Error(routerErr, "Failed to create traffic router")
		*result = resultError
		return routerErr
	}
	if router == nil {
		return nil
	}
	if weight > 100 {
		return fmt.Errorf("canary weight exceeds 100: %d", weight)
	}
	if err := router.SetWeight(ctx, int32(weight)); err != nil { //nolint:gosec // validated weight <= 100 above
		log.Error(err, "Failed to set traffic weight", "weight", weight)
		*result = resultError
		return fmt.Errorf("setting traffic weight: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) reconcileCanary(ctx context.Context, release *paprikav1.Release, _ time.Time, result *string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var stage paprikav1.Stage
	if err := r.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: release.Namespace}, &stage); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to fetch stage: %w", err)
	}

	if !r.hasCanarySteps(&stage) {
		return r.transitionToVerifying(ctx, release, result)
	}
	canaryCfg := stage.Spec.Canary

	stepIdx := release.Status.CanaryStepIndex
	if stepIdx >= len(canaryCfg.Steps) {
		return r.handleCanaryPromotion(ctx, release, &stage, result)
	}

	if requeue, ok := r.checkCanaryThrottle(log, release, canaryCfg, stepIdx); ok {
		return requeue, nil
	}

	currentWeight := canaryCfg.Steps[stepIdx]
	log.Info("Canary step", "release", release.Name, "step", stepIdx, "weight", currentWeight)
	metrics.CanaryStepTotal.WithLabelValues(release.Name, release.Namespace, stage.Name).Inc()
	metrics.CanaryWeightGauge.WithLabelValues(release.Name, release.Namespace, stage.Name).Set(float64(currentWeight))

	return r.advanceCanaryStep(ctx, release, &stage, canaryCfg, stepIdx, currentWeight, log, result)
}

func (r *ReleaseReconciler) advanceCanaryStep(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, canaryCfg *paprikav1.CanaryConfig, stepIdx, currentWeight int, log logr.Logger, result *string) (ctrl.Result, error) {
	if stop, analysisErr := r.runCanaryAnalysis(ctx, release, canaryCfg, result, log); analysisErr != nil {
		return ctrl.Result{}, analysisErr
	} else if stop {
		return ctrl.Result{}, nil
	}

	if err := r.applyCanaryWeight(ctx, release, stage, currentWeight); err != nil {
		log.Error(err, "Failed to apply canary weight")
		*result = resultError
		return ctrl.Result{}, err
	}

	if err := r.applyTrafficWeight(ctx, stage, release, currentWeight, log, result); err != nil {
		return ctrl.Result{}, err
	}

	release.Status.CanaryWeight = currentWeight
	release.Status.CanaryStepIndex = stepIdx + 1
	now := metav1.Now()
	release.Status.CanaryStepStartedAt = &now

	if r.canPromoteCanary(stepIdx, canaryCfg.Steps, currentWeight) {
		return r.handleCanaryPromotion(ctx, release, stage, result)
	}

	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to update canary status: %w", err)
	}

	return ctrl.Result{RequeueAfter: r.getCanaryInterval(canaryCfg)}, nil
}

func (r *ReleaseReconciler) checkCanaryThrottle(log logr.Logger, release *paprikav1.Release, canaryCfg *paprikav1.CanaryConfig, stepIdx int) (ctrl.Result, bool) {
	if stepIdx <= 0 || release.Status.CanaryStepStartedAt == nil {
		return ctrl.Result{}, false
	}
	interval := r.getCanaryInterval(canaryCfg)
	nextStepAt := release.Status.CanaryStepStartedAt.Add(time.Duration(stepIdx) * interval)
	if time.Now().Before(nextStepAt) {
		log.Info("Waiting for canary interval", "release", release.Name, "step", stepIdx, "nextAt", nextStepAt)
		return ctrl.Result{RequeueAfter: time.Until(nextStepAt)}, true
	}
	return ctrl.Result{}, false
}

func (r *ReleaseReconciler) canPromoteCanary(stepIdx int, steps []int, currentWeight int) bool {
	return stepIdx+1 >= len(steps) || currentWeight >= 100
}

func (r *ReleaseReconciler) routerForStage(ctx context.Context, stage *paprikav1.Stage, release *paprikav1.Release) (traffic.Router, error) {
	if stage.Spec.TrafficRouter == nil {
		return nil, nil
	}
	stableSvc := ""
	canarySvc := ""
	if stage.Spec.TrafficRouter.Provider == "gateway-api" && stage.Spec.TrafficRouter.GatewayAPI != nil {
		stableSvc = stage.Spec.TrafficRouter.GatewayAPI.StableService
		canarySvc = stage.Spec.TrafficRouter.GatewayAPI.CanaryService
	} else if stage.Spec.TrafficRouter.Provider == "istio" && stage.Spec.TrafficRouter.Istio != nil {
		stableSvc = stage.Spec.TrafficRouter.Istio.StableService
		canarySvc = stage.Spec.TrafficRouter.Istio.CanaryService
	}
	if stableSvc == "" {
		stableSvc = release.Name + "-stable"
	}
	if canarySvc == "" {
		canarySvc = release.Name + "-canary"
	}
	routerObj, err := r.TrafficRouterFactory(stage.Spec.TrafficRouter, r.DynamicClient, stableSvc, canarySvc, release.Namespace)
	if err != nil {
		return nil, fmt.Errorf("creating traffic router: %w", err)
	}
	return routerObj, nil
}

func (r *ReleaseReconciler) runCanaryAnalysis(ctx context.Context, release *paprikav1.Release, canaryCfg *paprikav1.CanaryConfig, result *string, log logr.Logger) (bool, error) {
	if canaryCfg.Analysis == nil || len(canaryCfg.Analysis.Checks) == 0 {
		return false, nil
	}

	results := r.Analyzer.RunChecks(ctx, canaryCfg.Analysis.Checks)

	for i, chkResult := range results {
		checkType := ""
		if i < len(canaryCfg.Analysis.Checks) {
			checkType = canaryCfg.Analysis.Checks[i].Type
		}
		resultLabel := "failed"
		if chkResult.Passed {
			resultLabel = "passed"
		}
		metrics.AnalysisCheckTotal.WithLabelValues(release.Name, release.Namespace, checkType, resultLabel).Inc()
		if chkResult.Passed {
			log.Info("PDV check passed", "message", chkResult.Message)
			continue
		}
		log.Info("PDV check failed", "message", chkResult.Message)
		if canaryCfg.Analysis.RollbackOnFail {
			return true, r.handleAnalysisRollback(ctx, release, result, chkResult)
		}
	}
	return false, nil
}

func (r *ReleaseReconciler) handleAnalysisRollback(ctx context.Context, release *paprikav1.Release, result *string, chkResult analysis.Result) error {
	log := logf.FromContext(ctx)
	log.Info("Rolling back canary due to analysis failure")
	release.Status.Phase = paprikav1.ReleaseFailed
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
	release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
		Type:               "CanaryFailed",
		Status:             metav1.ConditionTrue,
		LastTransitionTime: metav1.Now(),
		Reason:             "AnalysisFailed",
		Message:            chkResult.Message,
	})
	if len(release.Status.PromotionHistory) > 0 {
		release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "CanaryFailed"
	}
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return fmt.Errorf("failed to set release failed: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) handleCanaryPromotion(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, result *string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	if err := r.promoteCanary(ctx, release, stage); err != nil {
		log.Error(err, "Failed to promote canary to stable")
		release.Status.Phase = paprikav1.ReleaseFailed
		metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
		release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
			Type:               "CanaryPromotionFailed",
			Status:             metav1.ConditionTrue,
			LastTransitionTime: metav1.Now(),
			Reason:             "PromotionFailed",
			Message:            fmt.Sprintf("Canary promotion failed: %v", err),
		})
		if updateErr := r.patchReleaseStatus(ctx, release); updateErr != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", updateErr)
		}
		return ctrl.Result{}, nil
	}
	release.Status.Phase = paprikav1.ReleaseVerifying
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Verifying").Inc()
	release.Status.CanaryWeight = 100
	metrics.CanaryWeightGauge.WithLabelValues(release.Name, release.Namespace, stage.Name).Set(100)
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to transition to verifying: %w", err)
	}
	return ctrl.Result{Requeue: true}, nil
}

func (r *ReleaseReconciler) applyCanaryWeight(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, weight int) error {
	log := logf.FromContext(ctx)

	var templates []paprikav1.Template
	for _, tmplName := range stage.Spec.Templates {
		var tmpl paprikav1.Template
		if err := r.Get(ctx, types.NamespacedName{Name: tmplName, Namespace: release.Namespace}, &tmpl); err != nil {
			return fmt.Errorf("failed to fetch template %q: %w", tmplName, err)
		}
		templates = append(templates, tmpl)
	}

	params := map[string]string{
		"release-name": release.Name,
	}
	if release.Spec.From != "" {
		params["from"] = release.Spec.From
	}
	for k, v := range release.Spec.Parameters {
		params[k] = v
	}
	params["features.canary.enabled"] = "true"
	params["canaryWeight"] = strconv.Itoa(weight)

	manifests, err := r.TemplateRenderer.RenderAll(ctx, templates, params)
	if err != nil {
		return fmt.Errorf("canary template rendering failed: %w", err)
	}

	snapshotName := fmt.Sprintf("%s-canary-%d", stage.Name, weight)
	if storeErr := r.storeManifestSnapshot(ctx, release, stage, snapshotName, manifests); storeErr != nil {
		return fmt.Errorf("failed to store canary manifest snapshot: %w", storeErr)
	}

	resolvedCluster, err := r.resolveClusterRef(ctx, &stage.Spec.Cluster, release.Namespace)
	if err != nil {
		return fmt.Errorf("failed to resolve cluster ref: %w", err)
	}
	appName := release.Labels["app.paprika.io/name"]
	if err := r.applyManifestsForCluster(ctx, release.Namespace, &resolvedCluster, appName, manifests); err != nil {
		return fmt.Errorf("failed to apply canary manifests: %w", err)
	}

	log.Info("Applied canary manifests", "stage", stage.Name, "weight", weight)
	return nil
}

func (r *ReleaseReconciler) promoteCanary(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage) error {
	log := logf.FromContext(ctx)

	templates, err := r.fetchStageTemplates(ctx, release, stage)
	if err != nil {
		return err
	}

	manifests, err := r.TemplateRenderer.RenderAll(ctx, templates, r.promotionParams(release))
	if err != nil {
		return fmt.Errorf("canary promotion template rendering failed: %w", err)
	}

	snapshotName := stage.Name + "-manifest-snapshot"
	if storeErr := r.storeManifestSnapshot(ctx, release, stage, snapshotName, manifests); storeErr != nil {
		return fmt.Errorf("failed to store promoted manifest snapshot: %w", storeErr)
	}

	resolvedCluster, err := r.resolveClusterRef(ctx, &stage.Spec.Cluster, release.Namespace)
	if err != nil {
		return fmt.Errorf("failed to resolve cluster ref: %w", err)
	}
	appName := release.Labels["app.paprika.io/name"]
	if err := r.applyManifestsForCluster(ctx, release.Namespace, &resolvedCluster, appName, manifests); err != nil {
		return fmt.Errorf("failed to apply promoted manifests: %w", err)
	}

	if err := r.removeCanaryRoutes(ctx, stage, release, log); err != nil {
		return err
	}

	if err := r.cleanupCanaryResources(ctx, release.Namespace); err != nil {
		log.Error(err, "Failed to clean up some canary resources")
	}

	log.Info("Promoted canary to stable, cleaned up canary resources", "stage", stage.Name)
	return nil
}

func (r *ReleaseReconciler) fetchStageTemplates(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage) ([]paprikav1.Template, error) {
	var templates []paprikav1.Template
	for _, tmplName := range stage.Spec.Templates {
		var tmpl paprikav1.Template
		if err := r.Get(ctx, types.NamespacedName{Name: tmplName, Namespace: release.Namespace}, &tmpl); err != nil {
			return nil, fmt.Errorf("failed to fetch template %q: %w", tmplName, err)
		}
		templates = append(templates, tmpl)
	}
	return templates, nil
}

func (r *ReleaseReconciler) promotionParams(release *paprikav1.Release) map[string]string {
	params := map[string]string{
		"release-name": release.Name,
	}
	if release.Spec.From != "" {
		params["from"] = release.Spec.From
	}
	for k, v := range release.Spec.Parameters {
		params[k] = v
	}
	params["canaryWeight"] = "0"
	return params
}

func (r *ReleaseReconciler) removeCanaryRoutes(ctx context.Context, stage *paprikav1.Stage, release *paprikav1.Release, log logr.Logger) error {
	router, routerErr := r.routerForStage(ctx, stage, release)
	if routerErr != nil {
		log.Error(routerErr, "Failed to create traffic router for cleanup")
		return nil
	}
	if router == nil {
		return nil
	}
	if err := router.RemoveCanary(ctx); err != nil {
		log.Error(err, "Failed to remove canary routes")
		return fmt.Errorf("failed to remove canary routes: %w", err)
	}
	return nil
}

func (r *ReleaseReconciler) cleanupCanaryResources(ctx context.Context, namespace string) error {
	dynClient, err := dynamic.NewForConfig(r.RestConfig)
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}

	log := logf.FromContext(ctx)
	var errs []error

	deployGVR := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	svcGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"}
	ingressGVR := schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"}

	for _, gvr := range []schema.GroupVersionResource{deployGVR, svcGVR, ingressGVR} {
		resources, err := dynClient.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{
			LabelSelector: "track=canary",
		})
		if err != nil {
			errs = append(errs, fmt.Errorf("failed to list canary %s: %w", gvr.Resource, err))
			continue
		}
		for _, item := range resources.Items {
			log.Info("Deleting canary resource", "kind", gvr.Resource, "name", item.GetName())
			if err := dynClient.Resource(gvr).Namespace(namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{}); err != nil {
				errs = append(errs, fmt.Errorf("failed to delete canary %s/%s: %w", gvr.Resource, item.GetName(), err))
			}
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("errors during canary cleanup: %w", errors.Join(errs...))
	}
	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *ReleaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&paprikav1.Release{}).
		Owns(&corev1.ConfigMap{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 5}).
		Named("release").
		Complete(r); err != nil {
		return fmt.Errorf("unable to create release controller: %w", err)
	}
	return nil
}
