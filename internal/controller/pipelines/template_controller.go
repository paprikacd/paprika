package pipelines

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/sharding"
)

// TemplateReconciler reconciles Template resources.
type TemplateReconciler struct {
	client      client.Client
	Scheme      *runtime.Scheme
	ShardFilter *sharding.Filter
	Clock       clock.Clock
}

func (r *TemplateReconciler) now() time.Time {
	if r.Clock != nil {
		return r.Clock.Now()
	}
	return time.Now()
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;update;patch

// Reconcile handles Template reconciliation.
func (r *TemplateReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "Template", req)
	defer func() { endSpan(spanErr) }()

	result := resultSuccess
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("template", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("template").Observe(metrics.Since(r.Clock, start))
	}()

	log := logf.FromContext(ctx)

	var tmpl pipelinesv1alpha1.Template
	if err := r.client.Get(ctx, req.NamespacedName, &tmpl); err != nil {
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

	if err := r.propagateSyncTrigger(ctx, &tmpl); err != nil {
		result = resultError
		return ctrl.Result{}, fmt.Errorf("failed to propagate sync trigger: %w", err)
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
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Template{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Named("template").
		Complete(r); err != nil {
		return fmt.Errorf("unable to create template controller: %w", err)
	}
	return nil
}

// propagateSyncTrigger forwards a paprika.io/sync annotation from a Template to
// its owner Application(s). This lets webhook pushes against a shared Template
// immediately re-sync every Application that uses it.
func (r *TemplateReconciler) propagateSyncTrigger(ctx context.Context, tmpl *pipelinesv1alpha1.Template) error {
	if !syncTriggerPresent(tmpl.Annotations) {
		return nil
	}

	log := logf.FromContext(ctx)
	log.Info("Sync trigger detected on Template, propagating to owner Applications", "template", tmpl.Name)

	ownerNames := ownerApplicationNames(tmpl)
	for _, name := range ownerNames {
		var app pipelinesv1alpha1.Application
		if err := r.client.Get(ctx, types.NamespacedName{Name: name, Namespace: tmpl.Namespace}, &app); err != nil {
			return fmt.Errorf("getting owner application %q: %w", name, err)
		}

		patch := client.MergeFrom(app.DeepCopy())
		if app.Annotations == nil {
			app.Annotations = map[string]string{}
		}
		app.Annotations[syncAnnotation] = strconv.FormatInt(r.now().Unix(), 10)
		if err := r.client.Patch(ctx, &app, patch); err != nil {
			return fmt.Errorf("annotating owner application %q: %w", name, err)
		}
	}

	patch := client.MergeFrom(tmpl.DeepCopy())
	delete(tmpl.Annotations, syncAnnotation)
	delete(tmpl.Annotations, legacyWebhookTriggerAnnotation)
	if len(tmpl.Annotations) == 0 {
		tmpl.Annotations = nil
	}
	if err := r.client.Patch(ctx, tmpl, patch); err != nil {
		return fmt.Errorf("removing sync trigger annotation from template: %w", err)
	}
	return nil
}

func ownerApplicationNames(tmpl *pipelinesv1alpha1.Template) []string {
	var names []string
	for _, ref := range tmpl.OwnerReferences {
		if ref.Kind == "Application" && ref.APIVersion == pipelinesv1alpha1.GroupVersion.Identifier() {
			names = append(names, ref.Name)
		}
	}
	return names
}
