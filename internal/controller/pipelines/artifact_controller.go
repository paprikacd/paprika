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

package pipelines

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/oci"
	"github.com/benebsworth/paprika/internal/sharding"
)

const resultSuccess = "success"
const resultError = "error"

// ArtifactReconciler reconciles a Artifact object.
type ArtifactReconciler struct {
	client      client.Client
	Scheme      *runtime.Scheme
	ShardFilter *sharding.Filter
	Clock       clock.Clock
	Verifier    oci.Verifier
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list
// +kubebuilder:rbac:groups="",resources=configmaps/status,verbs=get

// Reconcile verifies the artifact reference and updates status.
//
//nolint:cyclop // artifact reconciliation branches on type.
func (r *ArtifactReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("artifact", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("artifact").Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)

	var artifact pipelinesv1alpha1.Artifact
	if err := r.client.Get(ctx, req.NamespacedName, &artifact); err != nil {
		result = resultError
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("getting artifact: %w", err)
		}
		return ctrl.Result{}, nil
	}

	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping artifact not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	switch artifact.Spec.Type {
	case "oci":
		if err := r.reconcileOCI(ctx, &artifact, &result); err != nil {
			return r.handleStatusUpdateError(ctx, err, &result, artifact.Name)
		}
	case "configmap":
		if err := r.reconcileConfigMap(ctx, &artifact, &result); err != nil {
			return r.handleStatusUpdateError(ctx, err, &result, artifact.Name)
		}
	default:
		if err := r.setFailed(ctx, &artifact, "VerificationFailed", fmt.Sprintf("unsupported artifact type %q", artifact.Spec.Type), &result); err != nil {
			return r.handleStatusUpdateError(ctx, err, &result, artifact.Name)
		}
	}

	return ctrl.Result{}, nil
}

func (r *ArtifactReconciler) handleStatusUpdateError(ctx context.Context, err error, result *string, name string) (ctrl.Result, error) {
	log := log.FromContext(ctx)
	*result = resultError
	if apierrors.IsConflict(err) {
		log.Info("Conflict updating Artifact status; will retry", "artifact", name)
		return ctrl.Result{Requeue: true}, nil
	}
	return ctrl.Result{}, err
}

func (r *ArtifactReconciler) setFailed(
	ctx context.Context,
	artifact *pipelinesv1alpha1.Artifact,
	reason, message string,
	result *string,
) error {
	log := log.FromContext(ctx)
	log.Info("Artifact verification failed", "artifact", artifact.Name, "reason", reason, "message", message)

	artifact.Status.Verified = false
	artifact.Status.ObservedGeneration = artifact.Generation
	meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: artifact.Generation,
		LastTransitionTime: metav1.Now(),
	})
	if err := r.client.Status().Update(ctx, artifact); err != nil {
		return fmt.Errorf("updating artifact status: %w", err)
	}
	*result = resultError
	return nil
}

func (r *ArtifactReconciler) setReady(
	ctx context.Context,
	artifact *pipelinesv1alpha1.Artifact,
	message string,
) error {
	artifact.Status.Verified = true
	artifact.Status.ObservedGeneration = artifact.Generation
	meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionTrue,
		Reason:             "Verified",
		Message:            message,
		ObservedGeneration: artifact.Generation,
		LastTransitionTime: metav1.Now(),
	})
	if err := r.client.Status().Update(ctx, artifact); err != nil {
		return fmt.Errorf("updating artifact status: %w", err)
	}
	return nil
}

func (r *ArtifactReconciler) reconcileOCI(
	ctx context.Context,
	artifact *pipelinesv1alpha1.Artifact,
	result *string,
) error {
	if artifact.Spec.Reference == "" {
		return r.setFailed(ctx, artifact, "VerificationFailed", "oci artifact reference is required", result)
	}

	verifier := r.Verifier
	if verifier == nil {
		verifier = oci.NewVerifier()
	}

	digest, err := verifier.Verify(ctx, artifact.Spec.Reference)
	if err != nil {
		return r.setFailed(ctx, artifact, "VerificationFailed", "verify oci reference: "+err.Error(), result)
	}

	if artifact.Spec.Digest != "" && digest != artifact.Spec.Digest {
		log := log.FromContext(ctx)
		log.Info("Artifact digest mismatch", "artifact", artifact.Name, "resolved", digest, "expected", artifact.Spec.Digest)
		return r.setFailed(ctx, artifact, "DigestMismatch", fmt.Sprintf("resolved digest %s does not match spec digest %s", digest, artifact.Spec.Digest), result)
	}

	artifact.Status.ResolvedDigest = digest
	return r.setReady(ctx, artifact, fmt.Sprintf("Resolved artifact %q", artifact.Spec.Reference))
}

func (r *ArtifactReconciler) reconcileConfigMap(
	ctx context.Context,
	artifact *pipelinesv1alpha1.Artifact,
	result *string,
) error {
	name, key, err := parseConfigMapReference(artifact.Spec.Reference)
	if err != nil {
		return r.setFailed(ctx, artifact, "InvalidReference", err.Error(), result)
	}

	var cm corev1.ConfigMap
	if err := r.client.Get(ctx, types.NamespacedName{Name: name, Namespace: artifact.Namespace}, &cm); err != nil {
		if apierrors.IsNotFound(err) {
			return r.setFailed(ctx, artifact, "ConfigMapNotFound", fmt.Sprintf("configmap %s not found", name), result)
		}
		return fmt.Errorf("getting configmap %s: %w", name, err)
	}

	resolvedKey, keyErr := resolveConfigMapKey(&cm, key)
	if keyErr != nil {
		var e *configMapKeyError
		if errors.As(keyErr, &e) {
			return r.setFailed(ctx, artifact, e.reason, e.message, result)
		}
		return r.setFailed(ctx, artifact, "VerificationFailed", keyErr.Error(), result)
	}

	return r.setReady(ctx, artifact, fmt.Sprintf("key %s verified", resolvedKey))
}

// SetupWithManager sets up the controller with the Manager.
func (r *ArtifactReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.Clock == nil {
		r.Clock = clock.Real{}
	}
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Artifact{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Named("artifact").
		Complete(r); err != nil {
		return fmt.Errorf("setting up artifact controller: %w", err)
	}
	return nil
}
