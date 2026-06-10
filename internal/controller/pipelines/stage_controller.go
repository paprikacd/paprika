package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

type StageReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch

func (r *StageReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var stage pipelinesv1alpha1.Stage
	if err := r.Get(ctx, req.NamespacedName, &stage); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	for _, tmplName := range stage.Spec.Templates {
		var tmpl pipelinesv1alpha1.Template
		if err := r.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: tmplName}, &tmpl); err != nil {
			log.Error(err, "Referenced template not found", "template", tmplName, "stage", req.Name)
			continue
		}
	}

	return ctrl.Result{}, nil
}

func (r *StageReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Stage{}).
		Named("stage").
		Complete(r)
}
