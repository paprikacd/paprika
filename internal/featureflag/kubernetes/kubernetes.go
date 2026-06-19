package kubernetes

import (
	"context"
	"fmt"
	"reflect"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/ext"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
	"github.com/benebsworth/paprika/internal/featureflag"
)

type Provider struct {
	client client.Client
	name   string
}

func NewProvider(c client.Client) *Provider {
	return &Provider{client: c, name: "kubernetes"}
}

func (p *Provider) Metadata() featureflag.ProviderMetadata {
	return featureflag.ProviderMetadata{
		Name:         p.name,
		Capabilities: []string{"bool", "string", "int", "float", "targeting"},
	}
}

func (p *Provider) BoolEvaluation(ctx context.Context, flag string, defaultValue bool, evalCtx featureflag.EvaluationContext) (*featureflag.ProviderResult[bool], error) {
	ff, err := p.getFeatureFlag(ctx, flag)
	if err != nil {
		return nil, err
	}
	return evaluate(ctx, ff, evalCtx, func(v featureflagsv1alpha1.FeatureFlagValue) (bool, error) {
		if v.BoolValue == nil {
			return defaultValue, nil
		}
		return *v.BoolValue, nil
	}, defaultValue, "boolean")
}

func (p *Provider) StringEvaluation(ctx context.Context, flag, defaultValue string, evalCtx featureflag.EvaluationContext) (*featureflag.ProviderResult[string], error) {
	ff, err := p.getFeatureFlag(ctx, flag)
	if err != nil {
		return nil, err
	}
	return evaluate(ctx, ff, evalCtx, func(v featureflagsv1alpha1.FeatureFlagValue) (string, error) {
		if v.StringValue == nil {
			return defaultValue, nil
		}
		return *v.StringValue, nil
	}, defaultValue, "string")
}

func (p *Provider) IntEvaluation(ctx context.Context, flag string, defaultValue int64, evalCtx featureflag.EvaluationContext) (*featureflag.ProviderResult[int64], error) {
	ff, err := p.getFeatureFlag(ctx, flag)
	if err != nil {
		return nil, err
	}
	return evaluate(ctx, ff, evalCtx, func(v featureflagsv1alpha1.FeatureFlagValue) (int64, error) {
		if v.IntValue == nil {
			return defaultValue, nil
		}
		return *v.IntValue, nil
	}, defaultValue, "int")
}

func (p *Provider) FloatEvaluation(ctx context.Context, flag string, defaultValue float64, evalCtx featureflag.EvaluationContext) (*featureflag.ProviderResult[float64], error) {
	ff, err := p.getFeatureFlag(ctx, flag)
	if err != nil {
		return nil, err
	}
	return evaluate(ctx, ff, evalCtx, func(v featureflagsv1alpha1.FeatureFlagValue) (float64, error) {
		if v.FloatValue == nil {
			return defaultValue, nil
		}
		return *v.FloatValue, nil
	}, defaultValue, "float")
}

func (p *Provider) getFeatureFlag(ctx context.Context, name string) (*featureflagsv1alpha1.FeatureFlag, error) {
	var ff featureflagsv1alpha1.FeatureFlag
	if err := p.client.Get(ctx, types.NamespacedName{Name: name}, &ff); err != nil {
		return nil, fmt.Errorf("get feature flag %q: %w", name, err)
	}
	return &ff, nil
}

//nolint:gocritic // generic parameters are unavoidable for typed evaluation.
func evaluate[T any](_ context.Context, ff *featureflagsv1alpha1.FeatureFlag, evalCtx featureflag.EvaluationContext, extract func(featureflagsv1alpha1.FeatureFlagValue) (T, error), defaultValue T, expectedType string) (*featureflag.ProviderResult[T], error) {
	if ff.Spec.Disabled {
		return &featureflag.ProviderResult[T]{Value: defaultValue, Reason: "DISABLED", Flag: ff.Name}, nil
	}

	if ff.Spec.Type != expectedType {
		return nil, fmt.Errorf("feature flag %q has type %q, expected %q", ff.Name, ff.Spec.Type, expectedType)
	}

	for _, rule := range ff.Spec.Rules {
		match, err := evaluateCEL(rule.Condition, evalCtx)
		if err != nil {
			return nil, fmt.Errorf("evaluate rule %q: %w", rule.Name, err)
		}
		if match {
			val, err := extract(rule.Value)
			if err != nil {
				return nil, fmt.Errorf("extract rule value: %w", err)
			}
			return &featureflag.ProviderResult[T]{Value: val, Reason: "TARGETING", Flag: ff.Name}, nil
		}
	}

	val, err := extract(ff.Spec.DefaultValue)
	if err != nil {
		return nil, fmt.Errorf("extract default value: %w", err)
	}
	return &featureflag.ProviderResult[T]{Value: val, Reason: "STATIC", Flag: ff.Name}, nil
}

//nolint:cyclop // CEL evaluation has sequential setup steps.
func evaluateCEL(condition string, evalCtx featureflag.EvaluationContext) (bool, error) {
	env, err := cel.NewEnv(
		cel.Variable("user", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("group", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("device", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("targetingKey", cel.StringType),
		ext.Strings(),
	)
	if err != nil {
		return false, fmt.Errorf("create CEL env: %w", err)
	}

	ast, issues := env.Compile(condition)
	if issues != nil && issues.Err() != nil {
		return false, fmt.Errorf("compile CEL expression %q: %w", condition, issues.Err())
	}

	prg, err := env.Program(ast)
	if err != nil {
		return false, fmt.Errorf("create CEL program: %w", err)
	}

	userVal, err := mapToCEL(evalCtx.User)
	if err != nil {
		return false, fmt.Errorf("convert user context: %w", err)
	}
	groupVal, err := mapToCEL(evalCtx.Group)
	if err != nil {
		return false, fmt.Errorf("convert group context: %w", err)
	}
	deviceVal, err := mapToCEL(evalCtx.Device)
	if err != nil {
		return false, fmt.Errorf("convert device context: %w", err)
	}

	out, _, err := prg.Eval(map[string]any{
		"user":         userVal,
		"group":        groupVal,
		"device":       deviceVal,
		"targetingKey": evalCtx.TargetingKey,
	})
	if err != nil {
		return false, fmt.Errorf("evaluate CEL expression %q: %w", condition, err)
	}

	val, err := out.ConvertToNative(reflect.TypeOf(false))
	if err != nil {
		return false, fmt.Errorf("convert CEL result: %w", err)
	}

	result, ok := val.(bool)
	if !ok {
		return false, fmt.Errorf("evaluate CEL expression %q: result is not a bool", condition)
	}
	return result, nil
}

func mapToCEL(m map[string]string) (map[string]any, error) {
	result := make(map[string]any, len(m))
	for k, v := range m {
		result[k] = v
	}
	return result, nil
}
