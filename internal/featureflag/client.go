package featureflag

import "context"

const (
	reasonError = "ERROR"
)

// EvaluationProvider is the composed interface FlagClient needs from a feature
// flag provider. It is defined on the consumer side so callers depend on the
// fine-grained role interfaces exported by the featureflag package rather than
// a single producer-side composed interface.
type EvaluationProvider interface {
	BoolProvider
	StringProvider
	IntProvider
	FloatProvider
}

type FlagClient struct {
	providers []EvaluationProvider
}

func NewClient(providers []EvaluationProvider) *FlagClient {
	return &FlagClient{providers: providers}
}

// EvaluateResult is the outcome of a feature flag evaluation.
type EvaluateResult struct {
	Value  any
	Reason string
}

func (c *FlagClient) Bool(ctx context.Context, flag string, defaultValue bool, evalCtx EvaluationContext) (bool, string) {
	for _, p := range c.providers {
		result, err := p.BoolEvaluation(ctx, flag, defaultValue, evalCtx)
		if err == nil {
			return result.Value, result.Reason
		}
	}
	return defaultValue, reasonError
}

func (c *FlagClient) String(ctx context.Context, flag, defaultValue string, evalCtx EvaluationContext) (string, string) {
	for _, p := range c.providers {
		result, err := p.StringEvaluation(ctx, flag, defaultValue, evalCtx)
		if err == nil {
			return result.Value, result.Reason
		}
	}
	return defaultValue, reasonError
}

func (c *FlagClient) Int(ctx context.Context, flag string, defaultValue int64, evalCtx EvaluationContext) (int64, string) {
	for _, p := range c.providers {
		result, err := p.IntEvaluation(ctx, flag, defaultValue, evalCtx)
		if err == nil {
			return result.Value, result.Reason
		}
	}
	return defaultValue, reasonError
}

func (c *FlagClient) Float(ctx context.Context, flag string, defaultValue float64, evalCtx EvaluationContext) (float64, string) {
	for _, p := range c.providers {
		result, err := p.FloatEvaluation(ctx, flag, defaultValue, evalCtx)
		if err == nil {
			return result.Value, result.Reason
		}
	}
	return defaultValue, reasonError
}
