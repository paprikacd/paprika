// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/analysis"
)

// Analyzer runs analysis checks for pipeline stages.
type Analyzer interface {
	RunChecks(ctx context.Context, checks []pipelinesv1alpha1.AnalysisCheck) []analysis.Result
}
