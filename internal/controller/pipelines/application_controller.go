package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/attribute"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/health"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/ratelimit"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/metrics"
)

const defaultRequeue = 5 * time.Second

// ApplicationReconciler reconciles Application resources.
type ApplicationReconciler struct {
	client.Client
	Scheme           *runtime.Scheme
	K8sClient        *kubernetes.Clientset
	Namespace        string
	RestConfig       *rest.Config
	WorkDir          string
	HealthEval       health.HealthEvaluator
	DiffEngine       engine.DiffEngine
	ResHealth        health.ResourceHealthChecker
	ClusterMgr       ClusterClientManager
	TemplateRenderer engine.TemplateRenderer
	ShardFilter      *sharding.Filter
	RateLimiter      *ratelimit.ControllerRateLimit
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts,verbs=get;list;watch

// Reconcile handles Application reconciliation.
func (r *ApplicationReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	ctx, span := observability.StartSpan(ctx, "ApplicationReconcile",
		attribute.String("namespace", req.Namespace),
		attribute.String("name", req.Name),
	)
	defer span.End()

	var app paprikav1.Application
	start := metrics.Timer()
	defer func() {
		metrics.ApplicationReconcileDuration.WithLabelValues(app.Name, app.Namespace).Observe(metrics.Since(start))
	}()

	log := log.FromContext(ctx)

	if err := r.Get(ctx, req.NamespacedName, &app); err != nil {
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
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

func (r *ApplicationReconciler) reconcileApp(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	if _, ok := app.Annotations["paprika.io/resync"]; ok {
		return r.handleResync(ctx, app)
	}

	if app.Status.Phase == paprikav1.ApplicationHealthy {
		return r.handleHealthyPhase(ctx, app)
	}

	if err := r.reconcileTemplate(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile Template")
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "TemplateReconciliationFailed", err.Error())
		return ctrl.Result{}, err
	}

	if ctrlResult, err := r.reconcileAppPipeline(ctx, app); ctrlResult != nil || err != nil {
		if err != nil {
			return ctrl.Result{}, err
		}
		return *ctrlResult, nil
	}

	if err := r.reconcileStages(ctx, app); err != nil {
		log.Error(err, "Failed to reconcile Stages")
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "StageReconciliationFailed", err.Error())
		return ctrl.Result{}, err
	}

	return r.reconcileReleaseFlow(ctx, app)
}

func (r *ApplicationReconciler) reconcileReleaseFlow(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	if blocked, msg := r.checkGates(ctx, app); blocked {
		log.Info("Gate blocked release", "app", app.Name, "reason", msg)
		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "GatePending", msg)
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

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

	if err := r.patchAppStatus(ctx, app); err != nil {
		log.Error(err, "Failed to update application status after evaluation")
	}

	return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}

func (r *ApplicationReconciler) handleResync(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)
	log.Info("Resync annotation detected, resetting phase to Pending")
	patch := client.MergeFrom(app.DeepCopy())
	delete(app.Annotations, "paprika.io/resync")
	if len(app.Annotations) == 0 {
		app.Annotations = nil
	}
	if err := r.Patch(ctx, app, patch); err != nil {
		log.Error(err, "Failed to remove resync annotation")
		return ctrl.Result{}, fmt.Errorf("removing resync annotation: %w", err)
	}
	app.Status.Phase = paprikav1.ApplicationPending
	if err := r.patchAppStatus(ctx, app); err != nil {
		log.Error(err, "Failed to update status after resync")
		return ctrl.Result{}, fmt.Errorf("updating status after resync: %w", err)
	}
	return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}

func (r *ApplicationReconciler) patchAppStatus(ctx context.Context, app *paprikav1.Application) error {
	patch := client.MergeFromWithOptions(app.DeepCopy(), client.MergeFromWithOptimisticLock{})
	app.Status.ObservedGeneration = app.Generation
	return r.Status().Patch(ctx, app, patch) //nolint:wrapcheck // wrapped by callers
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
	case paprikav1.PipelineFailed:
		r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "PipelineFailed", "pipeline failed")
		return &ctrl.Result{}, nil
	case paprikav1.PipelineSucceeded:
		return nil, nil
	}
	return nil, nil
}

func (r *ApplicationReconciler) reconcileTemplate(ctx context.Context, app *paprikav1.Application) error {
	templateName := app.Name + "-template"

	spec := paprikav1.TemplateSpec{
		Type:      string(app.Spec.Source.Type),
		Chart:     app.Spec.Source.Chart,
		Namespace: app.Namespace,
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
	}

	expected := &paprikav1.Template{
		ObjectMeta: metav1.ObjectMeta{
			Name:      templateName,
			Namespace: app.Namespace,
			Labels: map[string]string{
				"app.paprika.io/name": app.Name,
			},
		},
		Spec: spec,
	}

	if err := ctrl.SetControllerReference(app, expected, r.Scheme); err != nil {
		return fmt.Errorf("failed to set controller reference on template: %w", err)
	}

	var existing paprikav1.Template
	err := r.Get(ctx, client.ObjectKeyFromObject(expected), &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get template: %w", err)
	}

	if err != nil {
		if err := r.Create(ctx, expected); err != nil {
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
		if err := r.Update(ctx, &existing); err != nil {
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
			Labels: map[string]string{
				"app.paprika.io/name": app.Name,
			},
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
	err := r.Get(ctx, client.ObjectKeyFromObject(expected), &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get pipeline: %w", err)
	}

	if err != nil {
		if err := r.Create(ctx, expected); err != nil {
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
		if err := r.Update(ctx, &existing); err != nil {
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
			return err
		}
		stageRefs = append(stageRefs, stageName)
	}

	app.Status.StageRefs = stageRefs
	return nil
}

func (r *ApplicationReconciler) reconcileSingleStage(ctx context.Context, app *paprikav1.Application, promotionStage *paprikav1.ApplicationPromotionStage, templateName, stageName string) error {
	strategy := r.resolveStageStrategy(promotionStage)
	stageCanary := r.resolveStageCanary(promotionStage, strategy)

	expected := r.buildStageSpec(app, promotionStage, templateName, stageName, stageCanary)
	if err := ctrl.SetControllerReference(app, expected, r.Scheme); err != nil {
		return fmt.Errorf("failed to set controller reference on stage %s: %w", stageName, err)
	}

	var existing paprikav1.Stage
	err := r.Get(ctx, types.NamespacedName{Name: stageName, Namespace: app.Namespace}, &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get stage %s: %w", stageName, err)
	}

	if err != nil {
		return r.createStage(ctx, expected, stageName)
	}
	return r.updateStage(ctx, &existing, expected, stageName)
}

func (r *ApplicationReconciler) resolveStageStrategy(promotionStage *paprikav1.ApplicationPromotionStage) paprikav1.DeliveryStrategy {
	if promotionStage.Strategy != nil {
		return *promotionStage.Strategy
	}
	return ""
}

func (r *ApplicationReconciler) resolveStageCanary(promotionStage *paprikav1.ApplicationPromotionStage, strategy paprikav1.DeliveryStrategy) *paprikav1.CanaryConfig {
	canaryConfig := promotionStage.Canary
	if strategy == paprikav1.StrategyCanary && canaryConfig != nil {
		return canaryConfig
	}
	return nil
}

func (r *ApplicationReconciler) buildStageSpec(app *paprikav1.Application, promotionStage *paprikav1.ApplicationPromotionStage, templateName, stageName string, stageCanary *paprikav1.CanaryConfig) *paprikav1.Stage {
	return &paprikav1.Stage{
		ObjectMeta: metav1.ObjectMeta{
			Name:      stageName,
			Namespace: app.Namespace,
			Labels: map[string]string{
				"app.paprika.io/name": app.Name,
				"app.paprika.io/ring": strconv.Itoa(int(promotionStage.Ring)),
			},
		},
		Spec: paprikav1.StageSpec{
			Name:      promotionStage.Name,
			Ring:      promotionStage.Ring,
			Cluster:   promotionStage.Cluster,
			Templates: []string{templateName},
			Gates:     promotionStage.Gates,
			Canary:    stageCanary,
		},
	}
}

func (r *ApplicationReconciler) createStage(ctx context.Context, expected *paprikav1.Stage, stageName string) error {
	if err := r.Create(ctx, expected); err != nil {
		return fmt.Errorf("failed to create stage %s: %w", stageName, err)
	}
	return nil
}

func (r *ApplicationReconciler) updateStage(ctx context.Context, existing, expected *paprikav1.Stage, stageName string) error {
	existing.Spec = expected.Spec
	if len(existing.Labels) == 0 {
		existing.Labels = make(map[string]string)
	}
	for k, v := range expected.Labels {
		existing.Labels[k] = v
	}
	if err := r.Update(ctx, existing); err != nil {
		return fmt.Errorf("failed to update stage %s: %w", stageName, err)
	}
	return nil
}

func (r *ApplicationReconciler) reconcileRelease(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	if len(app.Spec.Stages) == 0 {
		return ctrl.Result{}, nil
	}

	targetStage := &app.Spec.Stages[0]
	currentReleasePhase := r.getCurrentReleasePhase(ctx, app)

	if currentReleasePhase != "" {
		return r.handleActiveRelease(ctx, app, targetStage, currentReleasePhase)
	}

	if app.Spec.SyncPolicy == paprikav1.SyncManual {
		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingManualSync", "syncPolicy is Manual")
		return ctrl.Result{}, nil
	}

	release := r.buildRelease(app, targetStage)
	if err := ctrl.SetControllerReference(app, release, r.Scheme); err != nil {
		return ctrl.Result{}, fmt.Errorf("failed to set controller reference on release: %w", err)
	}

	if err := r.Create(ctx, release); err != nil {
		return ctrl.Result{}, fmt.Errorf("failed to create release: %w", err)
	}

	app.Status.ReleaseRef = release.Name
	r.updatePhase(ctx, app, paprikav1.ApplicationPromoting, "ReleaseCreated", "created release for stage "+targetStage.Name)
	return ctrl.Result{}, nil
}

func (r *ApplicationReconciler) handleActiveRelease(ctx context.Context, app *paprikav1.Application, targetStage *paprikav1.ApplicationPromotionStage, phase paprikav1.ReleasePhase) (ctrl.Result, error) {
	phaseMap := map[paprikav1.ReleasePhase]struct {
		appPhase paprikav1.ApplicationPhase
		reason   string
		requeue  bool
	}{
		paprikav1.ReleasePending:    {paprikav1.ApplicationPromoting, "ReleasePromoting", true},
		paprikav1.ReleasePromoting:  {paprikav1.ApplicationPromoting, "ReleasePromoting", true},
		paprikav1.ReleaseCanarying:  {paprikav1.ApplicationCanarying, "ReleaseCanarying", true},
		paprikav1.ReleaseVerifying:  {paprikav1.ApplicationVerifying, "ReleaseVerifying", true},
		paprikav1.ReleaseComplete:   {paprikav1.ApplicationHealthy, "ReleaseComplete", false},
		paprikav1.ReleaseFailed:     {paprikav1.ApplicationDegraded, "ReleaseFailed", true},
		paprikav1.ReleaseRolledBack: {paprikav1.ApplicationRolledBack, "ReleaseRolledBack", true},
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
	releaseName := app.Name + "-release"
	stageName := app.Name + "-" + targetStage.Name
	pipelineName := app.Name + "-pipeline"
	if app.Status.PipelineRef == "" {
		pipelineName = ""
	}

	params := make(map[string]string, len(app.Spec.Parameters)+len(targetStage.Parameters))
	for k, v := range app.Spec.Parameters {
		params[k] = v
	}
	for k, v := range targetStage.Parameters {
		params[k] = v
	}

	return &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      releaseName,
			Namespace: app.Namespace,
			Labels: map[string]string{
				"app.paprika.io/name": app.Name,
			},
		},
		Spec: paprikav1.ReleaseSpec{
			Pipeline:   pipelineName,
			Target:     stageName,
			Verify:     targetStage.Gates,
			OnFailure:  app.Spec.OnFailure,
			Parameters: params,
		},
	}
}

func (r *ApplicationReconciler) getCurrentReleasePhase(ctx context.Context, app *paprikav1.Application) paprikav1.ReleasePhase {
	if app.Status.ReleaseRef == "" {
		return ""
	}

	var release paprikav1.Release
	if err := r.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		return ""
	}

	return release.Status.Phase
}

func (r *ApplicationReconciler) getPipelinePhase(ctx context.Context, app *paprikav1.Application) paprikav1.PipelinePhase {
	if app.Status.PipelineRef == "" {
		return paprikav1.PipelineSucceeded
	}

	var pipeline paprikav1.Pipeline
	if err := r.Get(ctx, types.NamespacedName{Name: app.Status.PipelineRef, Namespace: app.Namespace}, &pipeline); err != nil {
		return ""
	}

	return pipeline.Status.Phase
}

func (r *ApplicationReconciler) updatePhase(ctx context.Context, app *paprikav1.Application, phase paprikav1.ApplicationPhase, reason, message string) {
	log := log.FromContext(ctx)

	if app.Status.Phase == phase {
		return
	}

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

	if err := r.patchAppStatus(ctx, app); err != nil {
		log.Error(err, "Failed to update application status", "phase", phase)
	}
}

func (r *ApplicationReconciler) checkSourceChanged(ctx context.Context, app *paprikav1.Application) (bool, error) {
	newHash, newRevision, err := r.resolveSourceHash(ctx, app)
	if err != nil {
		return false, err
	}

	if newHash == "" && newRevision == "" {
		return false, nil
	}

	oldHash := app.Status.SourceHash

	app.Status.SourceHash = newHash
	app.Status.SourceRevision = newRevision
	if err := r.patchAppStatus(ctx, app); err != nil {
		return false, fmt.Errorf("failed to update source hash: %w", err)
	}

	if oldHash == "" {
		return false, nil
	}

	return oldHash != newHash, nil
}

func (r *ApplicationReconciler) resolveSourceHash(ctx context.Context, app *paprikav1.Application) (hash, revision string, err error) {
	if app.Spec.Source.Type == paprikav1.SourceTypeGit || app.Spec.Source.Type == paprikav1.SourceTypeS3 {
		renderer := r.TemplateRenderer
		if renderer == nil {
			renderer = engine.NewHelmSDKRenderer(r.WorkDir)
		}

		templateName := app.Name + "-template"
		var tmpl paprikav1.Template
		if getErr := r.Get(ctx, types.NamespacedName{Name: templateName, Namespace: app.Namespace}, &tmpl); getErr != nil {
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

	var results []paprikav1.HealthCheckResult
	evalResults := make([]health.EvalResult, 0, len(app.Spec.HealthChecks))

	now := metav1.Now()
	for _, check := range app.Spec.HealthChecks {
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

func (r *ApplicationReconciler) evaluateDiff(ctx context.Context, app *paprikav1.Application) {
	log := log.FromContext(ctx)

	if r.DiffEngine == nil {
		return
	}

	// Get the rendered manifest from the template
	templateName := app.Name + "-template"
	var tmpl paprikav1.Template
	if err := r.Get(ctx, types.NamespacedName{Name: templateName, Namespace: app.Namespace}, &tmpl); err != nil {
		log.Error(err, "Failed to get template for diff")
		return
	}

	renderer := r.TemplateRenderer
	if renderer == nil {
		renderer = engine.NewHelmSDKRenderer(r.WorkDir)
	}
	manifests, err := renderer.Render(ctx, &tmpl, app.Spec.Parameters)
	if err != nil {
		log.Error(err, "Failed to render template for diff")
		return
	}

	docs := engine.SplitYAMLDocuments(manifests)
	var desired []unstructured.Unstructured
	for _, doc := range docs {
		var obj map[string]interface{}
		if uErr := yaml.Unmarshal(doc, &obj); uErr != nil {
			continue
		}
		if obj == nil {
			continue
		}
		u := unstructured.Unstructured{Object: obj}
		desired = append(desired, u)
	}

	labelSelector := engine.ManagedByAppSelector(app.Name).String()
	result, err := r.DiffEngine.ComputeDiff(ctx, desired, engine.DiffOptions{
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
		if rs.Status == "Synced" {
			h := r.ResHealth.Check(ctx, rs.Kind, rs.Name, rs.Namespace)
			healthResults = append(healthResults, h)
		}
	}

	app.Status.ResourceHealth = healthResults
}

func (r *ApplicationReconciler) checkGates(ctx context.Context, app *paprikav1.Application) (blocked bool, reason string) {
	if len(app.Spec.ApprovalGates) == 0 {
		return false, ""
	}

	targetStage := r.getTargetStage(app)

	for _, gate := range app.Spec.ApprovalGates {
		if !r.isGateRelevant(gate, targetStage) {
			continue
		}
		if r.isGateApproved(app, gate.Name) {
			continue
		}
		if err := r.recordPendingGate(ctx, app, gate); err != nil {
			log.FromContext(ctx).Error(err, "Failed to record pending gate")
		}
		return true, fmt.Sprintf("approval gate %s pending for stage %s", gate.Name, gate.Stage)
	}

	return false, ""
}

func (r *ApplicationReconciler) getTargetStage(app *paprikav1.Application) string {
	if len(app.Spec.Stages) == 0 {
		return ""
	}
	return app.Spec.Stages[0].Name
}

func (r *ApplicationReconciler) isGateRelevant(gate paprikav1.ApprovalGate, targetStage string) bool {
	if gate.Stage != "" && gate.Stage != targetStage {
		return false
	}
	return gate.Required
}

func (r *ApplicationReconciler) isGateApproved(app *paprikav1.Application, gateName string) bool {
	for _, gs := range app.Status.Gates {
		if gs.Name == gateName && gs.Status == "Approved" {
			return true
		}
	}
	return false
}

func (r *ApplicationReconciler) recordPendingGate(ctx context.Context, app *paprikav1.Application, gate paprikav1.ApprovalGate) error {
	if r.gateStatusExists(app, gate.Name) {
		return nil
	}
	app.Status.Gates = append(app.Status.Gates, paprikav1.GateStatus{
		Name:   gate.Name,
		Stage:  gate.Stage,
		Status: "Pending",
	})
	if err := r.patchAppStatus(ctx, app); err != nil {
		return fmt.Errorf("recording pending gate: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) gateStatusExists(app *paprikav1.Application, gateName string) bool {
	for _, gs := range app.Status.Gates {
		if gs.Name == gateName {
			return true
		}
	}
	return false
}

// SetupWithManager sets up the controller with the Manager.
func (r *ApplicationReconciler) handleHealthyPhase(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
	log := log.FromContext(ctx)
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
		r.updatePhase(ctx, app, paprikav1.ApplicationPending, "SourceChanged", "source hash changed, re-syncing")
		return ctrl.Result{RequeueAfter: defaultRequeue}, nil
	}
	return ctrl.Result{RequeueAfter: pollInterval}, nil
}

func (r *ApplicationReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&paprikav1.Application{}).
		Owns(&paprikav1.Template{}).
		Owns(&paprikav1.Pipeline{}).
		Owns(&paprikav1.Stage{}).
		Owns(&paprikav1.Release{}).
		Named("application").
		Complete(r); err != nil {
		return fmt.Errorf("setting up application controller: %w", err)
	}
	return nil
}
