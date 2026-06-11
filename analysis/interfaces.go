// Package analysis provides analysis checks for pipeline verification gates.
package analysis

import (
	"context"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

//go:generate mockgen -destination=mocks/analyzer.go -package=mocks . Analyzer

// Analyzer runs analysis checks against Kubernetes resources and HTTP endpoints.
type Analyzer interface {
	RunChecks(ctx context.Context, checks []pipelinesv1alpha1.AnalysisCheck) []Result
}

// Ensure AnalyzerImpl implements Analyzer at compile time.
var _ Analyzer = (*AnalyzerImpl)(nil)
