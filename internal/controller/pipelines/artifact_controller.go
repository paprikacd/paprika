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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
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

// Reconcile verifies the artifact reference and updates status.
//
//nolint:cyclop // status reconciliation has sequential guard branches.
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

	verified, resolvedDigest, err := r.verify(ctx, &artifact)

	artifact.Status.ObservedGeneration = artifact.Generation
	artifact.Status.Verified = verified
	artifact.Status.ResolvedDigest = resolvedDigest

	status := metav1.ConditionTrue
	reason := "Verified"
	message := fmt.Sprintf("Resolved artifact %q", artifact.Spec.Reference)
	if err != nil {
		result = resultError
		status = metav1.ConditionFalse
		reason = "VerificationFailed"
		message = err.Error()
		log.Info("Artifact verification failed", "artifact", artifact.Name, "error", err)
	}

	if artifact.Spec.Digest != "" && resolvedDigest != "" && resolvedDigest != artifact.Spec.Digest {
		status = metav1.ConditionFalse
		reason = "DigestMismatch"
		message = fmt.Sprintf("resolved digest %s does not match spec digest %s", resolvedDigest, artifact.Spec.Digest)
		result = resultError
		artifact.Status.Verified = false
		log.Info("Artifact digest mismatch", "artifact", artifact.Name, "resolved", resolvedDigest, "expected", artifact.Spec.Digest)
	}

	meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: artifact.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if updateErr := r.client.Status().Update(ctx, &artifact); updateErr != nil {
		result = resultError
		if apierrors.IsConflict(updateErr) {
			log.Info("Conflict updating Artifact status; will retry", "artifact", artifact.Name)
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("updating artifact status: %w", updateErr)
	}

	return ctrl.Result{}, nil
}

func (r *ArtifactReconciler) verify(ctx context.Context, artifact *pipelinesv1alpha1.Artifact) (verified bool, digest string, err error) {
	switch artifact.Spec.Type {
	case "oci":
		if artifact.Spec.Reference == "" {
			return false, "", errors.New("oci artifact reference is required")
		}
		verifier := r.Verifier
		if verifier == nil {
			verifier = oci.NewVerifier()
		}
		digest, err = verifier.Verify(ctx, artifact.Spec.Reference)
		if err != nil {
			return false, "", fmt.Errorf("verify oci reference: %w", err)
		}
		return true, digest, nil
	default:
		return false, "", fmt.Errorf("unsupported artifact type %q", artifact.Spec.Type)
	}
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
