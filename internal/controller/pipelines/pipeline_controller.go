package pipelines

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/sharding"
)

const pipelineFinalizer = "paprika.io/pipeline-cleanup"

// PipelineReconciler reconciles Pipeline resources.
type PipelineReconciler struct {
	client         client.Client
	Scheme         *runtime.Scheme
	K8sClient      kubernetes.Interface
	Namespace      string
	WorkflowEngine PipelineRunner
	ShardFilter    *sharding.Filter
	Clock          clock.Clock
	EventBroker    *events.Broker
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines/finalizers,verbs=update
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=pods/log,verbs=get;list

// Reconcile handles Pipeline reconciliation.
func (r *PipelineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("pipeline", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("pipeline").Observe(metrics.Since(r.Clock, start))
	}()

	var pipeline pipelinesv1alpha1.Pipeline
	if err := r.client.Get(ctx, req.NamespacedName, &pipeline); err != nil {
		result = resultError
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("getting pipeline: %w", k8sErr)
		}
		return ctrl.Result{}, nil
	}

	log := logf.FromContext(ctx)
	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping pipeline not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	if !pipeline.DeletionTimestamp.IsZero() {
		if err := r.handlePipelineDeletion(ctx, &pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&pipeline, pipelineFinalizer) {
		if err := r.ensurePipelineFinalizer(ctx, &pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	return r.reconcilePipeline(ctx, req, &pipeline, start, &result)
}

func (r *PipelineReconciler) patchPipelineStatus(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	desiredStatus := pipeline.Status.DeepCopy()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var fresh pipelinesv1alpha1.Pipeline
		if err := r.client.Get(ctx, types.NamespacedName{Name: pipeline.Name, Namespace: pipeline.Namespace}, &fresh); err != nil {
			return fmt.Errorf("fetching pipeline for status update: %w", err)
		}
		fresh.Status = *desiredStatus
		fresh.Status.ObservedGeneration = fresh.Generation
		if err := r.client.Status().Update(ctx, &fresh); err != nil {
			return fmt.Errorf("updating pipeline status: %w", err)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("patching pipeline status: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) handlePipelineResult(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, stepStatuses []pipelinesv1alpha1.StepStatus, start time.Time, result *string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	allSucceeded := true
	for _, s := range stepStatuses {
		if s.Phase == pipelinesv1alpha1.StepFailed {
			allSucceeded = false
			break
		}
	}

	if allSucceeded {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineSucceeded
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Succeeded").Inc()
		metrics.PipelineDuration.WithLabelValues(pipeline.Name, pipeline.Namespace).Observe(metrics.Since(r.Clock, start))
		pipeline.Status.StepStatuses = stepStatuses
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to succeeded: %w", err)
		}
		r.publishPipelineEvents(ctx, pipeline)

		for _, output := range pipeline.Spec.Artifacts {
			if err := r.createArtifact(ctx, pipeline, output); err != nil {
				log.Error(err, "Failed to create artifact", "artifact", output.Name)
			}
		}
	} else {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Failed").Inc()
		pipeline.Status.StepStatuses = stepStatuses
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to failed: %w", err)
		}
		r.publishPipelineEvents(ctx, pipeline)
	}
	return ctrl.Result{}, nil
}

func (r *PipelineReconciler) handlePipelineDeletion(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	if !controllerutil.ContainsFinalizer(pipeline, pipelineFinalizer) {
		return nil
	}
	controllerutil.RemoveFinalizer(pipeline, pipelineFinalizer)
	if err := r.client.Update(ctx, pipeline); err != nil {
		return fmt.Errorf("removing pipeline finalizer: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) ensurePipelineFinalizer(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	if controllerutil.ContainsFinalizer(pipeline, pipelineFinalizer) {
		return nil
	}
	controllerutil.AddFinalizer(pipeline, pipelineFinalizer)
	if err := r.client.Update(ctx, pipeline); err != nil {
		return fmt.Errorf("adding pipeline finalizer: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) reconcilePipeline(ctx context.Context, req ctrl.Request, pipeline *pipelinesv1alpha1.Pipeline, start time.Time, result *string) (ctrl.Result, error) {
	if pipeline.Status.Phase == pipelinesv1alpha1.PipelineSucceeded ||
		pipeline.Status.Phase == pipelinesv1alpha1.PipelineFailed ||
		pipeline.Status.Phase == pipelinesv1alpha1.PipelineCancelled {
		return ctrl.Result{}, nil
	}

	if pipeline.Status.Phase == "" {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineRunning
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Running").Inc()
		pipeline.Status.LastExecutionID = "run-" + req.Name
		now := metav1.Now()
		pipeline.Status.LastExecutionTime = &now
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to set pipeline running: %w", err)
		}
		r.publishPipelineEvent(ctx, pipeline, "")
	}

	pipelineCopy := pipeline.DeepCopy()
	onProgress := func(_ context.Context, _ *pipelinesv1alpha1.Pipeline, st pipelinesv1alpha1.StepStatus) {
		r.updateStepStatus(ctx, pipelineCopy, st)
		r.publishPipelineEvent(ctx, pipelineCopy, st.Name)
	}

	stepStatuses, err := r.WorkflowEngine.RunPipeline(ctx, pipelineCopy, onProgress)
	if err != nil {
		log := logf.FromContext(ctx)
		log.Error(err, "Pipeline execution failed", "pipeline", req.Name)
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		pipeline.Status.StepStatuses = pipelineCopy.Status.StepStatuses
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Failed").Inc()
		if updateErr := r.patchPipelineStatus(ctx, pipeline); updateErr != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to failed: %w", updateErr)
		}
		r.publishPipelineEvents(ctx, pipeline)
		return ctrl.Result{}, fmt.Errorf("running pipeline workflow: %w", err)
	}

	pipeline.Status.StepStatuses = stepStatuses
	return r.handlePipelineResult(ctx, pipeline, stepStatuses, start, result)
}

func (r *PipelineReconciler) createArtifact(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, output pipelinesv1alpha1.PipelineOutput) error {
	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: pipeline.Name + "-artifact-",
			Namespace:    pipeline.Namespace,
			Labels: map[string]string{
				"paprika.io/pipeline": pipeline.Name,
			},
		},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "oci",
			Reference: output.Path,
			Provenance: pipelinesv1alpha1.ArtifactProvenance{
				Pipeline: pipeline.Name,
				Build:    pipeline.Status.LastExecutionID,
			},
		},
	}
	if err := r.client.Create(ctx, artifact); err != nil {
		return fmt.Errorf("creating artifact: %w", err)
	}
	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *PipelineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Pipeline{}).
		Owns(&corev1.Pod{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 3}).
		Named("pipeline").
		Complete(r); err != nil {
		return fmt.Errorf("setting up pipeline controller: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) updateStepStatus(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, st pipelinesv1alpha1.StepStatus) {
	found := false
	for i := range pipeline.Status.StepStatuses {
		if pipeline.Status.StepStatuses[i].Name == st.Name {
			pipeline.Status.StepStatuses[i] = st
			found = true
			break
		}
	}
	if !found {
		pipeline.Status.StepStatuses = append(pipeline.Status.StepStatuses, st)
	}
	if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
		logf.FromContext(ctx).Error(err, "Failed to patch step status", "pipeline", pipeline.Name, "step", st.Name)
	}
}

func stepStatusPtrValue(t *metav1.Time) *int64 {
	if t == nil {
		return nil
	}
	v := t.Unix()
	return &v
}

func (r *PipelineReconciler) publishPipelineEvent(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, stepName string) {
	if r.EventBroker == nil {
		return
	}
	payload := events.EventPayload{
		ResourceType: events.TypePipeline,
		Namespace:    pipeline.Namespace,
		Timestamp:    time.Now().UTC().Format(time.RFC3339),
	}
	if stepName == "" {
		payload.Name = pipeline.Name
		payload.Phase = string(pipeline.Status.Phase)
	} else {
		payload.Name = stepName
		for _, st := range pipeline.Status.StepStatuses {
			if st.Name == stepName {
				payload.Phase = string(st.Phase)
				payload.StartedAt = stepStatusPtrValue(st.StartedAt)
				payload.CompletedAt = stepStatusPtrValue(st.CompletedAt)
				break
			}
		}
	}
	evt, err := events.NewEvent(events.TypePipeline, payload, r.Clock)
	if err != nil {
		logf.FromContext(ctx).Error(err, "Failed to create pipeline event", "pipeline", pipeline.Name, "step", stepName)
		return
	}
	topic := fmt.Sprintf("pipeline/%s/%s", pipeline.Namespace, pipeline.Name)
	r.EventBroker.Publish(ctx, topic, evt)
}

func (r *PipelineReconciler) publishPipelineEvents(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) {
	r.publishPipelineEvent(ctx, pipeline, "")
	for i := range pipeline.Status.StepStatuses {
		r.publishPipelineEvent(ctx, pipeline, pipeline.Status.StepStatuses[i].Name)
	}
}
