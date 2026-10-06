package pipelines

import (
	"context"
	"errors"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func promotionTriggered(app *paprikav1.Application) bool {
	return app.Spec.Trigger != nil && app.Spec.Trigger.Type == paprikav1.ApplicationTriggerPromotion
}

func manualTriggered(app *paprikav1.Application) bool {
	return app.Spec.Trigger != nil && app.Spec.Trigger.Type == paprikav1.ApplicationTriggerManual
}

// Templates and Stages are shared by an Application's releases. Keep their
// render and routing configuration frozen to the accepted promotion, even if
// GitOps edits the next desired spec while a previous release self-heals.
func effectiveDeploymentApp(app *paprikav1.Application) *paprikav1.Application {
	if !promotionTriggered(app) || app.Status.AcceptedDeployment == nil {
		return app
	}
	effective := app.DeepCopy()
	effective.Spec = *app.Status.AcceptedDeployment.DeepCopy()
	return effective
}

func awaitingFirstAcceptedDeployment(app *paprikav1.Application) bool {
	return promotionTriggered(app) && app.Status.AcceptedDeployment == nil && app.Status.ReleaseRef != "" && !promotionReady(app)
}

func promotionReady(app *paprikav1.Application) bool {
	return promotionTriggered(app) && app.Status.Promotion != nil && app.Status.Promotion.Phase == "Ready"
}

// The source declaration remains under GitOps ownership. Only the generated
// Template receives the accepted revision, so reverting the branch in Git
// cannot inadvertently move a promotion environment to a newer commit.
func pinTriggeredTemplate(app *paprikav1.Application, spec *paprikav1.TemplateSpec) paprikav1.TemplateSpec {
	pinned := *spec
	if promotionTriggered(app) && app.Status.SourceRevision != "" && pinned.Git != nil {
		pinned.Git = pinned.Git.DeepCopy()
		pinned.Git.Revision = app.Status.SourceRevision
	}
	return pinned
}

// Admit the verified candidate before changing the shared Template or Stage.
// An approved candidate waiting on a sync window must not redirect self-heal
// for the currently deployed release to its incoming settings.
func (r *ApplicationReconciler) beginVerifiedPromotion(ctx context.Context, app *paprikav1.Application) (*ctrl.Result, error) {
	if !promotionReady(app) {
		return nil, nil
	}
	if len(app.Spec.Stages) == 0 {
		return nil, errors.New("promotion requires a deployment stage")
	}
	if err := validateVerifiedPromotionConfiguration(app); err != nil {
		return nil, err
	}
	if result, err := r.promotionAdmissionHold(ctx, app); result != nil || err != nil {
		return result, err
	}
	if app.Status.ReleaseRef != "" {
		result, err := r.startNewReleaseFlow(ctx, app, false, "PromotionReady", "verified upstream revision selected for promotion")
		return &result, err
	}
	if promotionDeploymentIntentChanged(app) {
		app.Status.AcceptedDeployment = app.Spec.DeepCopy()
		app.Status.SourceRevision = app.Status.Promotion.Revision
		app.Status.SourceHash = ""
		if err := r.persistReadyPromotion(ctx, app); err != nil {
			return nil, fmt.Errorf("activate verified deployment intent: %w", err)
		}
	}
	return nil, nil
}

// Authorization survives a transient upstream readiness loss, but deployment
// admission must wait for fresh evidence even when an old release is active.
func (r *ApplicationReconciler) promotionAdmissionHold(ctx context.Context, app *paprikav1.Application) (*ctrl.Result, error) {
	if condition := meta.FindStatusCondition(app.Status.Conditions, promotionReadyCondition); condition != nil && condition.Status == metav1.ConditionFalse {
		return r.holdVerifiedPromotion(ctx, app, r.transientRequeue())
	}
	if allowed, window := r.syncWindowAllows(ctx, app, app.Spec.Stages[0].Name, false); !allowed {
		r.setSyncWindowCondition(app, metav1.ConditionFalse, syncWindowReason(window), window.Reason)
		return r.holdVerifiedPromotion(ctx, app, r.syncWindowRequeueAfter(window.NextTransition))
	}
	return nil, nil
}

func (r *ApplicationReconciler) holdVerifiedPromotion(ctx context.Context, app *paprikav1.Application, delay time.Duration) (*ctrl.Result, error) {
	if app.Status.ReleaseRef != "" {
		result, err := r.evaluateHealthyApplication(ctx, app, delay)
		return &result, err
	}
	if err := r.patchAppStatus(ctx, app); err != nil {
		return nil, err
	}
	return &ctrl.Result{RequeueAfter: delay}, nil
}

func validateVerifiedPromotionConfiguration(app *paprikav1.Application) error {
	configurationHash, err := promotionVerificationConfigHash(app)
	if err != nil {
		return fmt.Errorf("validate verified promotion configuration: %w", err)
	}
	if app.Status.Promotion.VerificationConfigHash != configurationHash {
		return errors.New("promotion deployment settings changed after verification")
	}
	return nil
}

func promotionDeploymentIntentChanged(app *paprikav1.Application) bool {
	return app.Status.AcceptedDeployment == nil || !equality.Semantic.DeepEqual(*app.Status.AcceptedDeployment, app.Spec) || app.Status.SourceRevision != app.Status.Promotion.Revision
}

// prepareTriggeredSource resolves the target environment's own tree at the
// selected revision, before release identity and rendering are computed.
func (r *ApplicationReconciler) prepareTriggeredSource(ctx context.Context, app *paprikav1.Application) (*ctrl.Result, error) {
	if !r.triggeredSourceEligible(app) {
		return nil, nil
	}
	if triggeredSourceNeedsResolution(app) {
		if result, err := r.resolveTriggeredSource(ctx, app); result != nil || err != nil {
			return result, err
		}
	}
	if promotionReady(app) && app.Status.ReleaseRef != "" {
		if changed, _ := releaseIdentityChanged(app); changed {
			result, err := r.startNewReleaseFlow(ctx, app, false, "PromotionReady", "verified upstream revision selected for promotion")
			return &result, err
		}
	}
	return nil, nil
}

func (r *ApplicationReconciler) triggeredSourceEligible(app *paprikav1.Application) bool {
	if app.Spec.Trigger == nil || r.isInlineSource(app) {
		return false
	}
	if promotionTriggered(app) {
		return promotionReady(app)
	}
	if (manualTriggered(app) || app.Spec.SyncPolicy == paprikav1.SyncManual) && !manualSyncRequested(app) {
		return false
	}
	return app.Status.SourceHash == "" || manualSyncRequested(app)
}

func triggeredSourceNeedsResolution(app *paprikav1.Application) bool {
	return app.Status.SourceHash == "" || (!promotionTriggered(app) && manualSyncRequested(app))
}

func (r *ApplicationReconciler) resolveTriggeredSource(ctx context.Context, app *paprikav1.Application) (*ctrl.Result, error) {
	changed, err := r.checkSourceChanged(ctx, app, true)
	if err != nil {
		return nil, fmt.Errorf("resolve triggered application source: %w", err)
	}
	if app.Status.SourceHash == "" || (app.Spec.Source.Type == paprikav1.SourceTypeGit && app.Status.SourceRevision == "") {
		return &ctrl.Result{RequeueAfter: r.transientRequeue()}, nil
	}
	if changed && !promotionTriggered(app) && app.Status.ReleaseRef != "" {
		result, err := r.startNewReleaseFlow(ctx, app, true, "ManualSourceChanged", "manual sync selected a new source revision")
		return &result, err
	}
	return nil, nil
}

func markPromotionStarted(app *paprikav1.Application) {
	if promotionReady(app) {
		app.Status.Promotion.Phase = "Promoting"
		app.Status.Promotion.Message = "Deploying the verified upstream revision"
	}
}

func updatePromotionReleasePhase(app *paprikav1.Application, phase paprikav1.ReleasePhase) {
	if !promotionTriggered(app) || app.Status.Promotion == nil || app.Status.Promotion.Phase != "Promoting" {
		return
	}
	switch phase {
	case paprikav1.ReleasePending, paprikav1.ReleasePromoting, paprikav1.ReleaseCanarying,
		paprikav1.ReleaseVerifying, paprikav1.ReleaseAwaitingApproval:
		return
	case paprikav1.ReleaseComplete:
		app.Status.Promotion.Phase = "Complete"
		app.Status.Promotion.Message = "Promoted release completed; application health is evaluated independently"
	case paprikav1.ReleaseFailed, paprikav1.ReleaseRolledBack, paprikav1.ReleaseSuperseded:
		app.Status.Promotion.Phase = "Failed"
		app.Status.Promotion.Message = "Promoted release ended in phase " + string(phase)
	}
}
