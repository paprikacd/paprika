package featureflag

import "context"

const (
	reasonError = "ERROR"
)

type FlagClient struct {
	providers []Provider
}

func NewClient(providers []Provider) *FlagClient {
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
