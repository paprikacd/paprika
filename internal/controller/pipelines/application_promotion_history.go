package pipelines

import (
	"context"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

// maxPromotionPipelineHistory is the number of finished promotion verification
// Pipelines kept per Application, in addition to the protected ones.
const maxPromotionPipelineHistory = 10

// pruneOldPromotionPipelines deletes old promotion verification Pipelines.
//
// Each promotion candidate gets its own Pipeline, and nothing deleted them, so
// a promoting Application collected one Pipeline (and its step Jobs) per
// upstream release. This keeps:
//   - the Pipeline that status.promotion references,
//   - the Pipeline the current candidate maps to (deleting it would rerun its tests),
//   - every Pipeline that has not finished,
//   - the newest maxPromotionPipelineHistory finished Pipelines.
//
// The Pipeline finalizer then deletes the step Jobs of each pruned Pipeline.
func (r *ApplicationReconciler) pruneOldPromotionPipelines(ctx context.Context, app *paprikav1.Application) (int, error) {
	if app.Spec.Trigger == nil || app.Spec.Trigger.Tests == nil {
		return 0, nil
	}
	var list paprikav1.PipelineList
	if err := r.client.List(ctx, &list, client.InNamespace(app.Namespace),
		client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name}); err != nil {
		return 0, fmt.Errorf("listing promotion pipelines: %w", err)
	}
	candidates := promotionPipelinesToPrune(app, list.Items)
	deleted := 0
	for _, pipeline := range candidates {
		err := r.client.Delete(ctx, pipeline, client.Preconditions{UID: &pipeline.UID, ResourceVersion: &pipeline.ResourceVersion})
		if err != nil && !apierrors.IsNotFound(err) && !apierrors.IsConflict(err) {
			return deleted, fmt.Errorf("deleting promotion pipeline %s: %w", pipeline.Name, err)
		}
		if err == nil {
			deleted++
		}
	}
	return deleted, nil
}

func promotionPipelinesToPrune(app *paprikav1.Application, pipelines []paprikav1.Pipeline) []*paprikav1.Pipeline {
	protected := protectedPromotionPipelines(app)
	prefix := promotionPipelinePrefix(app)
	finished := make([]*paprikav1.Pipeline, 0, len(pipelines))
	for i := range pipelines {
		pipeline := &pipelines[i]
		if _, ok := protected[pipeline.Name]; ok || !prunablePromotionPipeline(app, pipeline, prefix) {
			continue
		}
		finished = append(finished, pipeline)
	}
	if len(finished) <= maxPromotionPipelineHistory {
		return nil
	}
	sort.SliceStable(finished, func(i, j int) bool {
		a, b := finished[i].CreationTimestamp, finished[j].CreationTimestamp
		if a.Equal(&b) {
			return finished[i].Name > finished[j].Name
		}
		return b.Before(&a)
	})
	return finished[maxPromotionPipelineHistory:]
}

// protectedPromotionPipelines returns the names that pruning never deletes: the
// referenced Pipeline and the Pipeline of the current candidate.
func protectedPromotionPipelines(app *paprikav1.Application) map[string]struct{} {
	protected := map[string]struct{}{}
	promotion := app.Status.Promotion
	if promotion == nil {
		return protected
	}
	if promotion.VerificationPipelineRef != "" {
		protected[promotion.VerificationPipelineRef] = struct{}{}
	}
	if promotion.SourceReleaseUID != "" {
		if name, err := promotionPipelineName(app); err == nil {
			protected[name] = struct{}{}
		}
	}
	return protected
}

// prunablePromotionPipeline reports whether the Pipeline is a finished
// verification Pipeline of the Application that is not already being deleted.
func prunablePromotionPipeline(app *paprikav1.Application, pipeline *paprikav1.Pipeline, prefix string) bool {
	return isPromotionPipeline(app, pipeline, prefix) && pipeline.DeletionTimestamp.IsZero() && pipelineFinished(pipeline.Status.Phase)
}

// promotionPipelinePrefix returns the name prefix that promotionPipelineName
// gives every verification Pipeline of the Application. It builds the name the
// same way, so a long Application name is shortened the same way.
func promotionPipelinePrefix(app *paprikav1.Application) string {
	placeholder := strings.Repeat("0", 12)
	name := addNameSuffix(truncateKubernetesName(app.Name+"-promotion-tests"), placeholder)
	return strings.TrimSuffix(name, placeholder)
}

func isPromotionPipeline(app *paprikav1.Application, pipeline *paprikav1.Pipeline, prefix string) bool {
	if !metav1.IsControlledBy(pipeline, app) || !strings.HasPrefix(pipeline.Name, prefix) {
		return false
	}
	_, ok := pipeline.Annotations[promotionReleaseUIDAnnotation]
	return ok
}

func pipelineFinished(phase paprikav1.PipelinePhase) bool {
	switch phase {
	case paprikav1.PipelineSucceeded, paprikav1.PipelineFailed, paprikav1.PipelineCancelled:
		return true
	case paprikav1.PipelineRunning:
		return false
	default:
		return false
	}
}

func (r *ApplicationReconciler) prunePromotionPipelinesQuietly(ctx context.Context, app *paprikav1.Application) {
	deleted, err := r.pruneOldPromotionPipelines(ctx, app)
	if err != nil {
		log.FromContext(ctx).Error(err, "Failed to prune promotion pipelines")
	}
	if deleted > 0 {
		r.recordEvent(app, corev1.EventTypeNormal, "PrunedPromotionPipelines", fmt.Sprintf("Pruned %d old promotion verification pipelines", deleted))
	}
}
