package apiserver

import (
	"context"

	"github.com/benebsworth/paprika/internal/policy"
)

//go:generate mockgen -destination=mocks/evaluator.go -package=mocks . Evaluator

// Evaluator evaluates a rendered manifest bundle against configured policies.
type Evaluator interface {
	Evaluate(ctx context.Context, bundle []byte, opts policy.EvaluateOptions) (*policy.EvaluationResult, error)
}
