// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/analysis"
)

// Analyzer runs analysis checks for pipeline stages. namespace is the
// namespace of the resource under analysis (release, analysis run, or
// rollout) — podMetrics checks list pods there, not in the operator
// namespace.
type Analyzer interface {
	RunChecks(ctx context.Context, namespace string, checks []pipelinesv1alpha1.AnalysisCheck) []analysis.Result
}
