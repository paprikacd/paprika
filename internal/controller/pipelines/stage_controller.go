package pipelines

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/sharding"
)

// StageReconciler reconciles Stage resources.
type StageReconciler struct {
	client      client.Client
	Scheme      *runtime.Scheme
	ShardFilter *sharding.Filter
	Clock       clock.Clock
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch

// Reconcile handles Stage reconciliation.
func (r *StageReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("stage", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("stage").Observe(metrics.Since(r.Clock, start))
	}()

	log := logf.FromContext(ctx)

	var stage pipelinesv1alpha1.Stage
	if err := r.client.Get(ctx, req.NamespacedName, &stage); err != nil {
		result = resultError
		k8sErr := client.IgnoreNotFound(err)
		if k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("failed to get stage: %w", k8sErr)
		}
		return ctrl.Result{}, nil
	}

	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping stage not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	for _, tmplName := range stage.Spec.Templates {
		var tmpl pipelinesv1alpha1.Template
		if err := r.client.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: tmplName}, &tmpl); err != nil {
			log.Error(err, "Referenced template not found", "template", tmplName, "stage", req.Name)
			continue
		}
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *StageReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Stage{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 3}).
		Named("stage").
		Complete(r); err != nil {
		return fmt.Errorf("unable to create stage controller: %w", err)
	}
	return nil
}
