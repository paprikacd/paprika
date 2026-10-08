package pipelines

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/uuid"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// A new target intent qualifies the same immutable upstream candidate again.
// Persist a fresh identity even if the target later returns to an earlier spec;
// neither its previous successful Pipeline nor its approval can authorize it.
func (r *ApplicationReconciler) refreshPromotionVerification(ctx context.Context, app *api.Application, configurationHash string) error {
	if err := r.checkPromotionRefreshPriorExecution(ctx, app); err != nil {
		return err
	}
	original := app.Status.Promotion.DeepCopy()
	next := original.DeepCopy()
	next.Phase = "Verifying"
	// Controller-generated attempts are not explicit retry tokens and do not
	// consume the bounded explicit retry budget or become replayable requests.
	next.VerificationAttempt = "config-" + string(uuid.NewUUID())
	next.VerificationPipelineRef, next.VerificationStartedAt = "", nil
	next.VerificationConfigHash = configurationHash
	next.Message = "Target settings changed; waiting for fresh upstream verification."
	if err := r.checkPromotionRetryPipeline(ctx, app, next); err != nil {
		return err
	}
	// Remove authorization before activating the attempt. A crash after this
	// write leaves the old intent unapproved, never the new intent approved.
	if approval := app.Annotations[promotionApprovalAnnotation]; approval != "" {
		if err := r.consumePromotionApproval(ctx, app, approval); err != nil {
			return err
		}
	}
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		return r.writePromotionVerificationAttempt(ctx, app, original, next, "")
	}); err != nil {
		return fmt.Errorf("persisting changed promotion target: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) checkPromotionRefreshPriorExecution(ctx context.Context, app *api.Application) error {
	name := app.Status.Promotion.VerificationPipelineRef
	if name == "" {
		return nil
	}
	var pipeline api.Pipeline
	err := r.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: name}, &pipeline)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("reading previous promotion verification Pipeline: %w", err)
	}
	if err == nil && (pipeline.Status.ObservedGeneration != pipeline.Generation ||
		(pipeline.Status.Phase != api.PipelineSucceeded && pipeline.Status.Phase != api.PipelineFailed && pipeline.Status.Phase != api.PipelineCancelled)) {
		// A nonterminal Pipeline can still schedule Jobs even if none exist yet.
		return promotionBlocked("PromotionVerificationPending", "Waiting for the previous verification Pipeline to observe its current specification and stop before checking changed target settings.")
	}
	return r.checkPromotionRetryPriorJobs(ctx, app.Status.Promotion)
}
