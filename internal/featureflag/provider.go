package featureflag

import "context"

type Provider interface {
	BoolEvaluation(ctx context.Context, flag string, defaultValue bool, evalCtx EvaluationContext) (*ProviderResult[bool], error)
	StringEvaluation(ctx context.Context, flag, defaultValue string, evalCtx EvaluationContext) (*ProviderResult[string], error)
	IntEvaluation(ctx context.Context, flag string, defaultValue int64, evalCtx EvaluationContext) (*ProviderResult[int64], error)
	FloatEvaluation(ctx context.Context, flag string, defaultValue float64, evalCtx EvaluationContext) (*ProviderResult[float64], error)
	Metadata() ProviderMetadata
}

type EvaluationContext struct {
	TargetingKey string            `json:"targetingKey,omitempty"`
	User         map[string]string `json:"user,omitempty"`
	Group        map[string]string `json:"group,omitempty"`
	Device       map[string]string `json:"device,omitempty"`
	Custom       map[string]any    `json:"custom,omitempty"`
}

type ProviderResult[T any] struct {
	Value  T
	Reason string
	Flag   string
}

type ProviderMetadata struct {
	Name         string
	Capabilities []string
}
