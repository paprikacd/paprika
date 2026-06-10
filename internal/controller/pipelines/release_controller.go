package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/gates"
)

const releaseFinalizer = "paprika.io/release-cleanup"

var managedGVRs = []schema.GroupVersionResource{
	{Group: "apps", Version: "v1", Resource: "deployments"},
	{Group: "", Version: "v1", Resource: "services"},
	{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
}

type ReleaseReconciler struct {
	client.Client
	Scheme        *runtime.Scheme
	K8sClient     kubernetes.Interface
	DynamicClient dynamic.Interface
	Namespace     string
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=templates,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=ingresses,verbs=get;list;watch;create;update;patch;delete

func (r *ReleaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var release pipelinesv1alpha1.Release
	if err := r.Get(ctx, req.NamespacedName, &release); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !release.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&release, releaseFinalizer) {
			if err := r.cleanup(ctx, &release); err != nil {
				return ctrl.Result{}, err
			}
			controllerutil.RemoveFinalizer(&release, releaseFinalizer)
			if err := r.Update(ctx, &release); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&release, releaseFinalizer) {
		controllerutil.AddFinalizer(&release, releaseFinalizer)
		if err := r.Update(ctx, &release); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if release.Status.Phase == pipelinesv1alpha1.ReleaseComplete ||
		release.Status.Phase == pipelinesv1alpha1.ReleaseFailed ||
		release.Status.Phase == pipelinesv1alpha1.ReleaseRolledBack ||
		release.Status.Phase == pipelinesv1alpha1.ReleaseSuperseded {
		return ctrl.Result{}, nil
	}

	if release.Status.Phase == pipelinesv1alpha1.ReleasePending {
		return ctrl.Result{}, nil
	}

	if err := r.checkConcurrentRelease(ctx, &release); err != nil {
		return ctrl.Result{}, err
	}

	if release.Status.Phase == "" {
		var stage pipelinesv1alpha1.Stage
		if err := r.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: req.Namespace}, &stage); err != nil {
			return ctrl.Result{}, fmt.Errorf("target stage %q not found: %w", release.Spec.Target, err)
		}

		release.Status.Phase = pipelinesv1alpha1.ReleasePromoting
		release.Status.CurrentStage = release.Spec.Target
		release.Status.PromotionHistory = append(release.Status.PromotionHistory, pipelinesv1alpha1.PromotionEntry{
			Stage:     release.Spec.Target,
			Result:    "Pending",
			Timestamp: metav1.Now(),
		})
		if err := r.Status().Update(ctx, &release); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to set release promoting: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if release.Status.Phase == pipelinesv1alpha1.ReleasePromoting {
		if err := r.promote(ctx, &release); err != nil {
			log.Error(err, "Promotion failed", "release", req.Name)
			release.Status.Phase = pipelinesv1alpha1.ReleaseFailed
			if updateErr := r.Status().Update(ctx, &release); updateErr != nil {
				return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", updateErr)
			}
			return ctrl.Result{}, err
		}
		release.Status.Phase = pipelinesv1alpha1.ReleaseVerifying
		if err := r.Status().Update(ctx, &release); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to set release verifying: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if release.Status.Phase == pipelinesv1alpha1.ReleaseVerifying {
		allPassed := r.verify(ctx, &release)
		if allPassed {
			release.Status.Phase = pipelinesv1alpha1.ReleaseComplete
			if len(release.Status.PromotionHistory) > 0 {
				release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "Passed"
			}
			if err := r.Status().Update(ctx, &release); err != nil {
				return ctrl.Result{}, fmt.Errorf("failed to set release complete: %w", err)
			}
		} else {
			release.Status.Phase = pipelinesv1alpha1.ReleaseFailed
			if len(release.Status.PromotionHistory) > 0 {
				release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "Failed"
			}
			if err := r.Status().Update(ctx, &release); err != nil {
				return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", err)
			}
		}
	}

	if release.Status.Phase == pipelinesv1alpha1.ReleaseFailed && release.Spec.OnFailure != nil && release.Spec.OnFailure.Action == "rollback" {
		if err := r.rollback(ctx, &release); err != nil {
			return ctrl.Result{}, fmt.Errorf("rollback failed: %w", err)
		}
	}

	return ctrl.Result{}, nil
}

func (r *ReleaseReconciler) checkConcurrentRelease(ctx context.Context, release *pipelinesv1alpha1.Release) error {
	var releaseList pipelinesv1alpha1.ReleaseList
	if err := r.List(ctx, &releaseList, client.InNamespace(release.Namespace)); err != nil {
		return err
	}

	for _, other := range releaseList.Items {
		if other.Name == release.Name {
			continue
		}
		if other.Spec.Target == release.Spec.Target &&
			(other.Status.Phase == pipelinesv1alpha1.ReleasePromoting ||
				other.Status.Phase == pipelinesv1alpha1.ReleaseVerifying) {
			if release.Status.Phase == "" {
				release.Status.Phase = pipelinesv1alpha1.ReleasePending
				if err := r.Status().Update(ctx, release); err != nil {
					return fmt.Errorf("failed to set release pending: %w", err)
				}
			}
			break
		}
	}
	return nil
}

func (r *ReleaseReconciler) promote(ctx context.Context, release *pipelinesv1alpha1.Release) error {
	log := logf.FromContext(ctx)

	var stage pipelinesv1alpha1.Stage
	if err := r.Get(ctx, types.NamespacedName{Name: release.Spec.Target, Namespace: release.Namespace}, &stage); err != nil {
		return fmt.Errorf("failed to fetch stage %q: %w", release.Spec.Target, err)
	}

	var templates []pipelinesv1alpha1.Template
	for _, tmplName := range stage.Spec.Templates {
		var tmpl pipelinesv1alpha1.Template
		if err := r.Get(ctx, types.NamespacedName{Name: tmplName, Namespace: release.Namespace}, &tmpl); err != nil {
			return fmt.Errorf("failed to fetch template %q: %w", tmplName, err)
		}
		templates = append(templates, tmpl)
	}

	params := map[string]string{}
	if release.Spec.From != "" {
		params["from"] = release.Spec.From
	}

	renderer := engine.NewTemplateRenderer("/tmp/paprika-helm")
	manifests, err := renderer.RenderAll(ctx, templates, params)
	if err != nil {
		return fmt.Errorf("template rendering failed: %w", err)
	}

	snapshotName := fmt.Sprintf("%s-manifest-snapshot", stage.Name)
	if err := r.storeManifestSnapshot(ctx, release, &stage, snapshotName, manifests); err != nil {
		return fmt.Errorf("failed to store manifest snapshot: %w", err)
	}

	release.Status.RenderedManifestSnapshot = snapshotName

	log.Info("Promotion rendered manifests", "stage", stage.Name, "bytes", len(manifests))
	return nil
}

func (r *ReleaseReconciler) storeManifestSnapshot(ctx context.Context, release *pipelinesv1alpha1.Release, stage *pipelinesv1alpha1.Stage, name string, manifests []byte) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: r.Namespace,
			Labels: map[string]string{
				"paprika.io/stage":   stage.Name,
				"paprika.io/release": release.Name,
			},
		},
		Data: map[string]string{"manifests.yaml": string(manifests)},
	}

	existing := &corev1.ConfigMap{}
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: r.Namespace}, existing); err == nil {
		existing.Data = cm.Data
		existing.Labels = cm.Labels
		return r.Update(ctx, existing)
	}

	return r.Create(ctx, cm)
}

func (r *ReleaseReconciler) verify(ctx context.Context, release *pipelinesv1alpha1.Release) bool {
	log := logf.FromContext(ctx)

	gateConfigs := release.Spec.Verify
	if len(gateConfigs) == 0 {
		return true
	}

	for _, cfg := range gateConfigs {
		gateCfg := gates.GateConfig{
			Type:     cfg.Type,
			Endpoint: cfg.Endpoint,
			Timeout:  cfg.Timeout,
		}
		result := gates.ExecuteGate(ctx, gateCfg)
		if !result.Passed {
			log.Info("Gate failed", "type", cfg.Type, "message", result.Message)
			return false
		}
		log.Info("Gate passed", "type", cfg.Type, "message", result.Message)
	}

	return true
}

func (r *ReleaseReconciler) rollback(ctx context.Context, release *pipelinesv1alpha1.Release) error {
	log := logf.FromContext(ctx)

	if release.Status.RenderedManifestSnapshot == "" {
		log.Info("No manifest snapshot available for rollback", "release", release.Name)
		release.Status.Phase = pipelinesv1alpha1.ReleaseRolledBack
		release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
			Type:    "RolledBack",
			Status:  metav1.ConditionTrue,
			Reason:  "NoSnapshot",
			Message: "No manifest snapshot available for rollback",
		})
		if len(release.Status.PromotionHistory) > 0 {
			release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "RolledBack"
		}
		return r.Status().Update(ctx, release)
	}

	var cm corev1.ConfigMap
	if err := r.Get(ctx, types.NamespacedName{
		Name:      release.Status.RenderedManifestSnapshot,
		Namespace: r.Namespace,
	}, &cm); err != nil {
		return fmt.Errorf("failed to fetch manifest snapshot %q: %w", release.Status.RenderedManifestSnapshot, err)
	}

	log.Info("Rolling back to manifest snapshot", "snapshot", cm.Name, "bytes", len(cm.Data["manifests.yaml"]))

	release.Status.Phase = pipelinesv1alpha1.ReleaseRolledBack
	release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
		Type:    "RolledBack",
		Status:  metav1.ConditionTrue,
		Reason:  "VerificationFailed",
		Message: "Rolled back due to verification failure",
	})
	if len(release.Status.PromotionHistory) > 0 {
		release.Status.PromotionHistory[len(release.Status.PromotionHistory)-1].Result = "RolledBack"
	}

	return r.Status().Update(ctx, release)
}

func (r *ReleaseReconciler) cleanup(ctx context.Context, release *pipelinesv1alpha1.Release) error {
	log := logf.FromContext(ctx)

	// Use the name recorded in status; fall back to label-based search if empty
	cmName := release.Status.RenderedManifestSnapshot
	if cmName != "" {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      cmName,
				Namespace: r.Namespace,
			},
		}
		if err := r.Delete(ctx, cm); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("deleting manifest snapshot ConfigMap: %w", err)
		}
		log.Info("Deleted manifest snapshot ConfigMap", "configmap", cmName)
	}

	labelSelector := labels.Set{"paprika.io/release": release.Name}.String()
	for _, gvr := range managedGVRs {
		items, err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).List(ctx, metav1.ListOptions{
			LabelSelector: labelSelector,
		})
		if err != nil {
			return fmt.Errorf("listing %s: %w", gvr.Resource, err)
		}
		for _, item := range items.Items {
			if err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("deleting %s/%s: %w", gvr.Resource, item.GetName(), err)
			}
			log.Info("Deleted managed resource", "resource", gvr.Resource, "name", item.GetName())
		}
	}

	return nil
}

func (r *ReleaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Release{}).
		Owns(&corev1.ConfigMap{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 5}).
		Named("release").
		Complete(r)
}
