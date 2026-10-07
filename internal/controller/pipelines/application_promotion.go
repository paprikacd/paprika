package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/gates"
	"github.com/benebsworth/paprika/internal/repository"
)

const (
	promotionApprovalAnnotation   = "paprika.io/promote"
	promotionSourceUIDAnnotation  = "paprika.io/promotion-source-uid"
	promotionReleaseUIDAnnotation = "paprika.io/promotion-release-uid"
	promotionReadyCondition       = "PromotionReady"
)

// reconcilePromotionTrigger selects and verifies a completed upstream release.
// A waiting candidate never replaces the revision of an existing deployment.
func (r *ApplicationReconciler) reconcilePromotionTrigger(ctx context.Context, app *paprikav1.Application) (*ctrl.Result, error) {
	if !promotionTriggerNeedsVerification(app) {
		return nil, nil
	}
	if err := r.preparePromotionCandidate(ctx, app); err != nil {
		return r.handlePromotionTriggerError(ctx, app, err)
	}
	candidate := app.Status.Promotion
	if candidate.Phase == "Complete" {
		return nil, nil
	}
	configurationHash, err := r.preparePromotionVerification(ctx, app)
	if err != nil {
		return nil, err
	}
	if candidate.Phase == "Ready" {
		if promotionDurationPending(app, r.currentTime()) {
			return r.waitForPromotion(ctx, app, "PromotionObservationPending", "Waiting for a fresh uninterrupted upstream observation window before admission.")
		}
		return nil, r.restoreReadyPromotion(ctx, app)
	}
	ready, err := r.reconcilePromotionTests(ctx, app)
	if err != nil {
		return nil, err
	}
	if !ready {
		return r.waitForPromotion(ctx, app, "PromotionVerificationPending", candidate.Message)
	}
	if err := r.verifyPromotionGates(ctx, app); err != nil {
		return r.handlePromotionTriggerError(ctx, app, err)
	}
	return r.completePromotionVerification(ctx, app, configurationHash)
}

func promotionTriggerNeedsVerification(app *paprikav1.Application) bool {
	trigger := app.Spec.Trigger
	if trigger == nil || trigger.Type != paprikav1.ApplicationTriggerPromotion {
		return false
	}
	return app.Status.Promotion == nil || app.Status.Promotion.Phase != "Promoting"
}

type promotionBlockedError struct {
	reason  string
	message string
}

func (e *promotionBlockedError) Error() string { return e.message }

func promotionBlocked(reason, message string) error {
	return &promotionBlockedError{reason: reason, message: message}
}

func (r *ApplicationReconciler) handlePromotionTriggerError(ctx context.Context, app *paprikav1.Application, err error) (*ctrl.Result, error) {
	var blocked *promotionBlockedError
	if errors.As(err, &blocked) {
		return r.waitForPromotion(ctx, app, blocked.reason, blocked.message)
	}
	return nil, err
}

func (r *ApplicationReconciler) preparePromotionCandidate(ctx context.Context, app *paprikav1.Application) error {
	upstream, err := r.promotionSourceApplication(ctx, app)
	if err != nil {
		return err
	}
	release, err := r.promotionSourceRelease(ctx, upstream)
	if err != nil {
		return err
	}
	return r.selectPromotionCandidate(ctx, app, upstream, release)
}

func (r *ApplicationReconciler) promotionSourceApplication(ctx context.Context, app *paprikav1.Application) (*paprikav1.Application, error) {
	from := app.Spec.Trigger.From
	if from == nil || from.Name == "" {
		return nil, promotionBlocked("UpstreamReferenceRequired", "Promotion requires an upstream Application reference.")
	}
	ref := *from
	if ref.Namespace == "" {
		ref.Namespace = app.Namespace
	}
	if ref.Name == app.Name && ref.Namespace == app.Namespace {
		return nil, promotionBlocked("InvalidUpstreamReference", "An Application cannot promote from itself.")
	}
	if err := r.validatePromotionReferenceChain(ctx, app, ref); err != nil {
		var blocked *promotionBlockedError
		if errors.As(err, &blocked) {
			return nil, err
		}
		return nil, promotionBlocked("InvalidPromotionChain", err.Error())
	}
	var upstream paprikav1.Application
	if err := r.client.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: ref.Namespace}, &upstream); err != nil {
		return nil, promotionBlocked("UpstreamUnavailable", "The upstream Application could not be read; waiting for current evidence.")
	}
	return &upstream, nil
}

func (r *ApplicationReconciler) promotionSourceRelease(ctx context.Context, upstream *paprikav1.Application) (*paprikav1.Release, error) {
	var release paprikav1.Release
	if upstream.Status.ReleaseRef == "" {
		return &release, nil
	}
	if err := r.client.Get(ctx, types.NamespacedName{Name: upstream.Status.ReleaseRef, Namespace: upstream.Namespace}, &release); err != nil && !apierrors.IsNotFound(err) {
		return nil, promotionBlocked("UpstreamUnavailable", "The upstream Release could not be read; waiting for current evidence.")
	}
	return &release, nil
}

func activePromotionCandidateChanged(candidate *paprikav1.ApplicationPromotionStatus, upstream *paprikav1.Application, release *paprikav1.Release) bool {
	return candidate != nil && candidate.SourceReleaseUID != "" && candidate.Phase != "Complete" &&
		candidate.Phase != "Failed" && promotionCandidateIdentityChanged(candidate, upstream, release)
}

func (r *ApplicationReconciler) selectPromotionCandidate(ctx context.Context, app, upstream *paprikav1.Application, release *paprikav1.Release) error {
	if activePromotionCandidateChanged(app.Status.Promotion, upstream, release) {
		app.Status.Promotion.Phase = "Failed"
		return promotionBlocked("UpstreamCandidateChanged", "The upstream Application advanced or changed identity during verification; this candidate was rejected.")
	}
	if err := promotionSourceReady(upstream, release, r.currentTime()); err != nil {
		return promotionBlocked("UpstreamNotReady", err.Error())
	}
	if err := r.compatiblePromotionRepositories(ctx, app, upstream); err != nil {
		return promotionBlocked("IncompatiblePromotionSource", err.Error())
	}
	if candidate := app.Status.Promotion; candidate != nil && promotionCandidateMatches(candidate, upstream, release) {
		if err := r.reconcilePromotionRetry(ctx, app); err != nil {
			return err
		}
		candidate = app.Status.Promotion
		if candidate.Phase == "Failed" {
			return promotionBlocked("PromotionVerificationFailed", candidate.Message)
		}
		return nil
	}
	app.Status.Promotion = &paprikav1.ApplicationPromotionStatus{
		SourceApplication:    paprikav1.ApplicationReference{Name: upstream.Name, Namespace: upstream.Namespace},
		SourceApplicationUID: string(upstream.UID), SourceRelease: release.Name, SourceReleaseUID: string(release.UID),
		Revision: release.Annotations[sourceRevisionAnnotation], Phase: "Verifying",
	}
	// Commit provenance before creating any verification workload.
	if err := r.patchAppStatus(ctx, app); err != nil {
		return fmt.Errorf("persisting promotion candidate: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) preparePromotionVerification(ctx context.Context, app *paprikav1.Application) (string, error) {
	configurationHash, err := promotionVerificationConfigHash(app)
	if err != nil {
		return "", err
	}
	candidate := app.Status.Promotion
	if candidate.VerificationConfigHash == configurationHash {
		return configurationHash, nil
	}
	if candidate.VerificationConfigHash != "" && app.Annotations[promotionApprovalAnnotation] == candidate.SourceReleaseUID {
		// Approval for the previous target intent cannot authorize a spec edit.
		if err := r.consumePromotionApproval(ctx, app, candidate.SourceReleaseUID); err != nil {
			return "", err
		}
	}
	candidate.Phase = "Verifying"
	candidate.VerificationStartedAt = nil
	candidate.VerificationConfigHash = configurationHash
	return configurationHash, nil
}

func (r *ApplicationReconciler) verifyPromotionGates(ctx context.Context, app *paprikav1.Application) error {
	candidate := app.Status.Promotion
	if candidate.Phase == "AwaitingApproval" {
		return nil
	}
	if candidate.VerificationStartedAt == nil {
		candidate.VerificationStartedAt = ptrToPromotionTime(r.currentTime())
	}
	for _, config := range app.Spec.Trigger.Gates {
		if config.Type == "duration" {
			if !promotionObservationDurationElapsed(config, candidate.VerificationStartedAt, r.currentTime()) {
				return promotionBlocked("PromotionVerificationPending", "Waiting for the upstream observation duration before promotion.")
			}
			continue
		}
		timeout := time.Duration(config.Timeout) * time.Second
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		gateCtx, cancel := context.WithTimeout(ctx, min(timeout, 30*time.Second))
		result := gates.ExecuteGate(gateCtx, gates.GateConfig{Type: config.Type, Endpoint: config.Endpoint, Timeout: config.Timeout})
		cancel()
		if !result.Passed {
			candidate.Phase = "Failed"
			return promotionBlocked("PromotionGateFailed", "An upstream verification gate failed: "+result.Message)
		}
	}
	return nil
}

func promotionObservationDurationElapsed(config paprikav1.GateConfig, startedAt *metav1.Time, now time.Time) bool {
	duration := time.Duration(config.Timeout) * time.Second
	if duration <= 0 {
		duration = time.Minute
	}
	return now.Sub(startedAt.Time) >= duration
}

func promotionDurationPending(app *paprikav1.Application, now time.Time) bool {
	for _, gate := range app.Spec.Trigger.Gates {
		if gate.Type != "duration" {
			continue
		}
		if app.Status.Promotion.VerificationStartedAt == nil {
			app.Status.Promotion.VerificationStartedAt = ptrToPromotionTime(now)
		}
		if !promotionObservationDurationElapsed(gate, app.Status.Promotion.VerificationStartedAt, now) {
			return true
		}
	}
	return false
}

func (r *ApplicationReconciler) completePromotionVerification(ctx context.Context, app *paprikav1.Application, configurationHash string) (*ctrl.Result, error) {
	candidate := app.Status.Promotion
	candidate.VerificationConfigHash = configurationHash
	// Health and release identity may have changed while a gate was running.
	if err := r.revalidatePromotionSource(ctx, candidate); err != nil {
		var blocked *promotionBlockedError
		if errors.As(err, &blocked) && blocked.reason == "UpstreamCandidateChanged" {
			candidate.Phase = "Failed"
		}
		return r.handlePromotionTriggerError(ctx, app, err)
	}
	if app.Spec.SyncPolicy == paprikav1.SyncManual {
		if app.Annotations[promotionApprovalAnnotation] != candidate.SourceReleaseUID {
			candidate.Phase = "AwaitingApproval"
			return r.waitForPromotion(ctx, app, "PromotionAwaitingApproval", "Approve this candidate by setting paprika.io/promote to its sourceReleaseUID.")
		}
		if err := r.consumePromotionApproval(ctx, app, candidate.SourceReleaseUID); err != nil {
			return nil, err
		}
	}
	r.markPromotionReady(app)
	if err := r.persistReadyPromotion(ctx, app); err != nil {
		return nil, fmt.Errorf("persisting verified promotion: %w", err)
	}
	return nil, nil
}

// A temporary health hold blocks admission without consuming authorization.
// Restore readiness only after the same candidate and target intent revalidate.
func (r *ApplicationReconciler) restoreReadyPromotion(ctx context.Context, app *paprikav1.Application) error {
	if meta.IsStatusConditionTrue(app.Status.Conditions, promotionReadyCondition) {
		return nil
	}
	r.markPromotionReady(app)
	if err := r.persistReadyPromotion(ctx, app); err != nil {
		return fmt.Errorf("restoring verified promotion readiness: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) markPromotionReady(app *paprikav1.Application) {
	candidate := app.Status.Promotion
	candidate.Phase = "Ready"
	candidate.Message = "Upstream release verified and ready for deployment."
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: promotionReadyCondition, Status: metav1.ConditionTrue, Reason: "CandidateVerified",
		Message: candidate.Message, ObservedGeneration: app.Generation, LastTransitionTime: metav1.NewTime(r.currentTime()),
	})
}

func ptrToPromotionTime(now time.Time) *metav1.Time {
	value := metav1.NewTime(now)
	return &value
}

// Admission cannot reject a cycle when both references were absent at creation.
// Re-check the reference chain before accepting a candidate at runtime.
func (r *ApplicationReconciler) validatePromotionReferenceChain(ctx context.Context, target *paprikav1.Application, ref paprikav1.ApplicationReference) error {
	visited := map[types.NamespacedName]bool{{Namespace: target.Namespace, Name: target.Name}: true}
	for range 64 {
		key := types.NamespacedName{Namespace: ref.Namespace, Name: ref.Name}
		if visited[key] {
			return errors.New("promotion Application references contain a cycle")
		}
		visited[key] = true
		var upstream paprikav1.Application
		if err := r.client.Get(ctx, key, &upstream); err != nil {
			return promotionBlocked("UpstreamUnavailable", "An Application in the promotion reference chain is unavailable.")
		}
		if upstream.Spec.Trigger == nil || upstream.Spec.Trigger.Type != paprikav1.ApplicationTriggerPromotion {
			return nil
		}
		if upstream.Spec.Trigger.From == nil || upstream.Spec.Trigger.From.Name == "" {
			return errors.New("an Application in the promotion reference chain has no upstream reference")
		}
		ref = *upstream.Spec.Trigger.From
		if ref.Namespace == "" {
			ref.Namespace = upstream.Namespace
		}
	}
	return errors.New("the promotion reference chain exceeds the supported depth")
}

func promotionCandidateMatches(candidate *paprikav1.ApplicationPromotionStatus, upstream *paprikav1.Application, release *paprikav1.Release) bool {
	return candidate.SourceApplication.Name == upstream.Name && candidate.SourceApplication.Namespace == upstream.Namespace &&
		candidate.SourceApplicationUID == string(upstream.UID) && candidate.SourceRelease == release.Name &&
		candidate.SourceReleaseUID == string(release.UID) && candidate.Revision == release.Annotations[sourceRevisionAnnotation]
}

// Missing evidence blocks readiness; only positive identity evidence can reject
// an immutable candidate. An empty Release from a failed read is not a new UID.
func promotionCandidateIdentityChanged(candidate *paprikav1.ApplicationPromotionStatus, upstream *paprikav1.Application, release *paprikav1.Release) bool {
	revision := release.Annotations[sourceRevisionAnnotation]
	return (upstream.UID != "" && candidate.SourceApplicationUID != string(upstream.UID)) ||
		(upstream.Status.ReleaseRef != "" && candidate.SourceRelease != upstream.Status.ReleaseRef) ||
		(release.UID != "" && candidate.SourceReleaseUID != string(release.UID)) ||
		(revision != "" && candidate.Revision != revision)
}

// Require positive evidence for every managed resource and configured probe.
// A zero drift count cannot establish health when target reads are unavailable.
func promotionSourceReady(app *paprikav1.Application, release *paprikav1.Release, now time.Time) error {
	app = effectiveDeploymentApp(app)
	if err := promotionSourceApplicationReady(app); err != nil {
		return err
	}
	if err := promotionSourceReleaseReady(app, release); err != nil {
		return err
	}
	if err := promotionSourceCommitReady(app, release); err != nil {
		return err
	}
	if err := promotionDeploymentObservationReady(app, release, now); err != nil {
		return err
	}
	if err := promotionManagedResourcesReady(app); err != nil {
		return err
	}
	completedAt, err := promotionDeploymentCompletedAt(app)
	if err != nil {
		return err
	}
	if err := promotionHealthChecksReady(app, completedAt, now); err != nil {
		return err
	}
	return promotionBackgroundAnalysisReady(app, completedAt, now)
}

func promotionSourceApplicationReady(app *paprikav1.Application) error {
	if app.UID == "" || app.Status.ObservedGeneration != app.Generation || app.Status.Phase != paprikav1.ApplicationHealthy {
		return errors.New("the upstream Application has not completed reconciliation of its current specification")
	}
	if !app.Status.Synced || app.Status.OutOfSync != 0 || applicationDiffUnavailable(app) {
		return errors.New("the upstream deployment is not observed in sync on its target cluster")
	}
	if app.Status.Health != "" && app.Status.Health != paprikav1.HealthHealthy {
		return errors.New("the upstream Application health is not healthy")
	}
	return nil
}

func promotionSourceReleaseReady(app *paprikav1.Application, release *paprikav1.Release) error {
	if release.UID == "" || release.Name != app.Status.ReleaseRef || release.Status.Phase != paprikav1.ReleaseComplete || release.Status.ObservedGeneration != release.Generation {
		return errors.New("the upstream release has not completed its current specification")
	}
	owner := metav1.GetControllerOf(release)
	if owner == nil || owner.Kind != "Application" || owner.UID != app.UID || owner.Name != app.Name {
		return errors.New("the upstream release is not owned by the referenced Application")
	}
	return nil
}

func promotionSourceCommitReady(app *paprikav1.Application, release *paprikav1.Release) error {
	revision := release.Annotations[sourceRevisionAnnotation]
	if artifact := inlineArtifact(app); artifact != nil && (!artifactReleaseMatches(app, release) || artifact.Revision != revision) {
		return errors.New("the upstream release does not identify its declared inline artifact")
	}
	decoded, err := hex.DecodeString(revision)
	if err != nil || len(decoded) != 20 || app.Status.Revision != revision {
		return errors.New("the upstream release does not identify the exact deployed Git commit")
	}
	return nil
}

func promotionDeploymentObservationReady(app *paprikav1.Application, release *paprikav1.Release, now time.Time) error {
	observation := app.Status.DeploymentObservation
	if observation == nil || observation.Release != release.Name || observation.ReleaseUID != string(release.UID) || observation.Revision != release.Annotations[sourceRevisionAnnotation] || observation.ObservedGeneration != app.Generation {
		return errors.New("upstream managed-resource observations do not belong to the current deployed release")
	}
	maxAge := 2 * time.Minute
	if poll, parseErr := time.ParseDuration(app.Spec.Source.PollInterval); parseErr == nil && poll > 0 {
		maxAge = max(maxAge, 3*poll)
	}
	if age := now.Sub(observation.ObservedAt.Time); age < 0 || age > maxAge {
		return errors.New("upstream managed-resource observations are not current")
	}
	return nil
}

func promotionManagedResourcesReady(app *paprikav1.Application) error {
	healthByResource := make(map[string]string, len(app.Status.ResourceHealth))
	for _, result := range app.Status.ResourceHealth {
		healthByResource[resourceHealthKey(result.Kind, result.Namespace, result.Name)] = result.Health
	}
	observed := 0
	for _, resource := range app.Status.Resources {
		if resource.Status == "Pruned" {
			continue
		}
		observed++
		if resource.Status != "Synced" || healthByResource[resourceHealthKey(resource.Kind, resource.Namespace, resource.Name)] != string(paprikav1.HealthHealthy) {
			return errors.New("every upstream managed resource must be observed synced and healthy before promotion")
		}
	}
	if observed == 0 {
		return errors.New("the upstream deployment has no observed healthy managed resources")
	}
	return nil
}

func promotionDeploymentCompletedAt(app *paprikav1.Application) (time.Time, error) {
	if len(app.Spec.HealthChecks) == 0 && len(app.Spec.AnalysisTemplates) == 0 {
		return time.Time{}, nil
	}
	condition := meta.FindStatusCondition(app.Status.Conditions, string(paprikav1.ApplicationHealthy))
	if condition == nil || condition.Status != metav1.ConditionTrue || condition.LastTransitionTime.IsZero() {
		return time.Time{}, errors.New("upstream health checks require an observed deployment completion time")
	}
	return condition.LastTransitionTime.Time, nil
}

func promotionHealthChecksReady(app *paprikav1.Application, completedAt, now time.Time) error {
	checks := healthResultsByName(app.Status.HealthChecks)
	for _, check := range app.Spec.HealthChecks {
		result := checks[check.Name]
		if result == nil || result.Status != paprikav1.HealthHealthy || !configuredHealthResultFresh(check, result, now) || result.CheckedAt.Time.Before(completedAt) {
			return errors.New("every upstream health check must have a current healthy observation before promotion")
		}
	}
	return nil
}

func promotionBackgroundAnalysisReady(app *paprikav1.Application, completedAt, now time.Time) error {
	analysisResults := make(map[string]paprikav1.AnalysisResult, len(app.Status.AnalysisResults))
	for _, analysis := range app.Status.AnalysisResults {
		analysisResults[analysis.Name] = analysis
	}
	for _, ref := range app.Spec.AnalysisTemplates {
		analysis, found := analysisResults[ref.Name]
		if !found || !promotionAnalysisResultReady(analysis, completedAt, now) {
			return errors.New("upstream background analysis has not passed")
		}
	}
	return nil
}

func promotionAnalysisResultReady(analysis paprikav1.AnalysisResult, completedAt, now time.Time) bool {
	return analysis.Passed && analysis.CheckedAt != nil && !analysis.CheckedAt.Time.Before(completedAt) &&
		!analysis.CheckedAt.After(now) && (analysis.Phase == paprikav1.AnalysisRunSuccessful || analysis.Phase == paprikav1.AnalysisRunCompleted)
}

func (r *ApplicationReconciler) compatiblePromotionRepositories(ctx context.Context, target, upstream *paprikav1.Application) error {
	upstream = effectiveDeploymentApp(upstream)
	if target.Spec.Source.Type == paprikav1.SourceTypeInline && upstream.Spec.Source.Type == paprikav1.SourceTypeInline {
		return r.compatibleInlineArtifacts(ctx, target, upstream)
	}
	if target.Spec.Source.Type != paprikav1.SourceTypeGit || upstream.Spec.Source.Type != paprikav1.SourceTypeGit {
		return errors.New("promotion requires Git sources in both Applications or matching versioned inline artifacts")
	}
	targetURL, err := r.promotionRepositoryURL(ctx, target)
	if err != nil {
		return err
	}
	upstreamURL, err := r.promotionRepositoryURL(ctx, upstream)
	if err != nil {
		return err
	}
	if targetURL == "" || targetURL != upstreamURL {
		return errors.New("promotion requires both Applications to resolve to the same Git repository; environment paths may differ")
	}
	return nil
}

func (r *ApplicationReconciler) promotionRepositoryURL(ctx context.Context, app *paprikav1.Application) (string, error) {
	spec := buildTemplateSpec(app)
	if spec.RepoRef != "" {
		resolved, err := repository.NewResolver(r.client).ResolveTemplate(ctx, app.Namespace, &spec)
		if err != nil || resolved == nil {
			return "", errors.New("a promotion Git repository reference could not be resolved")
		}
		spec = resolved.Spec
	}
	if spec.Git == nil {
		return "", errors.New("a promotion Git source could not be resolved")
	}
	return strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(spec.Git.RepoURL), "/"), ".git"), nil
}

func (r *ApplicationReconciler) revalidatePromotionSource(ctx context.Context, candidate *paprikav1.ApplicationPromotionStatus) error {
	var app paprikav1.Application
	if err := r.client.Get(ctx, types.NamespacedName{Name: candidate.SourceApplication.Name, Namespace: candidate.SourceApplication.Namespace}, &app); err != nil {
		return promotionBlocked("UpstreamUnavailable", "The upstream Application became unavailable during verification.")
	}
	var release paprikav1.Release
	if promotionCandidateIdentityChanged(candidate, &app, &release) {
		return promotionBlocked("UpstreamCandidateChanged", "The upstream Application or selected release changed during verification.")
	}
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		return promotionBlocked("UpstreamUnavailable", "The upstream Release became unavailable during verification.")
	}
	if promotionCandidateIdentityChanged(candidate, &app, &release) {
		return promotionBlocked("UpstreamCandidateChanged", "The upstream release UID or revision changed during verification.")
	}
	if err := promotionSourceReady(&app, &release, r.currentTime()); err != nil {
		return promotionBlocked("UpstreamNotReady", err.Error())
	}
	return nil
}

func (r *ApplicationReconciler) waitForPromotion(ctx context.Context, app *paprikav1.Application, reason, message string) (*ctrl.Result, error) {
	if promotionObservationInterrupted(reason) && app.Status.Promotion != nil {
		app.Status.Promotion.VerificationStartedAt = nil
	}
	preserveReady, err := promotionReadyMayWait(app, reason)
	if err != nil {
		return nil, err
	}
	if preserveReady {
		app.Status.Promotion.Message = message
	} else {
		updateWaitingPromotionCandidate(app.Status.Promotion, reason, message)
	}
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: promotionReadyCondition, Status: metav1.ConditionFalse, Reason: reason, Message: message,
		ObservedGeneration: app.Generation, LastTransitionTime: metav1.NewTime(r.currentTime()),
	})
	if err := r.patchAppStatus(ctx, app); err != nil {
		return nil, fmt.Errorf("persisting promotion wait: %w", err)
	}
	if preserveReady {
		return r.holdVerifiedPromotion(ctx, app, r.transientRequeue())
	}
	if app.Status.ReleaseRef != "" {
		return nil, nil
	}
	return &ctrl.Result{RequeueAfter: r.transientRequeue()}, nil
}

func promotionObservationInterrupted(reason string) bool {
	switch reason {
	case "UpstreamNotReady", "UpstreamUnavailable", "InvalidPromotionChain", "IncompatiblePromotionSource":
		return true
	default:
		return false
	}
}

func promotionReadyMayWait(app *paprikav1.Application, reason string) (bool, error) {
	candidate := app.Status.Promotion
	if (reason != "UpstreamNotReady" && reason != "UpstreamUnavailable" && reason != "PromotionObservationPending") || candidate == nil || candidate.Phase != "Ready" || candidate.VerificationConfigHash == "" {
		return false, nil
	}
	configurationHash, err := promotionVerificationConfigHash(app)
	if err != nil {
		return false, err
	}
	return candidate.VerificationConfigHash == configurationHash, nil
}

func updateWaitingPromotionCandidate(candidate *paprikav1.ApplicationPromotionStatus, reason, message string) {
	if candidate == nil {
		return
	}
	if (candidate.Phase == "Ready" || candidate.Phase == "AwaitingApproval") && reason != "PromotionAwaitingApproval" {
		candidate.Phase = "Verifying"
		candidate.VerificationStartedAt = nil
	}
	// Preserve failed verification diagnostics until a different candidate arrives.
	if candidate.Phase != "Failed" || candidate.Message == "" || reason == "UpstreamCandidateChanged" || reason == "PromotionGateFailed" {
		candidate.Message = message
	}
}

func promotionVerificationConfigHash(app *paprikav1.Application) (string, error) {
	configuration, err := json.Marshal(app.Spec)
	if err != nil {
		return "", fmt.Errorf("encoding promotion target specification: %w", err)
	}
	sum := sha256.Sum256(configuration)
	return hex.EncodeToString(sum[:]), nil
}

func promotionPipelineName(app *paprikav1.Application) (string, error) {
	candidate := app.Status.Promotion
	configuration, err := json.Marshal(app.Spec.Trigger.Tests)
	if err != nil {
		return "", fmt.Errorf("encoding promotion test configuration: %w", err)
	}
	identity := string(app.UID) + "\x00" + candidate.SourceApplicationUID + "\x00" + candidate.SourceReleaseUID + "\x00" + string(configuration)
	if candidate.VerificationAttempt != "" {
		identity += "\x00" + candidate.VerificationAttempt + "\x00" + candidate.VerificationConfigHash
	}
	sum := sha256.Sum256([]byte(identity))
	return addNameSuffix(truncateKubernetesName(app.Name+"-promotion-tests"), hex.EncodeToString(sum[:])[:12]), nil
}

func (r *ApplicationReconciler) reconcilePromotionTests(ctx context.Context, app *paprikav1.Application) (bool, error) {
	tests := app.Spec.Trigger.Tests
	if tests == nil || len(tests.Steps) == 0 {
		return true, nil
	}
	expected, err := r.promotionTestPipeline(app)
	if err != nil {
		return false, err
	}
	existing, err := r.getOrCreatePromotionTestPipeline(ctx, app, expected)
	if err != nil {
		return false, err
	}
	if existing == nil {
		return false, nil
	}
	candidate := app.Status.Promotion
	if !promotionTestPipelineMatches(app, existing, expected) {
		candidate.Phase = "Failed"
		candidate.Message = "The verification Pipeline does not match this Application and immutable upstream candidate."
		return false, nil
	}
	candidate.VerificationPipelineRef = expected.Name
	return promotionTestPipelineReady(candidate, existing, expected), nil
}

func (r *ApplicationReconciler) promotionTestPipeline(app *paprikav1.Application) (*paprikav1.Pipeline, error) {
	name, err := promotionPipelineName(app)
	if err != nil {
		return nil, err
	}
	tests := app.Spec.Trigger.Tests
	candidate := app.Status.Promotion
	steps := make([]paprikav1.PipelineStep, 0, len(tests.Steps))
	prefix := promotionTestEnvironment(candidate)
	for _, step := range tests.Steps {
		steps = append(steps, paprikav1.PipelineStep{Name: step.Name, Image: step.Image, Script: prefix + step.Script, Depends: append([]string(nil), step.Depends...), Timeout: step.Timeout, Retry: step.Retry})
	}
	expected := &paprikav1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: app.Namespace,
			Labels:      withProjectLabels(app, map[string]string{engine.ApplicationNameLabelKey: app.Name}),
			Annotations: map[string]string{sourceRevisionAnnotation: candidate.Revision, promotionSourceUIDAnnotation: candidate.SourceApplicationUID, promotionReleaseUIDAnnotation: candidate.SourceReleaseUID},
		},
		Spec: paprikav1.PipelineSpec{Steps: steps, Sources: append([]paprikav1.Source(nil), tests.Sources...), MaxParallel: tests.MaxParallel, Artifacts: append([]paprikav1.PipelineOutput(nil), tests.Artifacts...)},
	}
	if candidate.VerificationAttempt != "" {
		expected.Annotations[promotionRetryAnnotation] = candidate.VerificationAttempt
		expected.Annotations["paprika.io/promotion-verification-config"] = candidate.VerificationConfigHash
	}
	if err := ctrl.SetControllerReference(app, expected, r.Scheme); err != nil {
		return nil, fmt.Errorf("setting promotion test Pipeline owner: %w", err)
	}
	return expected, nil
}

func (r *ApplicationReconciler) getOrCreatePromotionTestPipeline(ctx context.Context, app *paprikav1.Application, expected *paprikav1.Pipeline) (*paprikav1.Pipeline, error) {
	var existing paprikav1.Pipeline
	err := r.client.Get(ctx, client.ObjectKeyFromObject(expected), &existing)
	if apierrors.IsNotFound(err) {
		if err = r.client.Create(ctx, expected); err != nil && !apierrors.IsAlreadyExists(err) {
			return nil, fmt.Errorf("creating promotion verification Pipeline: %w", err)
		}
		app.Status.Promotion.VerificationPipelineRef = expected.Name
		app.Status.Promotion.Message = "Waiting for upstream integration tests."
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("getting promotion verification Pipeline: %w", err)
	}
	return &existing, nil
}

func promotionTestPipelineMatches(app *paprikav1.Application, existing, expected *paprikav1.Pipeline) bool {
	candidate := app.Status.Promotion
	return metav1.IsControlledBy(existing, app) && existing.Annotations[promotionRetryAnnotation] == candidate.VerificationAttempt &&
		(candidate.VerificationAttempt == "" || existing.Annotations["paprika.io/promotion-verification-config"] == candidate.VerificationConfigHash) && existing.Annotations[promotionReleaseUIDAnnotation] == candidate.SourceReleaseUID &&
		existing.Annotations[promotionSourceUIDAnnotation] == candidate.SourceApplicationUID &&
		existing.Annotations[sourceRevisionAnnotation] == candidate.Revision && reflect.DeepEqual(existing.Spec, expected.Spec)
}

func promotionTestPipelineReady(candidate *paprikav1.ApplicationPromotionStatus, existing, expected *paprikav1.Pipeline) bool {
	switch existing.Status.Phase {
	case paprikav1.PipelineFailed, paprikav1.PipelineCancelled:
		candidate.Phase = "Failed"
		candidate.Message = "Upstream integration tests failed or were cancelled."
		return false
	case paprikav1.PipelineSucceeded:
		return promotionTestStepsReady(candidate, existing, expected)
	case paprikav1.PipelineRunning:
		candidate.Message = "Waiting for upstream integration tests."
		return false
	default:
		candidate.Message = "Waiting for upstream integration tests."
		return false
	}
}

func promotionTestStepsReady(candidate *paprikav1.ApplicationPromotionStatus, existing, expected *paprikav1.Pipeline) bool {
	if existing.Status.ObservedGeneration != existing.Generation {
		candidate.Message = "Waiting for integration tests to observe their current specification."
		return false
	}
	statuses := make(map[string]paprikav1.StepPhase, len(existing.Status.StepStatuses))
	for _, status := range existing.Status.StepStatuses {
		statuses[status.Name] = status.Phase
	}
	for _, step := range expected.Spec.Steps {
		if statuses[step.Name] != paprikav1.StepSucceeded {
			candidate.Phase = "Failed"
			candidate.Message = "Every integration test step must succeed before promotion."
			return false
		}
	}
	return true
}

func promotionTestEnvironment(candidate *paprikav1.ApplicationPromotionStatus) string {
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
	prefix := "export PAPRIKA_PROMOTION_REVISION=" + quote(candidate.Revision) + "\n" +
		"export PAPRIKA_PROMOTION_SOURCE_APPLICATION=" + quote(candidate.SourceApplication.Name) + "\n" +
		"export PAPRIKA_PROMOTION_SOURCE_NAMESPACE=" + quote(candidate.SourceApplication.Namespace) + "\n" +
		"export PAPRIKA_PROMOTION_SOURCE_RELEASE=" + quote(candidate.SourceRelease) + "\n"
	if candidate.VerificationAttempt != "" {
		prefix += "export PAPRIKA_PROMOTION_ATTEMPT=" + quote(candidate.VerificationAttempt) + "\n"
	}
	return prefix
}

func (r *ApplicationReconciler) consumePromotionApproval(ctx context.Context, app *paprikav1.Application, uid string) error {
	var latest paprikav1.Application
	if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
		return fmt.Errorf("reading candidate promotion approval: %w", err)
	}
	configurationHash, err := promotionVerificationConfigHash(app)
	if err != nil {
		return err
	}
	latestHash, err := promotionVerificationConfigHash(&latest)
	if err != nil {
		return err
	}
	if latest.UID != app.UID || latest.Generation != app.Generation || latestHash != configurationHash || latest.Annotations[promotionApprovalAnnotation] != uid {
		return errors.New("candidate promotion approval changed; retrying")
	}
	base := latest.DeepCopy()
	delete(latest.Annotations, promotionApprovalAnnotation)
	if err := r.client.Patch(ctx, &latest, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
		return fmt.Errorf("consuming candidate promotion approval: %w", err)
	}
	delete(app.Annotations, promotionApprovalAnnotation)
	app.ResourceVersion = latest.ResourceVersion
	return nil
}

// Record authorization for the specification that was actually verified, using
// an optimistic status write so a concurrent edit cannot inherit approval.
// The delivery path activates the new deployment intent after sync admission.
func (r *ApplicationReconciler) persistReadyPromotion(ctx context.Context, app *paprikav1.Application) error {
	normalizePhaseConditions(app, "PhaseChanged", "phase "+string(app.Status.Phase)+" is active")
	desired := app.Status.DeepCopy()
	configurationHash, err := promotionVerificationConfigHash(app)
	if err != nil {
		return err
	}
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		return r.writeReadyPromotion(ctx, app, desired, configurationHash)
	})
	if err != nil {
		return fmt.Errorf("persisting promotion authorization: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) writeReadyPromotion(ctx context.Context, app *paprikav1.Application, desired *paprikav1.ApplicationStatus, configurationHash string) error {
	var latest paprikav1.Application
	if err := r.client.Get(ctx, client.ObjectKeyFromObject(app), &latest); err != nil {
		return fmt.Errorf("reading verified promotion target: %w", err)
	}
	latestHash, err := promotionVerificationConfigHash(&latest)
	if err != nil {
		return err
	}
	if latest.UID != app.UID || latest.Generation != app.Generation || latestHash != configurationHash {
		return errors.New("promotion target specification changed during verification; retrying")
	}
	// A conflicting cached read must not carry an old ReleaseRef into the next
	// attempt after the API has already persisted its removal.
	attemptStatus := desired.DeepCopy()
	preservePromotionDeploymentStatus(attemptStatus, &latest.Status)
	attemptStatus.ObservedGeneration = latest.Generation
	latest.Status = *attemptStatus
	if err := r.client.Status().Update(ctx, &latest); err != nil {
		return fmt.Errorf("writing verified promotion target: %w", err)
	}
	app.Status = latest.Status
	app.ResourceVersion = latest.ResourceVersion
	return nil
}

func preservePromotionDeploymentStatus(desired, latest *paprikav1.ApplicationStatus) {
	if desired.ReleaseRef == "" && latest.ReleaseRef != "" {
		desired.ReleaseRef = latest.ReleaseRef
	}
	if len(desired.Gates) == 0 && len(latest.Gates) > 0 {
		desired.Gates = latest.Gates
	}
}
