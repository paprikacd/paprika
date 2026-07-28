package pipelines

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/metrics"
)

const (
	// canaryReadinessRequeueInterval is how long the controller waits before
	// re-checking workload readiness while a canary step has not converged.
	canaryReadinessRequeueInterval = 15 * time.Second

	// defaultCanaryProgressDeadline is used when CanaryConfig does not set
	// ProgressDeadlineSeconds. Mirrors the apps/v1 Deployment default.
	defaultCanaryProgressDeadline = 600 * time.Second

	// progressDeadlineExceededReason is the condition reason set when a canary
	// step's workloads fail to converge within the progress deadline.
	progressDeadlineExceededReason = "ProgressDeadlineExceeded"
)

// getCanaryProgressDeadline returns the configured progress deadline for a
// canary step, defaulting to defaultCanaryProgressDeadline. Nil-safe.
func (r *ReleaseReconciler) getCanaryProgressDeadline(canaryCfg *paprikav1.CanaryConfig) time.Duration {
	if canaryCfg != nil && canaryCfg.ProgressDeadlineSeconds > 0 {
		return time.Duration(canaryCfg.ProgressDeadlineSeconds) * time.Second
	}
	return defaultCanaryProgressDeadline
}

// gateCanaryAdvance is the workload-readiness gate that runs before a canary
// release advances to its next step and before it is promoted to
// Verifying/Complete. It verifies that every apps/v1 Deployment in the most
// recently applied canary render has converged on the target cluster.
//
// Deadline semantics: the progress deadline is measured from
// CanaryStepStartedAt — the moment the current step's manifests were applied —
// NOT from when the step-interval throttle opened. checkCanaryThrottle already
// keeps readiness from being evaluated before stepIdx*interval has elapsed, so
// a step effectively gets max(throttle wait, progressDeadlineSeconds)
// wall-clock time to converge: if the throttle window exceeds the deadline and
// the workloads are still unready when it opens, the release fails at the
// first readiness evaluation (it already had longer than the deadline).
//
// Returns blocked=true when the caller must stop advancing this reconcile:
// either with a requeue (still waiting) or after the release was failed with
// reason ProgressDeadlineExceeded.
func (r *ReleaseReconciler) gateCanaryAdvance(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, canaryCfg *paprikav1.CanaryConfig, result *string) (res ctrl.Result, blocked bool, err error) {
	log := logf.FromContext(ctx)

	// No canary step has been applied yet (first step of a fresh canary):
	// there is nothing canary-rendered to verify, and no deadline anchor.
	// The first step applies immediately, preserving pre-gate timing.
	if release.Status.CanaryStepStartedAt == nil {
		return ctrl.Result{}, false, nil
	}

	ready, reason, err := r.canaryWorkloadsReady(ctx, release, stage)
	if err != nil {
		// Fail-safe: if live state cannot be fetched (RBAC, unreachable
		// remote cluster, transient API errors) we treat the workloads as NOT
		// ready so a broken release converges toward the progress deadline
		// and rollback — never toward Complete. Agent-mode clusters are the
		// deliberate exception (see canaryWorkloadsReady).
		log.Error(err, "Failed to fetch live canary workload state; treating as not ready",
			"release", release.Name, "step", release.Status.CanaryStepIndex, "weight", release.Status.CanaryWeight)
		ready = false
		if reason == "" {
			reason = "live workload state unavailable: " + err.Error()
		}
	}
	if ready {
		return ctrl.Result{}, false, nil
	}

	deadline := r.getCanaryProgressDeadline(canaryCfg)
	waited := r.now().Sub(release.Status.CanaryStepStartedAt.Time)
	if waited > deadline {
		res, failErr := r.failCanaryProgressDeadline(ctx, release, reason, waited, deadline, result)
		return res, true, failErr
	}

	log.Info("Canary workloads not ready; waiting before advancing",
		"release", release.Name, "step", release.Status.CanaryStepIndex,
		"weight", release.Status.CanaryWeight, "reason", reason,
		"waited", waited.Truncate(time.Second), "deadline", deadline)
	return ctrl.Result{RequeueAfter: canaryReadinessRequeueInterval}, true, nil
}

// canaryWorkloadsReady reports whether every apps/v1 Deployment in the
// release's most recently applied canary render has converged on the target
// cluster: the live object's generation has been observed and
// spec.replicas (default 1) == updated == ready == available replicas.
//
// Manifests are read from the per-weight canary snapshot ConfigMap that
// applyCanaryWeight stored at apply time (`<stage>-canary-<weight>`): it is
// exactly the render that was applied (post-governance), so no re-render is
// needed and template drift between reconciles cannot skew the check.
//
// Live state is fetched with the same cluster resolution the apply path uses
// (resolveClusterRef + resolveDynamicClient). Agent-mode clusters apply
// through the remote agent's HTTP API, which exposes no read path for live
// workload state from the management cluster — for those the gate is skipped
// (legacy timer-driven behavior) rather than wedging every agent-mode canary
// into a guaranteed deadline failure.
//
//nolint:cyclop // readiness gate branches on cluster mode, snapshot presence, and per-Deployment convergence.
func (r *ReleaseReconciler) canaryWorkloadsReady(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage) (ready bool, reason string, err error) {
	log := logf.FromContext(ctx)

	resolvedCluster, err := r.resolveClusterRef(ctx, &stage.Spec.Cluster, release.Namespace)
	if err != nil {
		return false, "", fmt.Errorf("resolve cluster ref for readiness gate: %w", err)
	}
	if resolvedCluster.Mode == paprikav1.ClusterModeAgent || resolvedCluster.AgentAddress != "" {
		log.Info("Agent-mode cluster has no live read path; skipping canary readiness gate",
			"release", release.Name, "cluster", resolvedCluster.Name)
		return true, "agent-mode cluster: readiness gate skipped", nil
	}

	docs, found, err := r.lastAppliedCanaryManifests(ctx, release, stage)
	if err != nil {
		return false, "", fmt.Errorf("load canary manifest snapshot: %w", err)
	}
	if !found {
		// Fail-safe: without the applied render we cannot verify anything, so
		// the step is treated as not ready and converges toward the deadline
		// rather than promoting unverified workloads.
		return false, fmt.Sprintf("canary manifest snapshot %q not found", canarySnapshotName(stage, release.Status.CanaryWeight)), nil
	}

	deployments := r.filterDeploymentDocs(docs)
	if len(deployments) == 0 {
		return true, "no Deployments rendered", nil
	}

	dynClient, err := r.resolveDynamicClient(ctx, resolvedCluster.KubeconfigSecret, release.Namespace)
	if err != nil {
		return false, "", fmt.Errorf("resolve dynamic client for readiness gate: %w", err)
	}

	deploymentGVR := knownGVRs["Deployment"]
	for _, dep := range deployments {
		name, namespace := manifestNameAndNamespace(dep, release.Namespace)
		if name == "" {
			continue
		}
		live, getErr := dynClient.Resource(deploymentGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
		if apierrors.IsNotFound(getErr) {
			return false, fmt.Sprintf("deployment %s/%s not found", namespace, name), nil
		}
		if getErr != nil {
			return false, "", fmt.Errorf("get deployment %s/%s: %w", namespace, name, getErr)
		}
		converged, why := deploymentConverged(live)
		if !converged {
			return false, fmt.Sprintf("deployment %s/%s: %s", namespace, name, why), nil
		}
	}
	return true, "", nil
}

// canarySnapshotName returns the name applyCanaryWeight uses for the
// per-weight canary manifest snapshot ConfigMap.
func canarySnapshotName(stage *paprikav1.Stage, weight int) string {
	return fmt.Sprintf("%s-canary-%d", stage.Name, weight)
}

// lastAppliedCanaryManifests loads the rendered documents of the most recently
// applied canary step from its snapshot ConfigMap.
func (r *ReleaseReconciler) lastAppliedCanaryManifests(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage) (docs [][]byte, found bool, err error) {
	name := canarySnapshotName(stage, release.Status.CanaryWeight)
	var cm corev1.ConfigMap
	if err := r.client.Get(ctx, types.NamespacedName{Name: name, Namespace: release.Namespace}, &cm); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("get canary snapshot %q: %w", name, err)
	}
	data, ok := cm.Data["manifests.yaml"]
	if !ok {
		return nil, false, nil
	}
	return engine.SplitYAMLDocuments([]byte(data)), true, nil
}

// filterDeploymentDocs parses rendered documents and returns the apps/v1
// Deployment objects among them. Non-Deployment kinds are ignored — they are
// treated as trivially ready by the gate.
func (r *ReleaseReconciler) filterDeploymentDocs(docs [][]byte) []map[string]interface{} {
	var out []map[string]interface{}
	for _, doc := range docs {
		obj, ok := r.parseManifest(doc)
		if !ok {
			continue
		}
		kind, kindOK := obj["kind"].(string)
		apiVersion, versionOK := obj["apiVersion"].(string)
		if kindOK && versionOK && kind == "Deployment" && apiVersion == "apps/v1" {
			out = append(out, obj)
		}
	}
	return out
}

// manifestNameAndNamespace extracts metadata.name and metadata.namespace from
// a parsed manifest without mutating it (unlike setTargetNamespace, which the
// apply path uses). The fallback namespace mirrors the apply path's default.
func manifestNameAndNamespace(obj map[string]interface{}, fallbackNamespace string) (name, namespace string) {
	metadata, ok := obj["metadata"].(map[string]interface{})
	if !ok || metadata == nil {
		return "", ""
	}
	if n, isStr := metadata["name"].(string); isStr {
		name = n
	}
	if ns, isStr := metadata["namespace"].(string); isStr {
		namespace = ns
	}
	if namespace == "" {
		namespace = fallbackNamespace
	}
	return name, namespace
}

// deploymentConverged reports whether a live apps/v1 Deployment has fully
// converged: its latest generation has been observed by the deployment
// controller and spec.replicas (default 1) == updatedReplicas ==
// readyReplicas == availableReplicas.
//
//nolint:cyclop // convergence check inspects observedGeneration plus four replica counters.
func deploymentConverged(obj *unstructured.Unstructured) (converged bool, reason string) {
	generation := obj.GetGeneration()
	observed, found, err := unstructured.NestedInt64(obj.Object, "status", "observedGeneration")
	if err != nil || !found || observed < generation {
		return false, fmt.Sprintf("observedGeneration %d < generation %d", observed, generation)
	}

	specReplicas := int64(1)
	if v, ok, verr := unstructured.NestedInt64(obj.Object, "spec", "replicas"); verr == nil && ok {
		specReplicas = v
	}
	updated, _, uerr := unstructured.NestedInt64(obj.Object, "status", "updatedReplicas")
	ready, _, rerr := unstructured.NestedInt64(obj.Object, "status", "readyReplicas")
	available, _, aerr := unstructured.NestedInt64(obj.Object, "status", "availableReplicas")
	if uerr != nil || rerr != nil || aerr != nil {
		return false, "malformed deployment status: replica counts are not integers"
	}
	if updated != specReplicas || ready != specReplicas || available != specReplicas {
		return false, fmt.Sprintf("want %d replicas, have updated=%d ready=%d available=%d",
			specReplicas, updated, ready, available)
	}
	return true, ""
}

// failCanaryProgressDeadline transitions the release to Failed with reason
// ProgressDeadlineExceeded. OnFailure=rollback is then handled by the regular
// shouldRollback path on the next reconcile, restoring the previous good
// release.
func (r *ReleaseReconciler) failCanaryProgressDeadline(ctx context.Context, release *paprikav1.Release, reason string, waited, deadline time.Duration, result *string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	log.Info("Canary progress deadline exceeded; failing release",
		"release", release.Name, "step", release.Status.CanaryStepIndex,
		"weight", release.Status.CanaryWeight, "waited", waited.Truncate(time.Second),
		"deadline", deadline, "reason", reason)

	oldPhase := release.Status.Phase
	release.Status.Phase = paprikav1.ReleaseFailed
	metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
	release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
		Type:               "CanaryFailed",
		Status:             metav1.ConditionTrue,
		LastTransitionTime: metav1.Now(),
		Reason:             progressDeadlineExceededReason,
		Message: fmt.Sprintf("canary step %d (weight %d%%) workloads did not converge within %s: %s",
			release.Status.CanaryStepIndex, release.Status.CanaryWeight, deadline, reason),
	})
	if len(release.Status.PromotionHistory) > 0 {
		release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "CanaryFailed"
	}
	if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
		*result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to set release failed after progress deadline: %w", err)
	}
	return ctrl.Result{}, nil
}
