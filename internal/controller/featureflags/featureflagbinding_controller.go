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

package featureflags

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
)

// FeatureFlagBindingReconciler reconciles FeatureFlagBinding resources.
type FeatureFlagBindingReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
	Clock  clock.Clock
}

// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflagbindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflagbindings/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflagbindings/finalizers,verbs=update
// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflags,verbs=get;list;watch

// Reconcile validates the referenced feature flag and records readiness.
func (r *FeatureFlagBindingReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileDuration.WithLabelValues("featureflagbinding").Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)

	var binding featureflagsv1alpha1.FeatureFlagBinding
	if err := r.client.Get(ctx, req.NamespacedName, &binding); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("getting featureflagbinding: %w", err)
		}
		return ctrl.Result{}, nil
	}

	status := metav1.ConditionTrue
	reason := "Validated"
	message := fmt.Sprintf("Binding %q is valid", binding.Name)

	var flag featureflagsv1alpha1.FeatureFlag
	if err := r.client.Get(ctx, types.NamespacedName{Name: binding.Spec.FlagRef, Namespace: req.Namespace}, &flag); err != nil {
		status = metav1.ConditionFalse
		reason = "FlagNotFound"
		if apierrors.IsNotFound(err) {
			message = fmt.Sprintf("feature flag %q not found", binding.Spec.FlagRef)
		} else {
			message = fmt.Sprintf("could not resolve feature flag %q: %v", binding.Spec.FlagRef, err)
		}
		log.Info("FeatureFlagBinding could not resolve flag", "binding", binding.Name, "flag", binding.Spec.FlagRef, "error", err)
	}

	if binding.Spec.Target.Kind == "" {
		status = metav1.ConditionFalse
		reason = "InvalidTarget"
		message = "target kind is required"
	}

	binding.Status.ObservedGeneration = binding.Generation
	meta.SetStatusCondition(&binding.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: binding.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.client.Status().Update(ctx, &binding); err != nil {
		if apierrors.IsConflict(err) {
			log.Info("Conflict updating FeatureFlagBinding status; will retry", "binding", binding.Name)
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("updating featureflagbinding status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *FeatureFlagBindingReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.Clock == nil {
		r.Clock = clock.Real{}
	}
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&featureflagsv1alpha1.FeatureFlagBinding{}).
		Named("featureflagbinding").
		Complete(r); err != nil {
		return fmt.Errorf("setting up featureflagbinding controller: %w", err)
	}
	return nil
}
