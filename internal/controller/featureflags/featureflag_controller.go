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
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/featureflag"
	"github.com/benebsworth/paprika/internal/metrics"
)

// FeatureFlagReconciler reconciles FeatureFlag resources.
type FeatureFlagReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
	Clock  clock.Clock
}

// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflags,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflags/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=featureflags.paprika.io,resources=featureflags/finalizers,verbs=update

// Reconcile validates the feature flag definition and records readiness.
func (r *FeatureFlagReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileDuration.WithLabelValues("featureflag").Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)

	var flag featureflagsv1alpha1.FeatureFlag
	if err := r.client.Get(ctx, req.NamespacedName, &flag); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("getting featureflag: %w", err)
		}
		return ctrl.Result{}, nil
	}

	validateErr := validateFeatureFlag(&flag)

	status := metav1.ConditionTrue
	reason := "Validated"
	message := fmt.Sprintf("Feature flag %q is valid", flag.Name)
	if validateErr != nil {
		status = metav1.ConditionFalse
		reason = "Invalid"
		message = validateErr.Error()
		log.Info("FeatureFlag validation failed", "featureflag", flag.Name, "error", validateErr)
	}

	flag.Status.ObservedGeneration = flag.Generation
	meta.SetStatusCondition(&flag.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: flag.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.client.Status().Update(ctx, &flag); err != nil {
		if apierrors.IsConflict(err) {
			log.Info("Conflict updating FeatureFlag status; will retry", "featureflag", flag.Name)
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("updating featureflag status: %w", err)
	}

	return ctrl.Result{}, nil
}

func validateFeatureFlag(flag *featureflagsv1alpha1.FeatureFlag) error {
	if flag.Spec.Type == "" {
		return errors.New("feature flag type is required")
	}
	if err := featureflag.ValidateDefaultValue(flag.Spec.Type, flag.Spec.DefaultValue); err != nil {
		return fmt.Errorf("invalid default value: %w", err)
	}
	for i, rule := range flag.Spec.Rules {
		if rule.Condition == "" {
			return fmt.Errorf("rule %d has an empty condition", i)
		}
		if err := featureflag.ValidateValue(flag.Spec.Type, rule.Value); err != nil {
			return fmt.Errorf("rule %q value: %w", rule.Name, err)
		}
	}
	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *FeatureFlagReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.Clock == nil {
		r.Clock = clock.Real{}
	}
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&featureflagsv1alpha1.FeatureFlag{}).
		Named("featureflag").
		Complete(r); err != nil {
		return fmt.Errorf("setting up featureflag controller: %w", err)
	}
	return nil
}
