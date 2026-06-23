package pipelines

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
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
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
// +kubebuilder:rbac:groups=clusters.paprika.io,resources=clusters,verbs=get;list;watch

// Reconcile handles Stage reconciliation.
//
//nolint:cyclop,nestif // stage reconciliation has sequential validation branches.
func (r *StageReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("stage", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("stage").Observe(metrics.Since(r.Clock, start))
	}()

	log := log.FromContext(ctx)

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

	status := metav1.ConditionTrue
	reason := "Validated"
	message := fmt.Sprintf("Stage %q is valid", stage.Name)

	for _, tmplName := range stage.Spec.Templates {
		var tmpl pipelinesv1alpha1.Template
		if err := r.client.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: tmplName}, &tmpl); err != nil {
			status = metav1.ConditionFalse
			reason = "TemplateNotFound"
			message = fmt.Sprintf("Referenced template %q not found", tmplName)
			log.Error(err, "Referenced template not found", "template", tmplName, "stage", req.Name)
			break
		}
	}

	if status == metav1.ConditionTrue && stage.Spec.Cluster.Name != "" {
		clusterNs := stage.Spec.Cluster.Namespace
		if clusterNs == "" {
			clusterNs = req.Namespace
		}
		var cluster clustersv1alpha1.Cluster
		if err := r.client.Get(ctx, types.NamespacedName{Name: stage.Spec.Cluster.Name, Namespace: clusterNs}, &cluster); err != nil {
			status = metav1.ConditionFalse
			if apierrors.IsNotFound(err) {
				reason = "ClusterNotFound"
				message = fmt.Sprintf("Referenced cluster %q not found", stage.Spec.Cluster.Name)
			} else {
				reason = "ClusterLookupFailed"
				message = fmt.Sprintf("Could not resolve cluster %q: %v", stage.Spec.Cluster.Name, err)
			}
			log.Error(err, "Referenced cluster lookup failed", "cluster", stage.Spec.Cluster.Name, "stage", req.Name)
		}
	}

	if status == metav1.ConditionTrue && stage.Spec.Canary != nil && stage.Spec.RolloutStrategy != nil {
		status = metav1.ConditionFalse
		reason = "InvalidStrategy"
		message = "canary and rolloutStrategy are mutually exclusive"
	}

	stage.Status.ObservedGeneration = stage.Generation
	meta.SetStatusCondition(&stage.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: stage.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.client.Status().Update(ctx, &stage); err != nil {
		result = resultError
		if apierrors.IsConflict(err) {
			log.Info("Conflict updating Stage status; will retry", "stage", stage.Name)
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("failed to update stage status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *StageReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.Clock == nil {
		r.Clock = clock.Real{}
	}
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Stage{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 3}).
		Named("stage").
		Complete(r); err != nil {
		return fmt.Errorf("unable to create stage controller: %w", err)
	}
	return nil
}
