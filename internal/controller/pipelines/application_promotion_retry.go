package pipelines

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

const (
	promotionRetryAnnotation = "paprika.io/promotion-retry"
	promotionRetryLimit      = 32
)

// A retry is a new verification attempt, never a shortcut around verification
// or an instruction to resync an already admitted deployment.
func (r *ApplicationReconciler) reconcilePromotionRetry(ctx context.Context, app *api.Application) error {
	request := app.Annotations[promotionRetryAnnotation]
	if request == "" {
		return nil
	}
	uid, token, valid := promotionRetryRequest(request)
	candidate := app.Status.Promotion
	if !valid || uid != candidate.SourceReleaseUID {
		return promotionBlocked("InvalidPromotionRetry", "Promotion retry requires the current sourceReleaseUID followed by ':' and a fresh canonical UUID token.")
	}
	if promotionRetryAlreadyConsumed(candidate, token) || candidate.Phase != "Failed" {
		// A replay is consumed without resetting the attempt, even after it failed.
		return r.consumePromotionRetry(ctx, app, request)
	}
	if err := r.validatePromotionRetryAdmission(ctx, app); err != nil {
		return err
	}
	if err := r.checkPromotionRetryPriorJobs(ctx, candidate); err != nil {
		return err
	}
	configurationHash, err := promotionVerificationConfigHash(app)
	if err != nil {
		return err
	}
	original := candidate.DeepCopy()
	next := candidate.DeepCopy()
	next.Phase, next.VerificationAttempt = "Verifying", token
	next.ConsumedVerificationAttempts = append(append([]string{}, candidate.ConsumedVerificationAttempts...), token)
	next.VerificationPipelineRef, next.VerificationStartedAt = "", nil
	next.VerificationConfigHash = configurationHash
	next.Message = "Explicit retry requested; waiting for fresh upstream verification."
	if err := r.checkPromotionRetryPipeline(ctx, app, next); err != nil {
		return err
	}
	return r.activatePromotionRetry(ctx, app, original, next, request)
}

func promotionRetryAlreadyConsumed(candidate *api.ApplicationPromotionStatus, token string) bool {
	return token == candidate.VerificationAttempt || slices.Contains(candidate.ConsumedVerificationAttempts, token)
}

func (r *ApplicationReconciler) validatePromotionRetryAdmission(ctx context.Context, app *api.Application) error {
	if len(app.Status.Promotion.ConsumedVerificationAttempts) >= promotionRetryLimit {
		return promotionBlocked("PromotionRetryLimitReached", "This source candidate has consumed all 32 verification retries; a new upstream Release is required.")
	}
	if release := r.getCurrentRelease(ctx, app); release != nil && acceptedPromotionReleaseMatches(app, release) {
		return promotionBlocked("PromotionAlreadyAdmitted", "Retry the already accepted Release with manual sync; verification retry only applies before admission.")
	}
	return nil
}

func (r *ApplicationReconciler) checkPromotionRetryPriorJobs(ctx context.Context, candidate *api.ApplicationPromotionStatus) error {
	if candidate.VerificationPipelineRef == "" {
		return nil
	}
	if err := engine.ValidatePipelineJobsStopped(ctx, r.K8sClient, r.Namespace, candidate.VerificationPipelineRef); err != nil {
		return promotionBlocked("PromotionRetryJobsUnstopped", err.Error())
	}
	return nil
}

func (r *ApplicationReconciler) checkPromotionRetryPipeline(ctx context.Context, app *api.Application, next *api.ApplicationPromotionStatus) error {
	if app.Spec.Trigger.Tests == nil || len(app.Spec.Trigger.Tests.Steps) == 0 {
		return nil
	}
	probe := app.DeepCopy()
	probe.Status.Promotion = next
	name, err := promotionPipelineName(probe)
	if err != nil {
		return err
	}
	var existing api.Pipeline
	if err := r.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: name}, &existing); err == nil {
		return promotionBlocked("PromotionRetryReplayed", "This retry token already has a verification Pipeline; use a fresh token.")
	} else if !apierrors.IsNotFound(err) {
		return fmt.Errorf("checking promotion retry identity: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) activatePromotionRetry(ctx context.Context, app *api.Application, original, next *api.ApplicationPromotionStatus, request string) error {
	// Clear approval while the candidate is still Failed. A crash or conflict
	// cannot leave an old approval attached to an active new verification attempt.
	if approval := app.Annotations[promotionApprovalAnnotation]; approval != "" {
		if err := r.consumePromotionApproval(ctx, app, approval); err != nil {
			return err
		}
	}
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		return r.writePromotionVerificationAttempt(ctx, app, original, next, request)
	}); err != nil {
		return fmt.Errorf("persisting promotion retry: %w", err)
	}
	return r.consumePromotionRetry(ctx, app, request)
}

// Both explicit retries and target edits must commit a fresh attempt against
// the exact target intent before creating any verification workload.
func (r *ApplicationReconciler) writePromotionVerificationAttempt(ctx context.Context, app *api.Application, original, next *api.ApplicationPromotionStatus, request string) error {
	var latest api.Application
	if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
		return fmt.Errorf("reading promotion verification target: %w", err)
	}
	latestHash, err := promotionVerificationConfigHash(&latest)
	if err != nil {
		return err
	}
	if !promotionRetryIntentMatches(&latest, app, original, next.VerificationConfigHash, latestHash, request) {
		return errors.New("promotion candidate, retry request or target settings changed; retrying")
	}
	if err := r.revalidatePromotionSource(ctx, original); err != nil {
		return fmt.Errorf("revalidating promotion verification source: %w", err)
	}
	latest.Status.Promotion = next.DeepCopy()
	if err := r.client.Status().Update(ctx, &latest); err != nil {
		return fmt.Errorf("writing promotion verification target: %w", err)
	}
	*app = latest
	return nil
}

func promotionRetryIntentMatches(latest, app *api.Application, original *api.ApplicationPromotionStatus, expectedHash, latestHash, request string) bool {
	return latest.UID == app.UID && latest.Generation == app.Generation && latestHash == expectedHash &&
		latest.Annotations[promotionRetryAnnotation] == request && latest.Annotations[promotionApprovalAnnotation] == "" && reflect.DeepEqual(latest.Status.Promotion, original)
}

func promotionRetryRequest(request string) (uid, token string, valid bool) {
	uid, token, found := strings.Cut(request, ":")
	return uid, token, found && uid != "" && validPromotionRetryToken(token)
}

func validPromotionRetryToken(token string) bool {
	if len(token) != 36 || token[8] != '-' || token[13] != '-' || token[18] != '-' || token[23] != '-' {
		return false
	}
	if strings.ToLower(token) != token {
		return false
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(token, "-", ""))
	return err == nil && len(decoded) == 16 && token != "00000000-0000-0000-0000-000000000000"
}

func (r *ApplicationReconciler) consumePromotionRetry(ctx context.Context, app *api.Application, request string) error {
	var latest api.Application
	if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
		return fmt.Errorf("reading promotion retry: %w", err)
	}
	if latest.UID != app.UID || latest.Annotations[promotionRetryAnnotation] != request {
		return errors.New("promotion retry request changed; retrying")
	}
	base := latest.DeepCopy()
	delete(latest.Annotations, promotionRetryAnnotation)
	if err := r.client.Patch(ctx, &latest, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
		return fmt.Errorf("consuming promotion retry: %w", err)
	}
	delete(app.Annotations, promotionRetryAnnotation)
	app.ResourceVersion = latest.ResourceVersion
	return nil
}
