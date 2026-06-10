// Package health provides CEL-based health evaluation with HTTP probe support.
package health

import (
	"context"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

//go:generate mockgen -destination=mocks/health_evaluator.go -package=mocks . HealthEvaluator
//go:generate mockgen -destination=mocks/resource_health_checker.go -package=mocks . ResourceHealthChecker

// HealthEvaluator evaluates CEL expressions for health checks.
type HealthEvaluator interface {
	// Evaluate runs a health check and returns the result.
	Evaluate(ctx context.Context, check paprikav1.HealthCheck, app *paprikav1.Application) EvalResult
}

// ResourceHealthChecker checks the health of Kubernetes resources.
type ResourceHealthChecker interface {
	// Check evaluates the health of a specific resource.
	Check(ctx context.Context, kind, name, namespace string) paprikav1.ResourceHealth
}
