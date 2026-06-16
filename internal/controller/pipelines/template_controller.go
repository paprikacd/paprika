package controller

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/metrics"
)

// TemplateReconciler reconciles Template resources.
type TemplateReconciler struct {
	client.Client
	Scheme      *runtime.Scheme
	ShardFilter *sharding.Filter
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates/finalizers,verbs=update

// Reconcile handles Template reconciliation.
func (r *TemplateReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer()
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("template", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("template").Observe(metrics.Since(start))
	}()

	log := logf.FromContext(ctx)

	var tmpl pipelinesv1alpha1.Template
	if err := r.Get(ctx, req.NamespacedName, &tmpl); err != nil {
		result = resultError
		k8sErr := client.IgnoreNotFound(err)
		if k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("failed to get template: %w", k8sErr)
		}
		return ctrl.Result{}, nil
	}

	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping template not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	// Template rendering is performed on-demand by Application/Release controllers;
	// this controller currently only validates that the type is known.
	switch tmpl.Spec.Type {
	case "helm", "kustomize", "git", "s3", "oci":
		// supported
	default:
		log.Info("Unsupported template type", "type", tmpl.Spec.Type, "template", req.Name)
		return ctrl.Result{}, nil
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *TemplateReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Template{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Named("template").
		Complete(r); err != nil {
		return fmt.Errorf("unable to create template controller: %w", err)
	}
	return nil
}
