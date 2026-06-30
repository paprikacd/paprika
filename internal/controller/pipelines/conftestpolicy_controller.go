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
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/conftest"
	"github.com/benebsworth/paprika/internal/observability"
)

// ConftestPolicyReconciler compiles a ConftestPolicy and writes an informational Ready
// condition. It writes status only; it never gates promotion (the release controller's
// evaluator is authoritative — see the design spec, "Source of truth").
type ConftestPolicyReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies/status,verbs=get;update;patch

func (r *ConftestPolicyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "ConftestPolicy", req)
	defer func() { endSpan(spanErr) }()

	log := log.FromContext(ctx)

	var policy paprikav1.ConftestPolicy
	if err := r.Get(ctx, req.NamespacedName, &policy); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("getting conftestpolicy: %w", err)
	}

	compileErr := conftest.CompilePolicy(ctx, policy.Name, policy.Spec.Rego)

	status := metav1.ConditionFalse
	reason := "CompileError"
	var message string
	if compileErr == nil {
		status = metav1.ConditionTrue
		reason = "Compiled"
		message = "Policy compiled successfully"
	} else {
		message = compileErr.Error()
		log.Info("ConftestPolicy failed to compile", "policy", policy.Name, "error", compileErr)
	}

	patch := client.MergeFrom(policy.DeepCopy())
	meta.SetStatusCondition(&policy.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: policy.Generation,
		LastTransitionTime: metav1.Now(),
	})
	policy.Status.ObservedGeneration = policy.Generation

	if err := r.Status().Patch(ctx, &policy, patch); err != nil {
		return ctrl.Result{}, fmt.Errorf("patching conftestpolicy status: %w", err)
	}
	return ctrl.Result{}, nil
}

// SetupWithManager registers the reconciler to watch ConftestPolicy resources.
func (r *ConftestPolicyReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewControllerManagedBy(mgr).For(&paprikav1.ConftestPolicy{}).Complete(r); err != nil {
		return fmt.Errorf("setting up conftestpolicy controller: %w", err)
	}
	return nil
}
