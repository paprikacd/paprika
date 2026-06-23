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

package policy

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/policy"
)

const (
	policyResultSuccess = "success"
	policyResultError   = "error"
)

// PolicyReconciler reconciles a Policy object.
type PolicyReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
	Clock  clock.Clock
}

// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies/finalizers,verbs=update

// Reconcile compiles the policy expression and records the outcome in status.
func (r *PolicyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := policyResultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("policy", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("policy").Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)

	var pol policyv1alpha1.Policy
	if err := r.client.Get(ctx, req.NamespacedName, &pol); err != nil {
		result = policyResultError
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("getting policy: %w", err)
		}
		return ctrl.Result{}, nil
	}

	compileErr := policy.CompileExpression(pol.Spec.Expression)

	status := metav1.ConditionTrue
	reason := "Compiled"
	message := "Policy expression compiled successfully"
	if compileErr != nil {
		result = policyResultError
		status = metav1.ConditionFalse
		reason = "CompileFailed"
		message = compileErr.Error()
		log.Info("Policy expression failed to compile", "policy", pol.Name, "error", compileErr)
	}

	pol.Status.ObservedGeneration = pol.Generation
	meta.SetStatusCondition(&pol.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: pol.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.client.Status().Update(ctx, &pol); err != nil {
		result = policyResultError
		if apierrors.IsConflict(err) {
			log.Info("Conflict updating Policy status; will retry", "policy", pol.Name)
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("updating policy status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *PolicyReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.Clock == nil {
		r.Clock = clock.Real{}
	}
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&policyv1alpha1.Policy{}).
		Named("policy-policy").
		Complete(r); err != nil {
		return fmt.Errorf("failed to setup Policy controller: %w", err)
	}
	return nil
}
