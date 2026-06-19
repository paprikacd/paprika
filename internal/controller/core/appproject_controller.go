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

package core

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

// AppProjectReconciler reconciles a AppProject object.
type AppProjectReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects/finalizers,verbs=update

// Reconcile records the observed generation on the AppProject status so consumers
// can detect when the spec has been processed.
func (r *AppProjectReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var project corev1alpha1.AppProject
	if err := r.client.Get(ctx, req.NamespacedName, &project); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("get appproject: %w", err)
		}
		return ctrl.Result{}, nil
	}
	if project.Status.ObservedGeneration == project.Generation {
		return ctrl.Result{}, nil
	}
	project.Status.ObservedGeneration = project.Generation
	if err := r.client.Status().Update(ctx, &project); err != nil {
		return ctrl.Result{}, fmt.Errorf("update appproject status: %w", err)
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *AppProjectReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.AppProject{}).
		Named("core-appproject").
		Complete(r); err != nil {
		return fmt.Errorf("setup appproject controller: %w", err)
	}
	return nil
}
