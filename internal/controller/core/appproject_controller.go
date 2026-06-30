package core

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	"github.com/benebsworth/paprika/internal/observability"
)

// AppProjectReconciler reconciles a AppProject object.
type AppProjectReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects/finalizers,verbs=update

// Reconcile validates the project spec and records readiness.
func (r *AppProjectReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "AppProject", req)
	defer func() { endSpan(spanErr) }()

	log := log.FromContext(ctx)

	var project corev1alpha1.AppProject
	if err := r.client.Get(ctx, req.NamespacedName, &project); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("get appproject: %w", err)
		}
		return ctrl.Result{}, nil
	}

	validateErr := validateAppProject(&project)

	status := metav1.ConditionTrue
	reason := "Validated"
	message := fmt.Sprintf("AppProject %q is valid", project.Name)
	if validateErr != nil {
		status = metav1.ConditionFalse
		reason = "Invalid"
		message = validateErr.Error()
		log.Info("AppProject validation failed", "appproject", project.Name, "error", validateErr)
	}

	project.Status.ObservedGeneration = project.Generation
	meta.SetStatusCondition(&project.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: project.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.client.Status().Update(ctx, &project); err != nil {
		if apierrors.IsConflict(err) {
			log.Info("Conflict updating AppProject status; will retry", "appproject", project.Name)
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("update appproject status: %w", err)
	}
	return ctrl.Result{}, nil
}

//nolint:cyclop // appproject validation has sequential guard branches.
func validateAppProject(project *corev1alpha1.AppProject) error {
	for i, d := range project.Spec.Destinations {
		if d.Server == "" && d.Name == "" && d.Namespace == "" {
			return fmt.Errorf("destination %d must specify server, name, or namespace", i)
		}
		if d.Server != "" {
			if _, err := url.Parse(d.Server); err != nil {
				return fmt.Errorf("destination %d server %q is not a valid URL", i, d.Server)
			}
		}
	}

	if overlap(project.Spec.SourceRepos, project.Spec.SourceReposDeny) {
		return errors.New("sourceRepos and sourceReposDeny overlap")
	}
	if overlap(project.Spec.Kinds, project.Spec.KindsDeny) {
		return errors.New("kinds and kindsDeny overlap")
	}
	if overlap(project.Spec.ClusterResourceWhitelist, project.Spec.ClusterResourceBlacklist) {
		return errors.New("clusterResourceWhitelist and clusterResourceBlacklist overlap")
	}

	for i, role := range project.Spec.Roles {
		if role.Name == "" {
			return fmt.Errorf("role %d name is required", i)
		}
		for _, action := range role.Actions {
			if action == "" {
				return fmt.Errorf("role %q contains an empty action", role.Name)
			}
		}
	}

	if project.Spec.Limits != nil {
		if project.Spec.Limits.MaxApplications < 0 {
			return errors.New("maxApplications must be non-negative")
		}
		if project.Spec.Limits.MaxReleases < 0 {
			return errors.New("maxReleases must be non-negative")
		}
	}

	return nil
}

func overlap(allow, deny []string) bool {
	for _, a := range allow {
		for _, d := range deny {
			if a == d && a != "" {
				return true
			}
		}
	}
	return false
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
