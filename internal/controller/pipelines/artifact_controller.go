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

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/sharding"
)

const resultSuccess = "success"
const resultError = "error"

// ArtifactReconciler reconciles a Artifact object
type ArtifactReconciler struct {
	client      client.Client
	Scheme      *runtime.Scheme
	ShardFilter *sharding.Filter
	Clock       clock.Clock
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts/finalizers,verbs=update

// Reconcile is part of the main kubernetes reconciliation loop which aims to
// move the current state of the cluster closer to the desired state.
// TODO(user): Modify the Reconcile function to compare the state specified by
// the Artifact object against the actual cluster state, and then
// perform operations to make the cluster state reflect the state specified by
// the user.
//
// For more details, check Reconcile and its Result here:
// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.23.3/pkg/reconcile
func (r *ArtifactReconciler) Reconcile(_ context.Context, _ ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("artifact", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("artifact").Observe(metrics.Since(r.Clock, start))
	}()

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *ArtifactReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Artifact{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Named("artifact").
		Complete(r); err != nil {
		return fmt.Errorf("setting up artifact controller: %w", err)
	}
	return nil
}
