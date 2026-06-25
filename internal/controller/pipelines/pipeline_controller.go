package pipelines

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
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
	"github.com/benebsworth/paprika/internal/controller/pipelines/progress"
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
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts,verbs=get;list;watch;create;update;patch;delete
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
	} else {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Failed").Inc()
	}
	pipeline.Status.StepStatuses = stepStatuses

	if artifactErr := r.reconcileArtifacts(ctx, pipeline); artifactErr != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("reconciling pipeline artifacts: %w", artifactErr)
	}

	if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to %s: %w", strings.ToLower(string(pipeline.Status.Phase)), err)
	}
	r.publishPipelineEvents(ctx, pipeline)
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
	if isTerminalPipelinePhase(pipeline.Status.Phase) {
		if err := r.reconcileArtifacts(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("reconciling pipeline artifacts: %w", err)
		}
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status: %w", err)
		}
		r.publishPipelineEvents(ctx, pipeline)
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

	stepStatuses, err := r.WorkflowEngine.RunPipeline(ctx, pipelineCopy, progress.StepProgressCallback(onProgress))
	if err != nil {
		log := logf.FromContext(ctx)
		log.Error(err, "Pipeline execution failed", "pipeline", req.Name)
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		pipeline.Status.StepStatuses = pipelineCopy.Status.StepStatuses
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Failed").Inc()
		if artifactErr := r.reconcileArtifacts(ctx, pipeline); artifactErr != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("reconciling pipeline artifacts: %w", artifactErr)
		}
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

func isTerminalPipelinePhase(phase pipelinesv1alpha1.PipelinePhase) bool {
	return phase == pipelinesv1alpha1.PipelineSucceeded ||
		phase == pipelinesv1alpha1.PipelineFailed ||
		phase == pipelinesv1alpha1.PipelineCancelled
}

func hashTuple(pipeline, step, output string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(pipeline + "\x00" + step + "\x00" + output))
	s := strconv.FormatUint(uint64(h.Sum32()), 36)
	for len(s) < 4 {
		s = "0" + s
	}
	if len(s) > 4 {
		s = s[:4]
	}
	return s
}

func artifactNameForOutput(pipeline string, output pipelinesv1alpha1.PipelineOutput, taken map[string]struct{}) string {
	base := sanitizeArtifactName(pipeline, output.Step, output.Name)
	if _, exists := taken[base]; !exists {
		return base
	}
	suffix := "-" + hashTuple(pipeline, output.Step, output.Name)
	if len(base)+len(suffix) > 63 {
		base = strings.TrimRight(base[:63-len(suffix)], "-")
	}
	return base + suffix
}

func computeArtifactNames(pipeline string, outputs []pipelinesv1alpha1.PipelineOutput) []string {
	names := make([]string, len(outputs))
	taken := make(map[string]struct{}, len(outputs))
	for i, output := range outputs {
		name := artifactNameForOutput(pipeline, output, taken)
		taken[name] = struct{}{}
		names[i] = name
	}
	return names
}

func collectPipelineOutputs(pipeline *pipelinesv1alpha1.Pipeline) []pipelinesv1alpha1.PipelineOutput {
	var outputs []pipelinesv1alpha1.PipelineOutput
	for _, step := range pipeline.Spec.Steps {
		for _, output := range step.Outputs {
			if output.Step == "" {
				output.Step = step.Name
			}
			outputs = append(outputs, output)
		}
	}
	outputs = append(outputs, pipeline.Spec.Artifacts...)
	return outputs
}

func (r *PipelineReconciler) reconcileArtifacts(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	outputs := collectPipelineOutputs(pipeline)
	artifactNames := computeArtifactNames(pipeline.Name, outputs)

	expected := make(map[string]struct{}, len(outputs))
	for i, output := range outputs {
		artifactName := artifactNames[i]
		expected[artifactName] = struct{}{}
		if err := r.createArtifact(ctx, pipeline, output, artifactName); err != nil {
			return fmt.Errorf("reconciling artifact %q: %w", artifactName, err)
		}
		r.upsertPendingArtifactRef(pipeline, output, artifactName)
	}

	var artifactList pipelinesv1alpha1.ArtifactList
	if err := r.client.List(ctx, &artifactList, client.InNamespace(pipeline.Namespace), client.MatchingLabels{PipelineLabelKey: pipeline.Name}); err != nil {
		return fmt.Errorf("listing owned artifacts: %w", err)
	}

	r.syncArtifactRefs(ctx, pipeline, artifactList.Items)

	if err := r.cleanupStaleArtifacts(ctx, pipeline, artifactList.Items, expected); err != nil {
		return fmt.Errorf("cleaning up stale artifacts: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) createArtifact(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, output pipelinesv1alpha1.PipelineOutput, artifactName string) error {
	kind, reference, err := parseArtifactReference(output.Path)
	if err != nil {
		return fmt.Errorf("parsing artifact reference for %q: %w", output.Name, err)
	}

	producingStep := output.Step

	desired := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      artifactName,
			Namespace: pipeline.Namespace,
			Labels: map[string]string{
				PipelineLabelKey: pipeline.Name,
				OutputLabelKey:   output.Name,
			},
			Annotations: map[string]string{},
		},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      kind,
			Reference: reference,
			Provenance: pipelinesv1alpha1.ArtifactProvenance{
				Pipeline: pipeline.Name,
				Build:    pipeline.Status.LastExecutionID,
				Step:     producingStep,
			},
		},
	}
	if producingStep != "" {
		desired.Labels[StepLabelKey] = producingStep
		desired.Annotations[ProducingStepAnnotationKey] = producingStep
	}
	if err := controllerutil.SetControllerReference(pipeline, desired, r.Scheme); err != nil {
		return fmt.Errorf("setting owner reference: %w", err)
	}

	existing := &pipelinesv1alpha1.Artifact{}
	if err := r.client.Get(ctx, types.NamespacedName{Name: artifactName, Namespace: pipeline.Namespace}, existing); err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("getting artifact %q: %w", artifactName, err)
		}
		if err := r.client.Create(ctx, desired); err != nil {
			return fmt.Errorf("creating artifact %q: %w", artifactName, err)
		}
		return nil
	}

	updated := existing.DeepCopy()
	updated.Labels = desired.Labels
	updated.Annotations = desired.Annotations
	updated.Spec = desired.Spec
	if err := controllerutil.SetControllerReference(pipeline, updated, r.Scheme); err != nil {
		return fmt.Errorf("setting owner reference: %w", err)
	}

	if err := r.client.Update(ctx, updated); err != nil {
		return fmt.Errorf("updating artifact %q: %w", artifactName, err)
	}
	return nil
}

func (r *PipelineReconciler) upsertPendingArtifactRef(pipeline *pipelinesv1alpha1.Pipeline, output pipelinesv1alpha1.PipelineOutput, artifactName string) {
	ref := pipelinesv1alpha1.PipelineArtifactRef{
		Name:          artifactName,
		Kind:          artifactKind(output.Path),
		Reference:     output.Path,
		Phase:         pipelinesv1alpha1.PipelineArtifactPhasePending,
		ProducingStep: output.Step,
	}
	if r.Clock != nil {
		ref.CreatedAt = r.Clock.Now().Unix()
	} else {
		ref.CreatedAt = time.Now().Unix()
	}
	for i := range pipeline.Status.ArtifactRefs {
		if pipeline.Status.ArtifactRefs[i].Name == ref.Name && pipeline.Status.ArtifactRefs[i].ProducingStep == ref.ProducingStep {
			pipeline.Status.ArtifactRefs[i] = ref
			return
		}
	}
	pipeline.Status.ArtifactRefs = append(pipeline.Status.ArtifactRefs, ref)
}

func artifactKind(path string) string {
	kind, _, err := parseArtifactReference(path)
	if err != nil {
		return ""
	}
	return kind
}

func (r *PipelineReconciler) syncArtifactRefs(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, artifacts []pipelinesv1alpha1.Artifact) {
	for i := range artifacts {
		artifact := &artifacts[i]
		ref := convertArtifactToPipelineArtifactRef(artifact)
		prev := r.findArtifactRef(pipeline, ref.Name, ref.ProducingStep)
		if prev != nil && prev.Phase != ref.Phase {
			r.publishPipelineArtifactEvent(ctx, pipeline, &ref, string(prev.Phase))
		}
		r.upsertArtifactRef(pipeline, &ref)
	}
}

func (r *PipelineReconciler) findArtifactRef(pipeline *pipelinesv1alpha1.Pipeline, name, producingStep string) *pipelinesv1alpha1.PipelineArtifactRef {
	for i := range pipeline.Status.ArtifactRefs {
		if pipeline.Status.ArtifactRefs[i].Name == name && pipeline.Status.ArtifactRefs[i].ProducingStep == producingStep {
			return &pipeline.Status.ArtifactRefs[i]
		}
	}
	return nil
}

func (r *PipelineReconciler) upsertArtifactRef(pipeline *pipelinesv1alpha1.Pipeline, ref *pipelinesv1alpha1.PipelineArtifactRef) {
	for i := range pipeline.Status.ArtifactRefs {
		if pipeline.Status.ArtifactRefs[i].Name == ref.Name && pipeline.Status.ArtifactRefs[i].ProducingStep == ref.ProducingStep {
			createdAt := pipeline.Status.ArtifactRefs[i].CreatedAt
			pipeline.Status.ArtifactRefs[i] = *ref
			pipeline.Status.ArtifactRefs[i].CreatedAt = createdAt
			return
		}
	}
	pipeline.Status.ArtifactRefs = append(pipeline.Status.ArtifactRefs, *ref)
}

func convertArtifactToPipelineArtifactRef(a *pipelinesv1alpha1.Artifact) pipelinesv1alpha1.PipelineArtifactRef {
	phase := pipelinesv1alpha1.PipelineArtifactPhasePending
	cond := meta.FindStatusCondition(a.Status.Conditions, "Ready")
	if cond != nil {
		switch cond.Status {
		case metav1.ConditionTrue:
			phase = pipelinesv1alpha1.PipelineArtifactPhaseReady
		case metav1.ConditionFalse:
			phase = pipelinesv1alpha1.PipelineArtifactPhaseFailed
		case metav1.ConditionUnknown:
			phase = pipelinesv1alpha1.PipelineArtifactPhasePending
		}
	}
	return pipelinesv1alpha1.PipelineArtifactRef{
		Name:              a.Name,
		Kind:              a.Spec.Type,
		Reference:         artifactPathFromSpec(&a.Spec),
		ResolvedReference: buildResolvedReference(a),
		Digest:            a.Status.ResolvedDigest,
		Phase:             phase,
		ProducingStep:     a.Spec.Provenance.Step,
		CreatedAt:         a.CreationTimestamp.Unix(),
	}
}

func artifactPathFromSpec(spec *pipelinesv1alpha1.ArtifactSpec) string {
	if spec.Type == "" && spec.Reference == "" {
		return ""
	}
	return spec.Type + "://" + spec.Reference
}

func buildResolvedReference(a *pipelinesv1alpha1.Artifact) string {
	if a.Spec.Type == "oci" && a.Status.ResolvedDigest != "" {
		ref := a.Spec.Reference
		if idx := strings.Index(ref, "@sha256:"); idx != -1 {
			ref = ref[:idx]
		}
		return ref + "@" + a.Status.ResolvedDigest
	}
	return a.Spec.Reference
}

func (r *PipelineReconciler) cleanupStaleArtifacts(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, artifacts []pipelinesv1alpha1.Artifact, expected map[string]struct{}) error {
	log := logf.FromContext(ctx)
	var errs []error
	for i := range artifacts {
		artifact := &artifacts[i]
		if _, ok := expected[artifact.Name]; ok {
			continue
		}
		if err := r.client.Delete(ctx, artifact); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			log.Error(err, "Failed to delete stale artifact", "artifact", artifact.Name)
			errs = append(errs, fmt.Errorf("deleting artifact %q: %w", artifact.Name, err))
			continue
		}
	}

	var filtered []pipelinesv1alpha1.PipelineArtifactRef
	for _, ref := range pipeline.Status.ArtifactRefs {
		if _, ok := expected[ref.Name]; ok {
			filtered = append(filtered, ref)
		}
	}
	pipeline.Status.ArtifactRefs = filtered

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

func (r *PipelineReconciler) publishPipelineArtifactEvent(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, ref *pipelinesv1alpha1.PipelineArtifactRef, previousPhase string) {
	if r.EventBroker == nil {
		return
	}
	payload := PipelineArtifactEventPayload{
		ResourceType:  events.TypePipelineArtifact,
		Pipeline:      pipeline.Name,
		Namespace:     pipeline.Namespace,
		Name:          ref.Name,
		Kind:          ref.Kind,
		Phase:         string(ref.Phase),
		PreviousPhase: previousPhase,
		Reference:     ref.Reference,
		Digest:        ref.Digest,
		ProducingStep: ref.ProducingStep,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
	}
	evt, err := events.NewEvent(events.TypePipelineArtifact, payload, r.Clock)
	if err != nil {
		logf.FromContext(ctx).Error(err, "Failed to create pipeline-artifact event", "artifact", ref.Name)
		return
	}
	r.EventBroker.Publish(ctx, events.TopicDashboard, evt)
}

// PipelineArtifactEventPayload is the SSE payload shape for artifact phase changes.
type PipelineArtifactEventPayload struct {
	ResourceType  string `json:"resourceType"`
	Pipeline      string `json:"pipeline"`
	Namespace     string `json:"namespace"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Phase         string `json:"phase"`
	PreviousPhase string `json:"previousPhase,omitempty"`
	Reference     string `json:"reference,omitempty"`
	Digest        string `json:"digest,omitempty"`
	ProducingStep string `json:"producingStep,omitempty"`
	Timestamp     string `json:"timestamp"`
}

// SetupWithManager sets up the controller with the Manager.
func (r *PipelineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Pipeline{}).
		Owns(&pipelinesv1alpha1.Artifact{}).
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
