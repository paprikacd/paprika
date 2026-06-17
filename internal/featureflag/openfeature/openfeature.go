package openfeature

import (
	"context"
	"fmt"

	ofg "github.com/open-feature/go-sdk/openfeature"

	"github.com/benebsworth/paprika/internal/featureflag"
)

type Provider struct {
	client ofg.IClient
	name   string
}

func NewProvider(client ofg.IClient) *Provider {
	return &Provider{client: client, name: "openfeature"}
}

func NewProviderWithName(client ofg.IClient, name string) *Provider {
	return &Provider{client: client, name: name}
}

func (p *Provider) Metadata() featureflag.ProviderMetadata {
	return featureflag.ProviderMetadata{
		Name:         p.name,
		Capabilities: []string{"bool", "string", "int", "float"},
	}
}

func (p *Provider) BoolEvaluation(ctx context.Context, flag string, defaultValue bool, _ featureflag.EvaluationContext) (*featureflag.ProviderResult[bool], error) {
	val, err := p.client.BooleanValue(ctx, flag, defaultValue, ofg.EvaluationContext{})
	if err != nil {
		return nil, fmt.Errorf("openfeature bool evaluation: %w", err)
	}
	return &featureflag.ProviderResult[bool]{Value: val, Reason: "PROVIDER", Flag: flag}, nil
}

func (p *Provider) StringEvaluation(ctx context.Context, flag, defaultValue string, _ featureflag.EvaluationContext) (*featureflag.ProviderResult[string], error) {
	val, err := p.client.StringValue(ctx, flag, defaultValue, ofg.EvaluationContext{})
	if err != nil {
		return nil, fmt.Errorf("openfeature string evaluation: %w", err)
	}
	return &featureflag.ProviderResult[string]{Value: val, Reason: "PROVIDER", Flag: flag}, nil
}

func (p *Provider) IntEvaluation(ctx context.Context, flag string, defaultValue int64, _ featureflag.EvaluationContext) (*featureflag.ProviderResult[int64], error) {
	val, err := p.client.IntValue(ctx, flag, defaultValue, ofg.EvaluationContext{})
	if err != nil {
		return nil, fmt.Errorf("openfeature int evaluation: %w", err)
	}
	return &featureflag.ProviderResult[int64]{Value: val, Reason: "PROVIDER", Flag: flag}, nil
}

func (p *Provider) FloatEvaluation(ctx context.Context, flag string, defaultValue float64, _ featureflag.EvaluationContext) (*featureflag.ProviderResult[float64], error) {
	val, err := p.client.FloatValue(ctx, flag, defaultValue, ofg.EvaluationContext{})
	if err != nil {
		return nil, fmt.Errorf("openfeature float evaluation: %w", err)
	}
	return &featureflag.ProviderResult[float64]{Value: val, Reason: "PROVIDER", Flag: flag}, nil
}
