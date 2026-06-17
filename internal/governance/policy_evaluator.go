package governance

// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/policy"
)

type PolicyEvaluator struct {
	client client.Reader
}

func NewPolicyEvaluator(c client.Reader) *PolicyEvaluator {
	return &PolicyEvaluator{client: c}
}

func (e *PolicyEvaluator) Evaluate(ctx context.Context, project string, manifests []*unstructured.Unstructured, opts policy.EvaluateOptions) (Violations, error) {
	var list policyv1alpha1.PolicyList
	if err := e.client.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("list policies: %w", err)
	}

	selected := make([]policyv1alpha1.Policy, 0, len(list.Items))
	for i := range list.Items {
		if policyAppliesToProject(&list.Items[i], project) {
			selected = append(selected, list.Items[i])
		}
	}

	bundle, err := renderBundle(manifests)
	if err != nil {
		return nil, fmt.Errorf("render bundle: %w", err)
	}

	result, err := policy.NewEvaluator(selected).Evaluate(ctx, bundle, opts)
	if err != nil {
		return nil, fmt.Errorf("evaluate policies: %w", err)
	}

	var violations Violations
	for i := range result.Results {
		r := &result.Results[i]
		if r.Passed {
			continue
		}
		action := PolicyAction(r.Action)
		if action == "" {
			action = PolicyActionEnforce
		}
		violations = append(violations, Violation{
			Rule:     r.Name,
			Severity: r.Severity,
			Message:  r.Message,
			Action:   action,
		})
	}
	return violations, nil
}

func policyAppliesToProject(p *policyv1alpha1.Policy, project string) bool {
	if len(p.Spec.Projects) == 0 {
		return true
	}
	for _, pr := range p.Spec.Projects {
		if pr == "*" || pr == project {
			return true
		}
	}
	return false
}

func renderBundle(manifests []*unstructured.Unstructured) ([]byte, error) {
	var out []byte
	for i, m := range manifests {
		if i > 0 {
			out = append(out, []byte("\n---\n")...)
		}
		b, err := yaml.Marshal(m.Object)
		if err != nil {
			return nil, fmt.Errorf("marshal manifest: %w", err)
		}
		out = append(out, b...)
	}
	return out, nil
}
