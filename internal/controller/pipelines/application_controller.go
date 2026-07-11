package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/record"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/health"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/ratelimit"
	"github.com/benebsworth/paprika/internal/repository"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/internal/syncwindow"
)

const (
	defaultRequeue             = 5 * time.Second
	maxReleaseHistory          = 10
	releaseLabelKey            = "app.paprika.io/release"
	defaultHealthCheckInterval = 30 * time.Second

	// syncAnnotation is the canonical annotation used to request an immediate
	// Application sync. It is set by the API (SyncApplication), webhooks, and
	// users who want to force a refresh.
	syncAnnotation = "paprika.io/sync"

	// legacyWebhookTriggerAnnotation was used by early webhook receiver
	// implementations. Kept for backward compatibility.
	legacyWebhookTriggerAnnotation = "paprika.io/webhook-trigger"

	sourceHashAnnotation     = "paprika.io/source-hash"
	sourceRevisionAnnotation = "paprika.io/source-revision"
	maxKubernetesNameLength  = 63
)

func withProjectLabels(app *paprikav1.Application, labels map[string]string) map[string]string {
	if labels == nil {
		labels = map[string]string{}
	}
	project := app.Spec.Project
	if project == "" {
		project = defaultProjectName
	}
	labels["app.paprika.io/project"] = project
	return labels
}

// ApplicationReconciler reconciles Application resources.
type ApplicationReconciler struct {
	client              client.Client
	Scheme              *runtime.Scheme
	K8sClient           *kubernetes.Clientset
	Namespace           string
	RestConfig          *rest.Config
	WorkDir             string
	HealthEval          *health.CELEvaluator
	DiffEngine          DiffEngine
	ResHealth           *health.ResourceHealthChecker
	ClusterMgr          ClusterClientManager
	TemplateRenderer    SourceResolvingRenderer
	ShardFilter         *sharding.Filter
	RateLimiter         *ratelimit.ControllerRateLimit
	EventRecorder       record.EventRecorder
	ProjectValidator    *governance.ProjectValidator
	EventBroker         *events.Broker
	SyncWindowEvaluator syncwindow.Evaluator
	Clock               clock.Clock
	// now returns the current time. Overridden in tests.
	now func() time.Time
}

// NewApplicationReconciler returns an ApplicationReconciler initialized with the
// given Kubernetes client. Callers should set the exported dependencies before
// calling SetupWithManager.
func NewApplicationReconciler(c client.Client) *ApplicationReconciler {
	return &ApplicationReconciler{client: c}
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysistemplates,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts,verbs=get;list;watch

// Reconcile handles Application reconciliation.
func (r *ApplicationReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "Application", req)
	defer func() { endSpan(spanErr) }()

	var app paprikav1.Application
	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("application", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("application").Observe(metrics.Since(r.Clock, start))
		metrics.ApplicationReconcileDuration.WithLabelValues(app.Name, app.Namespace).Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)
	log.Info("Reconciling Application", "namespace", req.Namespace, "name", req.Name)

	if err := r.client.Get(ctx, req.NamespacedName, &app); err != nil {
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			result = resultError
			return ctrl.Result{}, fmt.Errorf("getting application: %w", k8sErr)
		}
		return ctrl.Result{}, nil
	}

	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping application not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	if r.RateLimiter != nil {
		if !r.RateLimiter.AllowGlobal() {
			log.Info("Global rate limit exceeded, requeueing", "app", app.Name)
			return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
		}
		if !r.RateLimiter.AllowApp(ratelimit.ReconcileKey(req.Namespace, req.Name)) {
			log.Info("Per-application rate limit exceeded, requeueing", "app", app.Name)
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
	}

	return r.reconcileApp(ctx, &app)
}

func (r *ApplicationReconciler) isInlineSource(app *paprikav1.Application) bool {
	return app.Spec.Source.Type == paprikav1.SourceTypeInline
}

func (r *ApplicationReconciler) reconcileApp(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	projectName := app.Spec.Project
	if projectName == "" {
		projectName = defaultProjectName
	}

	if !r.isInlineSource(app) {
		if err := r.reconcileTemplate(ctx, app); err != nil {
			log.Error(err, "Failed to reconcile Template")
			r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "TemplateReconciliationFailed", err.Error())
			return ctrl.Result{}, err
		}
	}

	if r.hasSyncTrigger(app) {
		return r.handleSyncTrigger(ctx, app)
	}

	if appNeedsReplacementReleaseFlow(app.Status.Phase) {
		return r.handleReplacementReleaseFlow(ctx, app)
	}

	r.pruneReleasesIfInline(ctx, app)

	if ctrlResult, err := r.reconcileAppPipeline(ctx, app); ctrlResult != nil || err != nil {
		if err != nil {
			return ctrl.Result{}, err
		}
		return *ctrlResult, nil
	}

	if err := r.reconcileStagesForApp(ctx, app); err != nil {
		return ctrl.Result{}, err
	}

	return r.reconcileAppAfterStages(ctx, app, projectName)
}

func (r *ApplicationReconciler) handleReplacementReleaseFlow(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	if err := r.reconcileStagesForApp(ctx, app); err != nil {
		return ctrl.Result{}, err
	}
	return r.handleHealthyPhase(ctx, app)
}

func (r *ApplicationReconciler) reconcileStagesForApp(ctx context.Context, app *paprikav1.Application) error {
	if err := r.reconcileStages(ctx, app); err != nil {
		log.FromContext(ctx).Error(err, "Failed to reconcile Stages")
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "StageReconciliationFailed", err.Error())
		return err
	}
	return nil
}

func appNeedsReplacementReleaseFlow(phase paprikav1.ApplicationPhase) bool {
	return phase == paprikav1.ApplicationHealthy || phase == paprikav1.ApplicationRolledBack
}

func (r *ApplicationReconciler) reconcileAppAfterStages(ctx context.Context, app *paprikav1.Application, projectName string) (ctrl.Result, error) {
	blocked, err := r.reconcileGovernance(ctx, app, projectName)
	if err != nil || blocked {
		return ctrl.Result{}, err
	}
	result, err := r.reconcileReleaseFlow(ctx, app)
	if err != nil {
		r.mirrorReleaseGovernanceFailure(ctx, app)
		return ctrl.Result{}, err
	}
	return result, nil
}

func (r *ApplicationReconciler) mirrorReleaseGovernanceFailure(ctx context.Context, app *paprikav1.Application) {
	log := log.FromContext(ctx)
	if app.Status.ReleaseRef == "" {
		return
	}
	var release paprikav1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}, &release); err != nil {
		log.Error(err, "Failed to fetch Release for governance failure mirror", "app", app.Name, "release", app.Status.ReleaseRef)
		return
	}
	cond := meta.FindStatusCondition(release.Status.Conditions, governanceCheckedCondition)
	if cond == nil || cond.Status != metav1.ConditionFalse {
		return
	}
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               governanceCheckedCondition,
		Status:             metav1.ConditionFalse,
		Reason:             governanceViolationReason,
		Message:            cond.Message,
		LastTransitionTime: metav1.Now(),
	})
	if err := r.client.Status().Update(ctx, app); err != nil {
		log.Error(err, "Failed to mirror governance failure to Application", "app", app.Name, "release", release.Name)
	}
}

func (r *ApplicationReconciler) reconcileGovernance(ctx context.Context, app *paprikav1.Application, projectName string) (bool, error) {
	log := log.FromContext(ctx)

	if r.ProjectValidator == nil {
		return false, nil
	}

	project, err := r.ProjectValidator.ResolveProject(ctx, app.Namespace, projectName)
	if err != nil {
		log.Error(err, "Failed to resolve AppProject", "app", app.Name, "namespace", app.Namespace, "project", projectName)
		return r.failGovernance(ctx, app, "ProjectResolutionFailed", err)
	}

	violations, err := r.ProjectValidator.Validate(ctx, app, nil, project)
	if err != nil {
		log.Error(err, "Failed to validate project boundaries", "app", app.Name, "namespace", app.Namespace, "project", projectName)
		return r.failGovernance(ctx, app, "ProjectValidationError", err)
	}

	if blocking := violations.Blocking(); len(blocking) > 0 {
		return r.blockGovernance(ctx, app, blocking[0].Message)
	}
	if warnings := violations.Warnings(); len(warnings) > 0 {
		return r.warnGovernance(ctx, app, warnings[0].Message)
	}
	return r.passGovernance(ctx, app)
}

func (r *ApplicationReconciler) failGovernance(ctx context.Context, app *paprikav1.Application, reason string, err error) (bool, error) {
	if err == nil {
		return false, nil
	}
	// updatePhase mutates app.Status in memory; patchAppStatus persists it.
	r.updatePhase(ctx, app, paprikav1.ApplicationFailed, reason, err.Error())
	if patchErr := r.patchAppStatus(ctx, app); patchErr != nil {
		return false, fmt.Errorf("patch application status after governance failure %s: %w", reason, patchErr)
	}
	return false, err
}

func (r *ApplicationReconciler) blockGovernance(ctx context.Context, app *paprikav1.Application, msg string) (bool, error) {
	setApplicationGovernanceCondition(app, metav1.ConditionFalse, projectViolationReason, msg)
	r.updatePhase(ctx, app, paprikav1.ApplicationFailed, governanceViolationReason, msg)
	if r.EventRecorder != nil {
		r.EventRecorder.Eventf(app, corev1.EventTypeWarning, projectViolationReason, "%s", msg)
	}
	if patchErr := r.patchAppStatus(ctx, app); patchErr != nil {
		return false, fmt.Errorf("patch application status after governance violation: %w", patchErr)
	}
	return true, nil
}

func (r *ApplicationReconciler) warnGovernance(_ context.Context, app *paprikav1.Application, msg string) (bool, error) {
	setApplicationGovernanceCondition(app, metav1.ConditionTrue, passedWithWarningsReason, "Governance checks passed with warnings: "+msg)
	if r.EventRecorder != nil {
		r.EventRecorder.Eventf(app, corev1.EventTypeWarning, "GovernanceWarning", "%s", msg)
	}
	// Status is persisted by reconcileReleaseFlow.
	return false, nil
}

func (r *ApplicationReconciler) passGovernance(_ context.Context, app *paprikav1.Application) (bool, error) {
	setApplicationGovernanceCondition(app, metav1.ConditionTrue, passedReason, "Governance checks passed")
	// Status is persisted by reconcileReleaseFlow.
	return false, nil
}

func setApplicationGovernanceCondition(app *paprikav1.Application, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               governanceCheckedCondition,
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
}

func (r *ApplicationReconciler) reconcileReleaseFlow(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// Approval gates are now evaluated by the Release controller before promotion.

	result, err := r.reconcileRelease(ctx, app)
	if err != nil {
		log.Error(err, "Failed to reconcile Release")
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "ReleaseReconciliationFailed", err.Error())
		return ctrl.Result{}, err
	}
	if result.RequeueAfter > 0 {
		return result, nil
	}

	r.evaluateHealth(ctx, app)
	r.evaluateDiff(ctx, app)
	r.evaluateResourceHealth(ctx, app)

	if err := r.reconcileAnalysisRuns(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile analysis runs")
	}

	if err := r.reconcileSelfHeal(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile self-heal")
	}

	if err := r.patchAppStatus(ctx, app); err != nil {
		log.Error(err, "Failed to update application status after evaluation")
	}

	if pruneErr := r.pruneReleaseHistory(ctx, app); pruneErr != nil {
		log.Error(pruneErr, "Failed to prune release history")
	}

	return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}

func syncTriggerPresent(annotations map[string]string) bool {
	if annotations == nil {
		return false
	}
	for _, key := range []string{syncAnnotation, resyncAnnotation, legacyWebhookTriggerAnnotation} {
		if _, ok := annotations[key]; ok {
			return true
		}
	}
	return false
}

func (r *ApplicationReconciler) hasSyncTrigger(app *paprikav1.Application) bool {
	return syncTriggerPresent(app.Annotations)
}

func (r *ApplicationReconciler) handleSyncTrigger(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)
	log.Info("Sync trigger detected")
	manualOverride := app.Annotations[manualSyncAnnotation] != ""
	patch := client.MergeFrom(app.DeepCopy())
	for _, key := range []string{syncAnnotation, resyncAnnotation, legacyWebhookTriggerAnnotation} {
		delete(app.Annotations, key)
	}
	if err := r.client.Patch(ctx, app, patch); err != nil {
		log.Error(err, "Failed to clear sync trigger annotation")
		return ctrl.Result{}, fmt.Errorf("clearing sync trigger annotation: %w", err)
	}

	if app.Status.Phase == paprikav1.ApplicationHealthy && !r.isInlineSource(app) {
		sourceChanged, err := r.checkSourceChanged(ctx, app)
		if err != nil {
			log.Error(err, "Failed to refresh source after sync trigger")
			return ctrl.Result{RequeueAfter: defaultRequeue}, nil
		}
		if sourceChanged {
			return r.startNewReleaseFlow(ctx, app, manualOverride, "SourceChanged", "source hash changed, creating a new release")
		}
	}

	if manualOverride {
		if err := r.requestCurrentReleaseResync(ctx, app); err != nil {
			log.Error(err, "Failed to request current release resync")
			return ctrl.Result{}, fmt.Errorf("requesting current release resync: %w", err)
		}
		r.setApplicationPhase(ctx, app, paprikav1.ApplicationPending, "ManualSync", "manual sync requested")
		if err := r.patchAppStatus(ctx, app); err != nil {
			log.Error(err, "Failed to update status after manual sync trigger")
			return ctrl.Result{}, fmt.Errorf("updating status after manual sync trigger: %w", err)
		}
	}
	return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}

func (r *ApplicationReconciler) patchAppStatus(ctx context.Context, app *paprikav1.Application) error {
	return r.patchAppStatusPreserving(ctx, app, true)
}

func (r *ApplicationReconciler) patchAppStatusAllowingReleaseRefClear(ctx context.Context, app *paprikav1.Application) error {
	return r.patchAppStatusPreserving(ctx, app, false)
}

func (r *ApplicationReconciler) patchAppStatusPreserving(ctx context.Context, app *paprikav1.Application, preserveReleaseRef bool) error {
	desiredStatus := app.Status.DeepCopy()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var fresh paprikav1.Application
		if err := r.client.Get(ctx, types.NamespacedName{Name: app.Name, Namespace: app.Namespace}, &fresh); err != nil {
			return fmt.Errorf("fetching application for status update: %w", err)
		}
		// Preserve fields that may be set concurrently by other actors (e.g.
		// ApplyBundle setting ReleaseRef, the Release controller's
		// syncApplicationGateStatus setting Gates) when the current reconcile did not
		// populate them.
		if preserveReleaseRef && desiredStatus.ReleaseRef == "" && fresh.Status.ReleaseRef != "" {
			desiredStatus.ReleaseRef = fresh.Status.ReleaseRef
			app.Status.ReleaseRef = fresh.Status.ReleaseRef
		}
		if len(desiredStatus.Gates) == 0 && len(fresh.Status.Gates) > 0 {
			desiredStatus.Gates = fresh.Status.Gates
			app.Status.Gates = fresh.Status.Gates
		}
		fresh.Status = *desiredStatus
		fresh.Status.ObservedGeneration = fresh.Generation
		if err := r.client.Status().Update(ctx, &fresh); err != nil {
			return fmt.Errorf("updating application status: %w", err)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("patching application status: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) reconcileAppPipeline(ctx context.Context, app *paprikav1.Application) (*ctrl.Result, error) {
	log := log.FromContext(ctx)
	if app.Spec.Build == nil || len(app.Spec.Build.Steps) == 0 {
		app.Status.PipelineRef = ""
		return nil, nil
	}

	if err := r.reconcilePipeline(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile Pipeline")
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "PipelineReconciliationFailed", err.Error())
		return nil, err
	}

	pipelinePhase := r.getPipelinePhase(ctx, app)
	switch pipelinePhase {
	case paprikav1.PipelineRunning:
		r.updatePhase(ctx, app, paprikav1.ApplicationBuilding, "PipelineRunning", fmt.Sprintf("pipeline phase: %s", pipelinePhase))
		return &ctrl.Result{RequeueAfter: defaultRequeue}, nil
	case paprikav1.PipelineFailed, paprikav1.PipelineCancelled:
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "PipelineFailed", "pipeline failed")
		return &ctrl.Result{}, nil
	case paprikav1.PipelineSucceeded:
		return nil, nil
	}
	return nil, nil
}

func buildTemplateSpec(app *paprikav1.Application) paprikav1.TemplateSpec {
	spec := paprikav1.TemplateSpec{
		Type:      string(app.Spec.Source.Type),
		Chart:     app.Spec.Source.Chart,
		Namespace: app.Namespace,
		RepoRef:   app.Spec.Source.RepoRef,
	}

	switch app.Spec.Source.Type {
	case paprikav1.SourceTypeGit:
		spec.Git = &paprikav1.GitSourceSpec{
			RepoURL:   app.Spec.Source.RepoURL,
			Revision:  app.Spec.Source.Revision,
			Path:      app.Spec.Source.Path,
			SecretRef: app.Spec.Source.SecretRef,
		}
	case paprikav1.SourceTypeS3:
		spec.S3 = &paprikav1.S3SourceSpec{
			Bucket:    app.Spec.Source.Bucket,
			Key:       app.Spec.Source.Key,
			Region:    app.Spec.Source.Region,
			Endpoint:  app.Spec.Source.Endpoint,
			Path:      app.Spec.Source.Path,
			SecretRef: app.Spec.Source.SecretRef,
		}
	case paprikav1.SourceTypeKustomize:
		spec.Kustomize = &paprikav1.KustomizeSourceSpec{
			Path: app.Spec.Source.Path,
		}
	case paprikav1.SourceTypeOCI:
		oci := app.Spec.Source.OCI
		//nolint:staticcheck // backward compatibility for deprecated Image field
		legacyImage := app.Spec.Source.Image
		if oci == nil && legacyImage != "" {
			oci = &paprikav1.OCISourceSpec{URL: legacyImage}
		}
		if oci != nil {
			secretRef := oci.SecretRef
			if secretRef == "" {
				secretRef = app.Spec.Source.SecretRef
			}
			spec.OCI = &paprikav1.OCISourceSpec{
				URL:       oci.URL,
				Tag:       oci.Tag,
				Insecure:  oci.Insecure || app.Spec.Source.Insecure,
				SecretRef: secretRef,
			}
		}
	}

	return spec
}

func (r *ApplicationReconciler) buildTemplateSpec(ctx context.Context, app *paprikav1.Application) paprikav1.TemplateSpec {
	spec := buildTemplateSpec(app)
	if app.Spec.Source.RepoRef == "" {
		return spec
	}
	resolver := repository.NewResolver(r.client)
	resolved, err := resolver.ResolveTemplate(ctx, app.Namespace, &spec)
	if err != nil {
		log.FromContext(ctx).Error(err, "Failed to resolve repository", "repoRef", app.Spec.Source.RepoRef)
		return spec
	}
	if resolved != nil {
		return resolved.Spec
	}
	return spec
}

func (r *ApplicationReconciler) reconcileTemplate(ctx context.Context, app *paprikav1.Application) error {
	templateName := app.Name + "-template"

	expected := &paprikav1.Template{
		ObjectMeta: metav1.ObjectMeta{
			Name:      templateName,
			Namespace: app.Namespace,
			Labels: withProjectLabels(app, map[string]string{
				engine.ApplicationNameLabelKey: app.Name,
			}),
		},
		Spec: r.buildTemplateSpec(ctx, app),
	}

	if err := ctrl.SetControllerReference(app, expected, r.Scheme); err != nil {
		return fmt.Errorf("failed to set controller reference on template: %w", err)
	}

	var existing paprikav1.Template
	err := r.client.Get(ctx, client.ObjectKeyFromObject(expected), &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get template: %w", err)
	}

	if err != nil {
		if err := r.client.Create(ctx, expected); err != nil {
			return fmt.Errorf("failed to create template: %w", err)
		}
	} else {
		existing.Spec = expected.Spec
		if len(existing.Labels) == 0 {
			existing.Labels = make(map[string]string)
		}
		for k, v := range expected.Labels {
			existing.Labels[k] = v
		}
		if err := r.client.Update(ctx, &existing); err != nil {
			return fmt.Errorf("failed to update template: %w", err)
		}
	}

	app.Status.TemplateRef = templateName
	app.Status.Synced = true
	return nil
}

func (r *ApplicationReconciler) reconcilePipeline(ctx context.Context, app *paprikav1.Application) error {
	pipelineName := app.Name + "-pipeline"

	build := app.Spec.Build
	steps := make([]paprikav1.PipelineStep, 0, len(build.Steps))
	for _, s := range build.Steps {
		steps = append(steps, paprikav1.PipelineStep{
			Name:    s.Name,
			Image:   s.Image,
			Script:  s.Script,
			Depends: s.Depends,
			Timeout: s.Timeout,
			Retry:   s.Retry,
		})
	}

	expected := &paprikav1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pipelineName,
			Namespace: app.Namespace,
			Labels: withProjectLabels(app, map[string]string{
				engine.ApplicationNameLabelKey: app.Name,
			}),
		},
		Spec: paprikav1.PipelineSpec{
			Sources:     build.Sources,
			Steps:       steps,
			MaxParallel: build.MaxParallel,
			Artifacts:   build.Artifacts,
		},
	}

	if err := ctrl.SetControllerReference(app, expected, r.Scheme); err != nil {
		return fmt.Errorf("failed to set controller reference on pipeline: %w", err)
	}

	var existing paprikav1.Pipeline
	err := r.client.Get(ctx, client.ObjectKeyFromObject(expected), &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get pipeline: %w", err)
	}

	if err != nil {
		if err := r.client.Create(ctx, expected); err != nil {
			return fmt.Errorf("failed to create pipeline: %w", err)
		}
	} else {
		existing.Spec = expected.Spec
		if len(existing.Labels) == 0 {
			existing.Labels = make(map[string]string)
		}
		for k, v := range expected.Labels {
			existing.Labels[k] = v
		}
		if err := r.client.Update(ctx, &existing); err != nil {
			return fmt.Errorf("failed to update pipeline: %w", err)
		}
	}

	app.Status.PipelineRef = pipelineName
	return nil
}

func (r *ApplicationReconciler) reconcileStages(ctx context.Context, app *paprikav1.Application) error {
	templateName := app.Name + "-template"
	stageRefs := make([]string, 0, len(app.Spec.Stages))

	for i := range app.Spec.Stages {
		stageName := app.Name + "-" + app.Spec.Stages[i].Name
		if err := r.reconcileSingleStage(ctx, app, &app.Spec.Stages[i], templateName, stageName); err != nil {
			return fmt.Errorf("reconcile stage %s: %w", stageName, err)
		}
		stageRefs = append(stageRefs, stageName)
	}

	app.Status.StageRefs = stageRefs
	return nil
}

func (r *ApplicationReconciler) reconcileSingleStage(ctx context.Context, app *paprikav1.Application, promotionStage *paprikav1.ApplicationPromotionStage, templateName, stageName string) error {
	strategy := r.resolveStageStrategy(app, promotionStage)
	stageCanary := r.resolveStageCanary(promotionStage, strategy)

	expected := r.buildStageSpec(app, promotionStage, templateName, stageName, stageCanary)
	if err := ctrl.SetControllerReference(app, expected, r.Scheme); err != nil {
		return fmt.Errorf("failed to set controller reference on stage %s: %w", stageName, err)
	}

	var existing paprikav1.Stage
	err := r.client.Get(ctx, types.NamespacedName{Name: stageName, Namespace: app.Namespace}, &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get stage %s: %w", stageName, err)
	}

	if err != nil {
		return r.createStage(ctx, expected, stageName)
	}
	return r.updateStage(ctx, &existing, expected, stageName)
}

func (r *ApplicationReconciler) resolveStageStrategy(app *paprikav1.Application, promotionStage *paprikav1.ApplicationPromotionStage) paprikav1.DeliveryStrategy {
	if promotionStage.Strategy != nil {
		return *promotionStage.Strategy
	}
	return app.Spec.Strategy
}

func (r *ApplicationReconciler) resolveStageCanary(promotionStage *paprikav1.ApplicationPromotionStage, strategy paprikav1.DeliveryStrategy) *paprikav1.CanaryConfig {
	canaryConfig := promotionStage.Canary
	if strategy == paprikav1.StrategyCanary && canaryConfig != nil {
		return canaryConfig
	}
	return nil
}

func (r *ApplicationReconciler) buildStageSpec(app *paprikav1.Application, promotionStage *paprikav1.ApplicationPromotionStage, templateName, stageName string, stageCanary *paprikav1.CanaryConfig) *paprikav1.Stage {
	templates := []string{templateName}
	if r.isInlineSource(app) {
		templates = []string{}
	}
	return &paprikav1.Stage{
		ObjectMeta: metav1.ObjectMeta{
			Name:      stageName,
			Namespace: app.Namespace,
			Labels: withProjectLabels(app, map[string]string{
				engine.ManagedByLabelKey:       engine.ManagedByLabelValue,
				engine.ApplicationNameLabelKey: app.Name,
				"app.paprika.io/ring":          strconv.Itoa(int(promotionStage.Ring)),
			}),
		},
		Spec: paprikav1.StageSpec{
			Name:          promotionStage.Name,
			Ring:          promotionStage.Ring,
			Cluster:       promotionStage.Cluster,
			Templates:     templates,
			Gates:         promotionStage.Gates,
			ApprovalGates: promotionStage.ApprovalGates,
			Canary:        stageCanary,
		},
	}
}

func (r *ApplicationReconciler) createStage(ctx context.Context, expected *paprikav1.Stage, stageName string) error {
	if err := r.client.Create(ctx, expected); err != nil {
		return fmt.Errorf("failed to create stage %s: %w", stageName, err)
	}
	return nil
}

func (r *ApplicationReconciler) updateStage(ctx context.Context, existing, expected *paprikav1.Stage, stageName string) error {
	if err := updateStageApplicationOwner(existing, expected); err != nil {
		return fmt.Errorf("failed to update stage %s owner: %w", stageName, err)
	}
	existing.Spec = expected.Spec
	if len(existing.Labels) == 0 {
		existing.Labels = make(map[string]string)
	}
	for k, v := range expected.Labels {
		existing.Labels[k] = v
	}
	if err := r.client.Update(ctx, existing); err != nil {
		return fmt.Errorf("failed to update stage %s: %w", stageName, err)
	}
	return nil
}

//nolint:cyclop // owner reconciliation explicitly preserves unrelated non-controller references.
func updateStageApplicationOwner(existing, expected *paprikav1.Stage) error {
	var desired *metav1.OwnerReference
	for i := range expected.OwnerReferences {
		if expected.OwnerReferences[i].Controller != nil && *expected.OwnerReferences[i].Controller {
			if desired != nil {
				return errors.New("expected stage has multiple controller owners")
			}
			desired = &expected.OwnerReferences[i]
		}
	}
	if desired == nil {
		return errors.New("expected stage is missing its application controller owner")
	}

	controllerIndex := -1
	for i := range existing.OwnerReferences {
		if existing.OwnerReferences[i].Controller == nil || !*existing.OwnerReferences[i].Controller {
			continue
		}
		if controllerIndex >= 0 {
			return errors.New("existing stage has multiple controller owners")
		}
		controllerIndex = i
	}
	if controllerIndex >= 0 && !sameStageApplicationOwnerIdentity(existing.OwnerReferences[controllerIndex], *desired) {
		return errors.New("existing stage is controlled by another resource")
	}

	replacement := make([]metav1.OwnerReference, 0, len(existing.OwnerReferences)+1)
	inserted := false
	for i := range existing.OwnerReferences {
		if sameStageApplicationOwnerIdentity(existing.OwnerReferences[i], *desired) {
			if !inserted {
				replacement = append(replacement, *desired)
				inserted = true
			}
			continue
		}
		replacement = append(replacement, existing.OwnerReferences[i])
	}
	if !inserted {
		replacement = append(replacement, *desired)
	}
	existing.OwnerReferences = replacement
	return nil
}

//nolint:gocritic // owner references are small immutable identity values here.
func sameStageApplicationOwnerIdentity(left, right metav1.OwnerReference) bool {
	if left.Kind != right.Kind || left.Name != right.Name {
		return false
	}
	if left.APIVersion == right.APIVersion {
		return true
	}
	leftGroup, _, leftHasVersion := strings.Cut(left.APIVersion, "/")
	rightGroup, _, rightHasVersion := strings.Cut(right.APIVersion, "/")
	return leftHasVersion && rightHasVersion && leftGroup == rightGroup
}

//nolint:cyclop // stage/release branching is inherent to the reconcile flow.
func (r *ApplicationReconciler) reconcileRelease(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	manualOverride := app.Annotations[manualSyncAnnotation] != ""
	defer func() {
		if manualOverride {
			if perr := r.clearManualSyncAnnotation(ctx, app); perr != nil {
				log.FromContext(ctx).Error(perr, "Failed to clear manual sync annotation", "app", app.Name)
			}
		}
	}()

	if len(app.Spec.Stages) == 0 {
		return ctrl.Result{}, nil
	}

	if r.isInlineSource(app) && app.Status.ReleaseRef == "" {
		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingInlineRelease", "waiting for ApplyBundle to create release")
		if err := r.patchAppStatus(ctx, app); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to patch application status: %w", err)
		}
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}

	targetStage := &app.Spec.Stages[0]
	currentReleasePhase := r.getCurrentReleasePhase(ctx, app)

	if currentReleasePhase != "" {
		return r.handleActiveRelease(ctx, app, targetStage, currentReleasePhase)
	}

	if r.isInlineSource(app) && app.Status.ReleaseRef != "" {
		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingInlineRelease", "waiting for referenced inline release to start")
		if err := r.patchAppStatus(ctx, app); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to patch application status: %w", err)
		}
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}

	if !manualOverride && app.Spec.SyncPolicy == paprikav1.SyncAuto && len(app.Spec.SyncWindows) > 0 {
		if allowed, res := r.syncWindowAllows(ctx, app, targetStage.Name, false); !allowed {
			r.setSyncWindowCondition(app, metav1.ConditionFalse, syncWindowReason(res), res.Reason)
			r.updatePhase(ctx, app, paprikav1.ApplicationPending, "SyncWindowBlocked", res.Reason)
			return ctrl.Result{RequeueAfter: r.syncWindowRequeueAfter(res.NextTransition)}, nil
		}
	}

	if app.Spec.SyncPolicy == paprikav1.SyncManual {
		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingManualSync", "syncPolicy is Manual")
		return ctrl.Result{}, nil
	}

	release := r.buildRelease(app, targetStage)
	if err := ctrl.SetControllerReference(app, release, r.Scheme); err != nil {
		return ctrl.Result{}, fmt.Errorf("failed to set controller reference on release: %w", err)
	}

	if err := r.client.Create(ctx, release); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return r.adoptExistingRelease(ctx, app, targetStage, release.Name)
		}
		return ctrl.Result{}, fmt.Errorf("failed to create release: %w", err)
	}

	app.Status.ReleaseRef = release.Name
	r.updatePhase(ctx, app, paprikav1.ApplicationPromoting, "ReleaseCreated", "created release for stage "+targetStage.Name)
	return ctrl.Result{}, nil
}

func (r *ApplicationReconciler) adoptExistingRelease(ctx context.Context, app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage, releaseName string) (ctrl.Result, error) {
	var release paprikav1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: releaseName, Namespace: app.Namespace}, &release); err != nil {
		return ctrl.Result{}, fmt.Errorf("get existing release after create conflict: %w", err)
	}

	app.Status.ReleaseRef = releaseName
	if applicationReleasePhaseTerminal(release.Status.Phase) {
		if err := r.requestReleaseResync(ctx, app.Namespace, releaseName); err != nil {
			return ctrl.Result{}, err
		}
		r.setApplicationPhase(ctx, app, paprikav1.ApplicationPending, "ReleaseResync", "existing terminal release was marked for resync")
		if err := r.patchAppStatus(ctx, app); err != nil {
			return ctrl.Result{}, fmt.Errorf("patch application status for existing release adoption: %w", err)
		}
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}

	if release.Status.Phase != "" {
		return r.handleActiveRelease(ctx, app, targetStage, release.Status.Phase)
	}

	r.setApplicationPhase(ctx, app, paprikav1.ApplicationPromoting, "ReleaseAdopted", "adopted existing release for stage "+targetStage.Name)
	if err := r.patchAppStatus(ctx, app); err != nil {
		return ctrl.Result{}, fmt.Errorf("patch application status for existing release adoption: %w", err)
	}
	return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}

func (r *ApplicationReconciler) handleActiveRelease(ctx context.Context, app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage, phase paprikav1.ReleasePhase) (ctrl.Result, error) {
	phaseMap := map[paprikav1.ReleasePhase]struct {
		appPhase paprikav1.ApplicationPhase
		reason   string
		requeue  bool
	}{
		paprikav1.ReleasePending:          {paprikav1.ApplicationPromoting, "ReleasePromoting", true},
		paprikav1.ReleasePromoting:        {paprikav1.ApplicationPromoting, "ReleasePromoting", true},
		paprikav1.ReleaseAwaitingApproval: {paprikav1.ApplicationPromoting, "ReleaseAwaitingApproval", true},
		paprikav1.ReleaseCanarying:        {paprikav1.ApplicationCanarying, "ReleaseCanarying", true},
		paprikav1.ReleaseVerifying:        {paprikav1.ApplicationVerifying, "ReleaseVerifying", true},
		paprikav1.ReleaseComplete:         {paprikav1.ApplicationHealthy, "ReleaseComplete", false},
		paprikav1.ReleaseFailed:           {paprikav1.ApplicationDegraded, "ReleaseFailed", true},
		paprikav1.ReleaseRolledBack:       {paprikav1.ApplicationRolledBack, "ReleaseRolledBack", true},
	}

	mapping, ok := phaseMap[phase]
	if !ok {
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}

	msg := mapping.reason + " on stage " + targetStage.Name
	r.updatePhase(ctx, app, mapping.appPhase, mapping.reason, msg)

	if mapping.requeue {
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}
	return ctrl.Result{}, nil
}

func (r *ApplicationReconciler) buildRelease(app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage) *paprikav1.Release {
	stableReleaseName := stableApplicationReleaseName(app.Name)
	releaseName := applicationReleaseName(app, targetStage)
	stageName := app.Name + "-" + targetStage.Name
	pipelineName := app.Name + "-pipeline"
	if app.Status.PipelineRef == "" {
		pipelineName = ""
	}

	params := releaseParameters(app, targetStage, stableReleaseName)

	annotations := map[string]string{}
	if app.Status.SourceHash != "" {
		annotations[sourceHashAnnotation] = app.Status.SourceHash
	}
	if app.Status.SourceRevision != "" {
		annotations[sourceRevisionAnnotation] = app.Status.SourceRevision
	}

	return &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:        releaseName,
			Namespace:   app.Namespace,
			Annotations: annotations,
			Labels: withProjectLabels(app, map[string]string{
				engine.ManagedByLabelKey:       engine.ManagedByLabelValue,
				engine.ApplicationNameLabelKey: app.Name,
				releaseLabelKey:                releaseName,
			}),
		},
		Spec: paprikav1.ReleaseSpec{
			Pipeline:    pipelineName,
			Target:      stageName,
			Verify:      targetStage.Gates,
			OnFailure:   app.Spec.OnFailure,
			Parameters:  params,
			SyncOptions: app.Spec.SyncOptions,
		},
	}
}

func stableApplicationReleaseName(appName string) string {
	return truncateKubernetesName(appName + "-release")
}

func applicationReleaseName(app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage) string {
	base := stableApplicationReleaseName(app.Name)
	identity := releaseIdentity(app, targetStage, base)
	if identity == "" {
		return base
	}
	sum := sha256.Sum256([]byte(identity))
	suffix := hex.EncodeToString(sum[:])[:10]
	return addNameSuffix(base, suffix)
}

func releaseIdentity(app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage, stableReleaseName string) string {
	if !hasReleaseIdentityInput(app, targetStage) {
		return ""
	}

	var b strings.Builder
	appendIdentityField(&b, "sourceHash", app.Status.SourceHash)
	appendIdentityField(&b, "sourceRevision", app.Status.SourceRevision)
	if targetStage != nil {
		appendIdentityField(&b, "stage", targetStage.Name)
	}
	writeReleaseParametersIdentity(&b, releaseParameters(app, targetStage, stableReleaseName))
	return b.String()
}

func hasReleaseIdentityInput(app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage) bool {
	hasSourceIdentity := app.Status.SourceHash != "" || app.Status.SourceRevision != ""
	return hasSourceIdentity || len(app.Spec.Parameters) > 0 || (targetStage != nil && len(targetStage.Parameters) > 0)
}

func appendIdentityField(b *strings.Builder, key, value string) {
	if value == "" {
		return
	}
	b.WriteString(key)
	b.WriteByte('=')
	b.WriteString(value)
	b.WriteByte('\n')
}

func writeReleaseParametersIdentity(b *strings.Builder, params map[string]string) {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		b.WriteString("param:")
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(params[k])
		b.WriteByte('\n')
	}
}

func releaseParameters(app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage, stableReleaseName string) map[string]string {
	params := make(map[string]string, len(app.Spec.Parameters))
	for k, v := range app.Spec.Parameters {
		params[k] = v
	}
	if targetStage != nil {
		for k, v := range targetStage.Parameters {
			params[k] = v
		}
	}
	if _, ok := params["release-name"]; !ok {
		params["release-name"] = stableReleaseName
	}
	return params
}

func releaseIdentityChanged(app *paprikav1.Application) (changed bool, desiredRelease string) {
	if app.Status.ReleaseRef == "" || len(app.Spec.Stages) == 0 {
		return false, ""
	}
	desiredRelease = applicationReleaseName(app, &app.Spec.Stages[0])
	return desiredRelease != "" && app.Status.ReleaseRef != desiredRelease, desiredRelease
}

func addNameSuffix(base, suffix string) string {
	if suffix == "" {
		return truncateKubernetesName(base)
	}
	maxBaseLen := maxKubernetesNameLength - len(suffix) - 1
	if maxBaseLen < 1 {
		return truncateKubernetesName(suffix)
	}
	if len(base) > maxBaseLen {
		base = strings.TrimRight(base[:maxBaseLen], "-")
	}
	return base + "-" + suffix
}

func truncateKubernetesName(name string) string {
	if len(name) <= maxKubernetesNameLength {
		return strings.TrimRight(name, "-")
	}
	return strings.TrimRight(name[:maxKubernetesNameLength], "-")
}

func (r *ApplicationReconciler) getCurrentReleasePhase(ctx context.Context, app *paprikav1.Application) paprikav1.ReleasePhase {
	if app.Status.ReleaseRef == "" {
		return ""
	}

	var release paprikav1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		return ""
	}

	return release.Status.Phase
}

func (r *ApplicationReconciler) getPipelinePhase(ctx context.Context, app *paprikav1.Application) paprikav1.PipelinePhase {
	if app.Status.PipelineRef == "" {
		return paprikav1.PipelineSucceeded
	}

	var pipeline paprikav1.Pipeline
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.PipelineRef, Namespace: app.Namespace}, &pipeline); err != nil {
		return ""
	}

	return pipeline.Status.Phase
}

func (r *ApplicationReconciler) updatePhase(ctx context.Context, app *paprikav1.Application, phase paprikav1.ApplicationPhase, reason, message string) {
	log := log.FromContext(ctx)

	if !r.setApplicationPhase(ctx, app, phase, reason, message) {
		return
	}
	if err := r.patchAppStatus(ctx, app); err != nil {
		log.Error(err, "Failed to update application status", "phase", phase)
	}
}

func (r *ApplicationReconciler) setApplicationPhase(ctx context.Context, app *paprikav1.Application, phase paprikav1.ApplicationPhase, reason, message string) bool {
	if app.Status.Phase == phase {
		return false
	}

	previousPhase := app.Status.Phase
	app.Status.Phase = phase
	metrics.ApplicationPhaseTotal.WithLabelValues(app.Name, app.Namespace, string(phase)).Inc()
	app.Status.Conditions = append(app.Status.Conditions, metav1.Condition{
		Type:               string(phase),
		Status:             metav1.ConditionTrue,
		LastTransitionTime: metav1.Now(),
		Reason:             reason,
		Message:            message,
	})

	for i := range app.Spec.Stages {
		releasePhase := string(r.getCurrentReleasePhase(ctx, app))
		if releasePhase == "" {
			releasePhase = "Pending"
		}

		s := &app.Spec.Stages[i]
		var found bool
		for j := range app.Status.Stages {
			if app.Status.Stages[j].Name != s.Name {
				continue
			}
			app.Status.Stages[j].Phase = releasePhase
			now := metav1.Now()
			app.Status.Stages[j].UpdatedAt = &now
			found = true
			break
		}
		if !found {
			now := metav1.Now()
			app.Status.Stages = append(app.Status.Stages, paprikav1.ApplicationStageStatus{
				Name:      s.Name,
				Ring:      s.Ring,
				Phase:     releasePhase,
				UpdatedAt: &now,
			})
		}
	}

	r.publishApplicationEvent(ctx, app, reason, previousPhase, message)
	return true
}

func (r *ApplicationReconciler) publishApplicationEvent(ctx context.Context, app *paprikav1.Application, reason string, previousPhase paprikav1.ApplicationPhase, message string) {
	if r.EventBroker == nil {
		return
	}
	evt, err := events.NewEvent(events.TypeApplication, events.EventPayload{
		ResourceType:  events.TypeApplication,
		Name:          app.Name,
		Namespace:     app.Namespace,
		Phase:         string(app.Status.Phase),
		PreviousPhase: string(previousPhase),
		Reason:        reason,
		Message:       message,
		Timestamp:     r.now().UTC().Format(time.RFC3339),
	}, r.Clock)
	if err != nil {
		log.FromContext(ctx).Error(err, "Failed to create application event", "app", app.Name)
		return
	}
	r.EventBroker.Publish(ctx, events.TopicDashboard, evt)
}

func (r *ApplicationReconciler) checkSourceChanged(ctx context.Context, app *paprikav1.Application) (bool, error) {
	log := log.FromContext(ctx)
	newHash, newRevision, err := r.resolveSourceHash(ctx, app)
	if err != nil {
		return false, err
	}

	if newHash == "" && newRevision == "" {
		log.Info("Source identity check returned empty result", "namespace", app.Namespace, "name", app.Name)
		return false, nil
	}

	oldHash := app.Status.SourceHash
	oldRevision := app.Status.SourceRevision
	changed := oldHash != "" && oldHash != newHash

	app.Status.SourceHash = newHash
	app.Status.SourceRevision = newRevision
	if err := r.patchAppStatus(ctx, app); err != nil {
		return false, fmt.Errorf("failed to update source hash: %w", err)
	}

	log.Info("Source identity checked",
		"namespace", app.Namespace,
		"name", app.Name,
		"oldHash", oldHash,
		"newHash", newHash,
		"oldRevision", oldRevision,
		"newRevision", newRevision,
		"changed", changed)

	if oldHash == "" {
		return false, nil
	}

	return changed, nil
}

func (r *ApplicationReconciler) resolveSourceHash(ctx context.Context, app *paprikav1.Application) (hash, revision string, err error) {
	if r.isInlineSource(app) {
		return "", "", nil
	}

	if app.Spec.Source.Type == paprikav1.SourceTypeGit || app.Spec.Source.Type == paprikav1.SourceTypeS3 || app.Spec.Source.Type == paprikav1.SourceTypeKustomize || app.Spec.Source.Type == paprikav1.SourceTypeOCI {
		renderer := r.TemplateRenderer
		if renderer == nil {
			renderer = engine.NewHelmSDKRendererWithClient(r.WorkDir, r.client)
		}

		templateName := app.Name + "-template"
		var tmpl paprikav1.Template
		if getErr := r.client.Get(ctx, types.NamespacedName{Name: templateName, Namespace: app.Namespace}, &tmpl); getErr != nil {
			return "", "", fmt.Errorf("failed to get template for source check: %w", getErr)
		}

		result, resolveErr := renderer.ResolveSource(ctx, &tmpl)
		if resolveErr != nil {
			return "", "", fmt.Errorf("resolve source: %w", resolveErr)
		}

		if result != nil {
			return result.Hash, result.Revision, nil
		}
	}

	// For helm/local sources, compute a stable hash from the chart config.
	h := sha256.Sum256([]byte(app.Spec.Source.Chart.Path + app.Spec.Source.Chart.Repo + app.Spec.Source.Chart.Name))
	return hex.EncodeToString(h[:]), "", nil
}

func (r *ApplicationReconciler) evaluateHealth(ctx context.Context, app *paprikav1.Application) {
	log := log.FromContext(ctx)

	if len(app.Spec.HealthChecks) == 0 || r.HealthEval == nil {
		return
	}

	previous := healthResultsByName(app.Status.HealthChecks)
	results := make([]paprikav1.HealthCheckResult, 0, len(app.Spec.HealthChecks))
	evalResults := make([]health.EvalResult, 0, len(app.Spec.HealthChecks))

	now := metav1.Time{Time: r.currentTime()}
	for _, check := range app.Spec.HealthChecks {
		if prev, ok := previous[check.Name]; ok && healthCheckResultFresh(prev, check.Interval, now.Time) {
			results = append(results, *prev)
			evalResults = append(evalResults, evalResultFromHealthCheckResult(prev))
			continue
		}

		result := r.HealthEval.Evaluate(ctx, check, app)
		evalResults = append(evalResults, result)
		hcr := paprikav1.HealthCheckResult{
			Name:      result.Name,
			Status:    result.Status,
			Message:   result.Message,
			CheckedAt: &now,
		}
		if result.HTTPResult != nil {
			hcr.HTTPStatusCode = result.HTTPResult.StatusCode
			hcr.HTTPBody = result.HTTPResult.Body
		}
		results = append(results, hcr)
		log.Info("Health check evaluated", "check", result.Name, "status", result.Status, "message", result.Message)
	}

	app.Status.HealthChecks = results
	app.Status.Health = health.AggregateHealth(evalResults)
}

func healthResultsByName(results []paprikav1.HealthCheckResult) map[string]*paprikav1.HealthCheckResult {
	byName := make(map[string]*paprikav1.HealthCheckResult, len(results))
	for i := range results {
		result := &results[i]
		byName[result.Name] = result
	}
	return byName
}

func healthCheckResultFresh(result *paprikav1.HealthCheckResult, interval string, now time.Time) bool {
	if result == nil {
		return false
	}
	if result.CheckedAt == nil {
		return false
	}
	return now.Sub(result.CheckedAt.Time) < applicationHealthCheckInterval(interval)
}

func applicationHealthCheckInterval(interval string) time.Duration {
	if interval == "" {
		return defaultHealthCheckInterval
	}
	d, err := time.ParseDuration(interval)
	if err != nil || d <= 0 {
		return defaultHealthCheckInterval
	}
	return d
}

func evalResultFromHealthCheckResult(result *paprikav1.HealthCheckResult) health.EvalResult {
	eval := health.EvalResult{
		Name:    result.Name,
		Status:  result.Status,
		Message: result.Message,
	}
	if result.HTTPStatusCode != 0 || result.HTTPBody != "" {
		eval.HTTPResult = &health.HTTPResult{
			StatusCode: result.HTTPStatusCode,
			Body:       result.HTTPBody,
		}
	}
	return eval
}

func (r *ApplicationReconciler) evaluateDiff(ctx context.Context, app *paprikav1.Application) {
	log := log.FromContext(ctx)

	if r.DiffEngine == nil {
		return
	}

	manifests, err := r.desiredManifests(ctx, app)
	if err != nil {
		log.Error(err, "Failed to get desired manifests for diff")
		return
	}

	desired := parseDesiredManifests(manifests, app.Namespace)

	labelSelector := engine.ManagedByAppSelector(app.Name).String()
	result, err := r.DiffEngine.ComputeDiff(ctx, desired, &engine.DiffOptions{
		Namespace:       app.Namespace,
		LabelSelector:   labelSelector,
		ApplicationName: app.Name,
	})
	if err != nil {
		log.Error(err, "Failed to compute diff")
		return
	}

	app.Status.Resources = convertDiffToResourceSyncs(result.ResourceSyncs())
	app.Status.OutOfSync = result.OutOfSyncCount()
	app.Status.PrunedResources = len(result.Deleted)

	if app.Status.ReleaseRef == "" {
		app.Status.HookStatuses = nil
	} else {
		var activeRelease paprikav1.Release
		if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &activeRelease); err == nil {
			app.Status.HookStatuses = activeRelease.Status.HookStatuses
		} else if apierrors.IsNotFound(err) {
			app.Status.HookStatuses = nil
		} else {
			log.Error(err, "Failed to fetch active Release for hook status propagation")
			app.Status.HookStatuses = nil
		}
	}
}

// parseDesiredManifests splits rendered YAML manifests into unstructured objects,
// defaulting any empty namespace to the application's namespace so that diff
// keys match the live (namespaced) resources.
func parseDesiredManifests(manifests []byte, namespace string) []unstructured.Unstructured {
	docs := engine.SplitYAMLDocuments(manifests)
	desired := make([]unstructured.Unstructured, 0, len(docs))
	for _, doc := range docs {
		var obj map[string]interface{}
		if err := yaml.Unmarshal(doc, &obj); err != nil || obj == nil {
			continue
		}
		u := unstructured.Unstructured{Object: obj}
		if u.GetNamespace() == "" {
			u.SetNamespace(namespace)
		}
		desired = append(desired, u)
	}
	return desired
}

func (r *ApplicationReconciler) desiredManifests(ctx context.Context, app *paprikav1.Application) ([]byte, error) {
	if r.isInlineSource(app) {
		return r.loadInlineManifests(ctx, app)
	}

	templateName := app.Name + "-template"
	var tmpl paprikav1.Template
	if err := r.client.Get(ctx, types.NamespacedName{Name: templateName, Namespace: app.Namespace}, &tmpl); err != nil {
		return nil, fmt.Errorf("get template for diff: %w", err)
	}

	renderer := r.TemplateRenderer
	if renderer == nil {
		renderer = engine.NewHelmSDKRendererWithClient(r.WorkDir, r.client)
	}

	renderCtx := r.desiredManifestRenderContext(ctx, app)
	stampTemplateSourceIdentity(&tmpl, renderCtx.sourceHash, renderCtx.sourceRevision)

	manifests, err := renderer.Render(ctx, &tmpl, renderCtx.params)
	if err != nil {
		return nil, fmt.Errorf("render template for diff: %w", err)
	}
	return manifests, nil
}

type desiredManifestRenderContext struct {
	params         map[string]string
	releaseName    string
	sourceHash     string
	sourceRevision string
}

func (r *ApplicationReconciler) desiredManifestRenderContext(ctx context.Context, app *paprikav1.Application) desiredManifestRenderContext {
	params := make(map[string]string, len(app.Spec.Parameters)+1)
	for k, v := range app.Spec.Parameters {
		params[k] = v
	}
	renderCtx := desiredManifestRenderContext{
		params:         params,
		releaseName:    app.Name + "-release",
		sourceHash:     app.Status.SourceHash,
		sourceRevision: app.Status.SourceRevision,
	}
	if app.Status.ReleaseRef != "" {
		renderCtx.releaseName = app.Status.ReleaseRef
		var activeRelease paprikav1.Release
		if err := r.client.Get(ctx, types.NamespacedName{Name: renderCtx.releaseName, Namespace: app.Namespace}, &activeRelease); err == nil {
			mergeActiveReleaseRenderContext(&renderCtx, &activeRelease)
		}
	}
	if _, ok := renderCtx.params["release-name"]; !ok {
		renderCtx.params["release-name"] = renderCtx.releaseName
	}
	return renderCtx
}

func mergeActiveReleaseRenderContext(renderCtx *desiredManifestRenderContext, release *paprikav1.Release) {
	for k, v := range release.Spec.Parameters {
		renderCtx.params[k] = v
	}
	if hash := release.Annotations[sourceHashAnnotation]; hash != "" {
		renderCtx.sourceHash = hash
	}
	if revision := release.Annotations[sourceRevisionAnnotation]; revision != "" {
		renderCtx.sourceRevision = revision
	}
}

func (r *ApplicationReconciler) loadInlineManifests(ctx context.Context, app *paprikav1.Application) ([]byte, error) {
	if app.Status.ReleaseRef == "" {
		return nil, errors.New("no active release for inline source")
	}
	var release paprikav1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		return nil, fmt.Errorf("get release for inline manifests: %w", err)
	}
	snapshotName := release.Status.RenderedManifestSnapshot
	if snapshotName == "" && release.Spec.ManifestSource != nil {
		snapshotName = release.Spec.ManifestSource.ConfigMapRef
	}
	if snapshotName == "" {
		return nil, errors.New("release has no manifest snapshot")
	}
	var cm corev1.ConfigMap
	if err := r.client.Get(ctx, types.NamespacedName{Name: snapshotName, Namespace: app.Namespace}, &cm); err != nil {
		return nil, fmt.Errorf("get manifest snapshot: %w", err)
	}
	data, ok := cm.Data["manifests.yaml"]
	if !ok {
		return nil, fmt.Errorf("snapshot %q missing manifests.yaml", snapshotName)
	}
	return []byte(data), nil
}

func convertDiffToResourceSyncs(diffs []engine.ResourceDiff) []paprikav1.ResourceSync {
	syncs := make([]paprikav1.ResourceSync, 0, len(diffs))
	for _, d := range diffs {
		syncs = append(syncs, paprikav1.ResourceSync{
			Kind:      d.Kind,
			Name:      d.Name,
			Namespace: d.Namespace,
			Status:    d.Action,
		})
	}
	return syncs
}

func (r *ApplicationReconciler) evaluateResourceHealth(ctx context.Context, app *paprikav1.Application) {
	if r.ResHealth == nil {
		return
	}

	var healthResults []paprikav1.ResourceHealth
	for _, rs := range app.Status.Resources {
		// Skip resources that are no longer desired; health is only meaningful for
		// managed resources regardless of whether they are currently in sync.
		if rs.Status == "Pruned" {
			continue
		}
		h := r.ResHealth.Check(ctx, rs.Kind, rs.Name, rs.Namespace)
		healthResults = append(healthResults, h)
	}

	app.Status.ResourceHealth = healthResults
}

func (r *ApplicationReconciler) pruneReleaseHistory(ctx context.Context, app *paprikav1.Application) error {
	log := log.FromContext(ctx)

	var list paprikav1.ReleaseList
	if err := r.client.List(ctx, &list,
		client.InNamespace(app.Namespace),
		client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name},
	); err != nil {
		return fmt.Errorf("list releases for pruning: %w", err)
	}

	if len(list.Items) <= maxReleaseHistory {
		return nil
	}

	activeRelease := app.Status.ReleaseRef
	var superseded []paprikav1.Release
	for i := range list.Items {
		rel := &list.Items[i]
		if rel.Name == activeRelease {
			continue
		}
		if rel.Status.Phase == paprikav1.ReleaseSuperseded {
			superseded = append(superseded, *rel)
		}
	}

	sortReleasesByTimestamp(superseded)
	toDelete := len(list.Items) - maxReleaseHistory
	if toDelete > len(superseded) {
		toDelete = len(superseded)
	}

	for i := 0; i < toDelete; i++ {
		rel := &superseded[i]
		if rel.Name == activeRelease {
			continue
		}
		if err := r.client.Delete(ctx, rel); client.IgnoreNotFound(err) != nil {
			log.Error(err, "Failed to prune old release", "release", rel.Name)
			continue
		}
		log.Info("Pruned old superseded release", "release", rel.Name)
	}
	return nil
}

func sortReleasesByTimestamp(releases []paprikav1.Release) {
	for i := range releases {
		for j := i + 1; j < len(releases); j++ {
			if releases[j].CreationTimestamp.Before(&releases[i].CreationTimestamp) {
				releases[i], releases[j] = releases[j], releases[i]
			}
		}
	}
}

func (r *ApplicationReconciler) getTargetStage(app *paprikav1.Application) string {
	if len(app.Spec.Stages) == 0 {
		return ""
	}
	return app.Spec.Stages[0].Name
}

// SetupWithManager sets up the controller with the Manager.
func (r *ApplicationReconciler) handleHealthyPhase(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	r.pruneReleasesIfInline(ctx, app)

	if app.Status.ReleaseRef != "" {
		phase := r.getCurrentReleasePhase(ctx, app)
		if phase == paprikav1.ReleaseSuperseded {
			log.Info("Active release is superseded, creating replacement release", "release", app.Status.ReleaseRef)
			return r.startNewReleaseFlow(ctx, app, false, "ReleaseSuperseded", "active release was superseded, creating a replacement")
		}
		if phase == paprikav1.ReleaseRolledBack {
			log.Info("Active release is rolled back, creating replacement release", "release", app.Status.ReleaseRef)
			return r.startNewReleaseFlow(ctx, app, false, "ReleaseRolledBack", "active release was rolled back, creating a replacement")
		}
	}

	pollInterval := defaultRequeue
	if app.Spec.Source.PollInterval != "" {
		if d, err := time.ParseDuration(app.Spec.Source.PollInterval); err == nil {
			pollInterval = d
		}
	}
	sourceChanged, err := r.checkSourceChanged(ctx, app)
	if err != nil {
		log.Error(err, "Failed to check source changes")
		return ctrl.Result{RequeueAfter: pollInterval}, nil
	}
	if sourceChanged {
		log.Info("Source change detected, triggering re-sync", "app", app.Name)
		return r.startNewReleaseFlow(ctx, app, false, "SourceChanged", "source hash changed, creating a new release")
	}
	if changed, desiredRelease := releaseIdentityChanged(app); changed {
		log.Info("Release identity changed, triggering re-sync", "app", app.Name, "currentRelease", app.Status.ReleaseRef, "desiredRelease", desiredRelease)
		return r.startNewReleaseFlow(ctx, app, false, "ReleaseSpecChanged", "release parameters changed, creating a new release")
	}

	return r.evaluateHealthyApplication(ctx, app, pollInterval)
}

func (r *ApplicationReconciler) evaluateHealthyApplication(ctx context.Context, app *paprikav1.Application, pollInterval time.Duration) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	r.evaluateHealth(ctx, app)
	r.evaluateDiff(ctx, app)
	r.evaluateResourceHealth(ctx, app)
	if err := r.reconcileAnalysisRuns(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile analysis runs")
	}
	if err := r.reconcileSelfHeal(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile self-heal")
	}
	if err := r.patchAppStatus(ctx, app); err != nil {
		log.Error(err, "Failed to update application status in Healthy phase")
	}

	return ctrl.Result{RequeueAfter: pollInterval}, nil
}

func (r *ApplicationReconciler) startNewReleaseFlow(ctx context.Context, app *paprikav1.Application, manual bool, reason, message string) (ctrl.Result, error) {
	log := log.FromContext(ctx)
	targetStage := r.getTargetStage(app)
	if allowed, res := r.syncWindowAllows(ctx, app, targetStage, manual); !allowed {
		msg := "Source change detected but " + res.Reason
		log.Info(msg, "app", app.Name)
		r.setSyncWindowCondition(app, metav1.ConditionFalse, syncWindowReason(res), msg)
		if err := r.patchAppStatus(ctx, app); err != nil {
			log.Error(err, "Failed to patch sync-window status")
		}
		return ctrl.Result{RequeueAfter: r.syncWindowRequeueAfter(res.NextTransition)}, nil
	}

	r.setSyncWindowCondition(app, metav1.ConditionTrue, "Allowed", "Source change within sync window")
	if err := r.supersedeCurrentRelease(ctx, app); err != nil {
		return ctrl.Result{}, fmt.Errorf("supersede current release: %w", err)
	}
	if app.Status.ReleaseRef != "" {
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}
	r.setApplicationPhase(ctx, app, paprikav1.ApplicationPending, reason, message)
	if err := r.patchAppStatusAllowingReleaseRefClear(ctx, app); err != nil {
		return ctrl.Result{}, fmt.Errorf("patch application status for new release: %w", err)
	}
	return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}

func (r *ApplicationReconciler) requestCurrentReleaseResync(ctx context.Context, app *paprikav1.Application) error {
	if app.Status.ReleaseRef == "" {
		return nil
	}
	if err := r.requestReleaseResync(ctx, app.Namespace, app.Status.ReleaseRef); err != nil {
		return fmt.Errorf("request current release resync: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) requestReleaseResync(ctx context.Context, namespace, releaseName string) error {
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var release paprikav1.Release
		if err := r.client.Get(ctx, types.NamespacedName{Name: releaseName, Namespace: namespace}, &release); err != nil {
			if apierrors.IsNotFound(err) {
				return nil
			}
			return fmt.Errorf("get release: %w", err)
		}
		if release.Annotations == nil {
			release.Annotations = map[string]string{}
		}
		release.Annotations[resyncAnnotation] = strconv.FormatInt(r.currentTime().Unix(), 10)
		delete(release.Annotations, rollbackAnnotation)
		if err := r.client.Update(ctx, &release); err != nil {
			return fmt.Errorf("update release resync annotation: %w", err)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("request release resync: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) supersedeCurrentRelease(ctx context.Context, app *paprikav1.Application) error {
	releaseRef := app.Status.ReleaseRef
	if releaseRef == "" {
		return nil
	}
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var release paprikav1.Release
		if err := r.client.Get(ctx, types.NamespacedName{Name: releaseRef, Namespace: app.Namespace}, &release); err != nil {
			if apierrors.IsNotFound(err) {
				app.Status.ReleaseRef = ""
				return nil
			}
			return fmt.Errorf("get release: %w", err)
		}
		if !applicationReleasePhaseTerminal(release.Status.Phase) {
			return nil
		}
		if release.Status.Phase != paprikav1.ReleaseSuperseded {
			release.Status.Phase = paprikav1.ReleaseSuperseded
			if err := r.client.Status().Update(ctx, &release); err != nil {
				return fmt.Errorf("update release phase: %w", err)
			}
		}
		app.Status.ReleaseRef = ""
		return nil
	}); err != nil {
		return fmt.Errorf("supersede release %s: %w", releaseRef, err)
	}
	return nil
}

func applicationReleasePhaseTerminal(phase paprikav1.ReleasePhase) bool {
	return phase == paprikav1.ReleaseComplete ||
		phase == paprikav1.ReleaseFailed ||
		phase == paprikav1.ReleaseRolledBack ||
		phase == paprikav1.ReleaseSuperseded
}

func (r *ApplicationReconciler) pruneReleasesIfInline(ctx context.Context, app *paprikav1.Application) {
	if !r.isInlineSource(app) {
		return
	}
	if err := r.pruneOldReleases(ctx, app); err != nil {
		log.FromContext(ctx).Error(err, "Failed to prune old releases")
	}
}

func (r *ApplicationReconciler) pruneOldReleases(ctx context.Context, app *paprikav1.Application) error {
	all, err := r.listReleasesSorted(ctx, app)
	if err != nil {
		return fmt.Errorf("list releases: %w", err)
	}
	if len(all) <= maxReleaseHistory {
		return nil
	}

	keep := r.selectReleasesToKeep(all, app.Status.ReleaseRef)
	deleted, err := r.deleteReleases(ctx, all, keep, app)
	if err != nil {
		return fmt.Errorf("delete releases: %w", err)
	}
	if deleted > 0 {
		r.recordEvent(app, corev1.EventTypeNormal, "PrunedReleases", fmt.Sprintf("Pruned %d old releases", deleted))
	}
	return nil
}

func (r *ApplicationReconciler) listReleasesSorted(ctx context.Context, app *paprikav1.Application) ([]*paprikav1.Release, error) {
	var list paprikav1.ReleaseList
	if err := r.client.List(ctx, &list,
		client.InNamespace(app.Namespace),
		client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name},
	); err != nil {
		return nil, fmt.Errorf("listing releases for pruning: %w", err)
	}

	all := make([]*paprikav1.Release, 0, len(list.Items))
	for i := range list.Items {
		all = append(all, &list.Items[i])
	}

	// Sort newest first.
	sort.Slice(all, func(i, j int) bool {
		return all[i].CreationTimestamp.After(all[j].CreationTimestamp.Time)
	})
	return all, nil
}

func (r *ApplicationReconciler) selectReleasesToKeep(all []*paprikav1.Release, activeRef string) map[string]struct{} {
	keep := map[string]struct{}{}
	r.protectActiveRelease(all, activeRef, keep)
	r.protectLatestNonSuperseded(all, keep)
	r.fillHistoryLimit(all, keep)
	return keep
}

func (r *ApplicationReconciler) protectActiveRelease(all []*paprikav1.Release, activeRef string, keep map[string]struct{}) {
	for _, rel := range all {
		if rel.Name == activeRef {
			keep[rel.Name] = struct{}{}
			return
		}
	}
}

func (r *ApplicationReconciler) protectLatestNonSuperseded(all []*paprikav1.Release, keep map[string]struct{}) {
	for _, rel := range all {
		if _, ok := keep[rel.Name]; ok {
			continue
		}
		if rel.Status.Phase != paprikav1.ReleaseSuperseded {
			keep[rel.Name] = struct{}{}
			return
		}
	}
}

func (r *ApplicationReconciler) fillHistoryLimit(all []*paprikav1.Release, keep map[string]struct{}) {
	kept := 0
	for _, rel := range all {
		if _, ok := keep[rel.Name]; ok {
			kept++
			continue
		}
		if kept < maxReleaseHistory {
			keep[rel.Name] = struct{}{}
			kept++
		}
	}
}

func (r *ApplicationReconciler) deleteReleases(ctx context.Context, all []*paprikav1.Release, keep map[string]struct{}, app *paprikav1.Application) (int, error) {
	deleted := 0
	for _, rel := range all {
		if _, ok := keep[rel.Name]; ok {
			continue
		}
		if err := r.client.Delete(ctx, rel); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			r.recordEvent(app, corev1.EventTypeWarning, "PruneReleaseFailed", fmt.Sprintf("Failed to prune release %s: %v", rel.Name, err))
			return deleted, fmt.Errorf("deleting release %s: %w", rel.Name, err)
		}
		deleted++
	}
	return deleted, nil
}

func (r *ApplicationReconciler) recordEvent(app *paprikav1.Application, eventType, reason, message string) {
	if r.EventRecorder != nil {
		r.EventRecorder.Event(app, eventType, reason, message)
	}
}

func (r *ApplicationReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.now == nil {
		if r.Clock != nil {
			r.now = r.Clock.Now
		} else {
			r.now = time.Now
		}
	}
	if r.SyncWindowEvaluator == nil {
		r.SyncWindowEvaluator = syncwindow.NewEvaluator()
	}

	if err := ctrl.NewControllerManagedBy(mgr).
		For(&paprikav1.Application{}).
		Owns(&paprikav1.Template{}).
		Owns(&paprikav1.Pipeline{}).
		Owns(&paprikav1.Stage{}).
		Owns(&paprikav1.Release{}).
		Owns(&paprikav1.AnalysisRun{}).
		WithOptions(controller.Options{
			MaxConcurrentReconciles: 3,
			RecoverPanic:            ptr(true),
		}).
		Named("application").
		Complete(r); err != nil {
		return fmt.Errorf("setting up application controller: %w", err)
	}
	return nil
}
