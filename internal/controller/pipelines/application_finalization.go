package pipelines

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const applicationFinalizer = "paprika.io/application-cleanup"

func hasApplicationFinalizer(app *api.Application) bool {
	return controllerutil.ContainsFinalizer(app, applicationFinalizer)
}

func (r *ApplicationReconciler) ensureApplicationFinalizer(ctx context.Context, app *api.Application) error {
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var latest api.Application
		if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
			return fmt.Errorf("read Application lifecycle protection: %w", err)
		}
		if latest.UID != app.UID {
			return errors.New("application identity changed before lifecycle protection")
		}
		// This runs before delivery/status work. Refresh the full object when
		// adopting its resource version so later spec updates cannot overwrite
		// a concurrent GitOps edit using an older cached specification.
		*app = latest
		if !latest.DeletionTimestamp.IsZero() || hasApplicationFinalizer(&latest) {
			return nil
		}
		base := latest.DeepCopy()
		controllerutil.AddFinalizer(&latest, applicationFinalizer)
		if err := r.client.Patch(ctx, &latest, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
			return fmt.Errorf("protect Application lifecycle: %w", err)
		}
		*app = latest
		return nil
	})
	if err != nil {
		return fmt.Errorf("updating Application lifecycle protection: %w", err)
	}
	return nil
}

// Stages and Releases have the same Application owner. Keep that owner alive
// until Release finalizers have removed workloads using the still-present Stage
// routing. Never remove a Release finalizer or guess a missing cleanup target.
func (r *ApplicationReconciler) finalizeApplication(ctx context.Context, app *api.Application) (ctrl.Result, error) {
	if !hasApplicationFinalizer(app) {
		return ctrl.Result{}, nil
	}
	latest, err := r.deletingApplicationForCleanup(ctx, app)
	if err != nil {
		return ctrl.Result{}, err
	}
	if latest == nil {
		return ctrl.Result{}, nil
	}
	if controllerutil.ContainsFinalizer(latest, metav1.FinalizerOrphanDependents) {
		// Orphan deletion intentionally preserves children. The uncached reader
		// also prevents stale owner refs from starting cleanup after GC orphans.
		return ctrl.Result{}, r.removeApplicationFinalizer(ctx, app)
	}
	remaining, err := r.drainApplicationReleases(ctx, app)
	if err != nil {
		return ctrl.Result{}, err
	}
	if remaining {
		return ctrl.Result{RequeueAfter: r.transientRequeue()}, nil
	}
	return ctrl.Result{}, r.removeApplicationFinalizer(ctx, app)
}

func (r *ApplicationReconciler) applicationCleanupReader() client.Reader {
	if r.sourceMetadataReader != nil {
		return r.sourceMetadataReader
	}
	return r.client
}

func (r *ApplicationReconciler) deletingApplicationForCleanup(ctx context.Context, app *api.Application) (*api.Application, error) {
	var latest api.Application
	if err := r.applicationCleanupReader().Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read deleting Application: %w", err)
	}
	if latest.UID != app.UID {
		return nil, errors.New("application identity changed during finalization")
	}
	if latest.DeletionTimestamp.IsZero() || !hasApplicationFinalizer(&latest) {
		return nil, nil
	}
	return &latest, nil
}

func (r *ApplicationReconciler) drainApplicationReleases(ctx context.Context, app *api.Application) (bool, error) {
	var releases api.ReleaseList
	if err := r.applicationCleanupReader().List(ctx, &releases, client.InNamespace(app.Namespace)); err != nil {
		return false, fmt.Errorf("list Application releases for cleanup: %w", err)
	}
	remaining := false
	for i := range releases.Items {
		release := &releases.Items[i]
		if !applicationOwnsRelease(app, release) {
			continue
		}
		remaining = true
		if !release.DeletionTimestamp.IsZero() {
			continue
		}
		if err := r.client.Delete(ctx, release, client.Preconditions{UID: &release.UID}); err != nil && !apierrors.IsNotFound(err) {
			return false, fmt.Errorf("delete owned Release %s: %w", release.Name, err)
		}
	}
	return remaining, nil
}

func applicationOwnsRelease(app *api.Application, release *api.Release) bool {
	owner := metav1.GetControllerOf(release)
	return owner != nil && owner.UID == app.UID && owner.Name == app.Name &&
		owner.Kind == "Application" && owner.APIVersion == api.GroupVersion.String()
}

func (r *ApplicationReconciler) removeApplicationFinalizer(ctx context.Context, app *api.Application) error {
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var latest api.Application
		if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
			if apierrors.IsNotFound(err) {
				return nil
			}
			return fmt.Errorf("read Application finalizer: %w", err)
		}
		if latest.UID != app.UID {
			return errors.New("application identity changed during finalizer removal")
		}
		if !hasApplicationFinalizer(&latest) {
			return nil
		}
		base := latest.DeepCopy()
		controllerutil.RemoveFinalizer(&latest, applicationFinalizer)
		if err := r.client.Patch(ctx, &latest, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("remove Application finalizer: %w", err)
		}
		app.Finalizers = latest.Finalizers
		app.ResourceVersion = latest.ResourceVersion
		return nil
	})
	if err != nil {
		return fmt.Errorf("removing Application lifecycle protection: %w", err)
	}
	return nil
}
