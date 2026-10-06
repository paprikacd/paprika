package pipelines

import (
	"context"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

// A completed Release can precede the first successful live observation of its
// resources. Keep those two facts separate so downstream promotion cannot use
// resource health retained from the previous release.
func (r *ApplicationReconciler) recordDeploymentObservation(ctx context.Context, app *paprikav1.Application, diff *engine.DiffResult) {
	app.Status.DeploymentObservation = nil
	if diff == nil || app.Status.Phase != paprikav1.ApplicationHealthy || applicationDiffUnavailable(app) {
		return
	}
	release := r.getCurrentRelease(ctx, app)
	if release == nil || release.UID == "" || release.Status.Phase != paprikav1.ReleaseComplete {
		return
	}
	app.Status.DeploymentObservation = &paprikav1.ApplicationDeploymentObservation{
		Release: release.Name, ReleaseUID: string(release.UID),
		Revision: release.Annotations[sourceRevisionAnnotation], ObservedGeneration: app.Generation,
		// Round to a stable bucket: unchanged status writes otherwise trigger
		// another reconcile immediately, creating an observation feedback loop.
		ObservedAt: metav1.NewTime(r.currentTime().UTC().Truncate(30 * time.Second)),
	}
}
