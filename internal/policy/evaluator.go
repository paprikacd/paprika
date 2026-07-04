package policy

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/google/cel-go/cel"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/yaml"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

type CELEvaluator struct {
	policies []policyv1alpha1.Policy
}

// NewCELEvaluator creates a CEL-based policy evaluator from the given policies.
func NewCELEvaluator(policies []policyv1alpha1.Policy) *CELEvaluator {
	return &CELEvaluator{policies: policies}
}

func (e *CELEvaluator) Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error) {
	docs := splitYAMLDocuments(bundle)
	var results []Result
	for _, doc := range docs {
		obj := &unstructured.Unstructured{}
		if err := yaml.Unmarshal(doc, &obj.Object); err != nil {
			return nil, fmt.Errorf("unmarshal manifest: %w", err)
		}
		if obj.Object == nil {
			continue
		}
		for i := range e.policies {
			pol := &e.policies[i]
			if skip(opts.SkipPolicies, pol.Name) {
				continue
			}
			if !match(&pol.Spec.Match, obj, opts.Namespace) {
				continue
			}
			passed, msg := e.evalPolicy(ctx, pol.Spec.Expression, obj)
			action := resolveAction(pol, opts.PolicyOverrides)
			results = append(results, Result{
				Name:     pol.Name,
				Severity: string(pol.Spec.Severity),
				Action:   string(action),
				Passed:   passed,
				Message:  msg,
			})
		}
	}
	return aggregate(results), nil
}

func skip(list []string, name string) bool {
	for _, n := range list {
		if n == name {
			return true
		}
	}
	return false
}

func resolveAction(pol *policyv1alpha1.Policy, overrides map[string]Action) policyv1alpha1.PolicyAction {
	if overrides != nil {
		if a, ok := overrides[pol.Name]; ok {
			return policyv1alpha1.PolicyAction(a)
		}
	}
	if pol.Spec.DefaultAction != "" {
		return pol.Spec.DefaultAction
	}
	return defaultAction(pol.Spec.Severity)
}

func matchAPIGroups(groups []string, apiVersion string) bool {
	if len(groups) == 0 {
		return true
	}
	group := ""
	if i := strings.Index(apiVersion, "/"); i >= 0 {
		group = apiVersion[:i]
	}
	return slices.Contains(groups, group)
}

func match(m *policyv1alpha1.PolicyMatch, obj *unstructured.Unstructured, namespace string) bool {
	if !matchAPIGroups(m.APIGroups, obj.GetAPIVersion()) {
		return false
	}
	if len(m.Kinds) > 0 && !slices.Contains(m.Kinds, obj.GetKind()) {
		return false
	}
	// match.namespaces filters by the resource's own namespace.
	if len(m.Namespaces) > 0 && !slices.Contains(m.Namespaces, obj.GetNamespace()) {
		return false
	}
	if m.LabelSelector != nil {
		selector, err := metav1.LabelSelectorAsSelector(m.LabelSelector)
		if err == nil && !selector.Matches(labels.Set(obj.GetLabels())) {
			return false
		}
	}
	return true
}

func splitYAMLDocuments(bundle []byte) [][]byte {
	return engine.SplitYAMLDocuments(bundle)
}

func (e *CELEvaluator) evalPolicy(ctx context.Context, expr string, obj *unstructured.Unstructured) (passed bool, msg string) {
	env, err := cel.NewEnv(
		cel.Variable("object", cel.MapType(cel.StringType, cel.AnyType)),
		cel.Variable("kind", cel.StringType),
		cel.Variable("apiVersion", cel.StringType),
		cel.Variable("name", cel.StringType),
		cel.Variable("namespace", cel.StringType),
		cel.Variable("labels", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("annotations", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("spec", cel.MapType(cel.StringType, cel.AnyType)),
	)
	if err != nil {
		return false, fmt.Sprintf("env error: %v", err)
	}
	ast, iss := env.Compile(expr)
	if iss != nil {
		return false, fmt.Sprintf("compile error: %v", iss.Err())
	}
	prg, err := env.Program(ast)
	if err != nil {
		return false, fmt.Sprintf("program error: %v", err)
	}
	labels := obj.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	annotations := obj.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	spec, ok := obj.Object["spec"].(map[string]interface{})
	if !ok || spec == nil {
		spec = map[string]interface{}{}
	}
	vars := map[string]interface{}{
		"object":      obj.Object,
		"kind":        obj.GetKind(),
		"apiVersion":  obj.GetAPIVersion(),
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"labels":      labels,
		"annotations": annotations,
		"spec":        spec,
	}
	out, _, err := prg.Eval(vars)
	if err != nil {
		return false, fmt.Sprintf("eval error: %v", err)
	}
	val := out.Value()
	if b, ok := val.(bool); ok {
		return b, ""
	}
	return false, "policy did not return boolean"
}

func aggregate(results []Result) *EvaluationResult {
	ev := &EvaluationResult{Passed: true, Results: results}
	for _, r := range results {
		if !r.Passed && r.Action == string(policyv1alpha1.PolicyActionEnforce) {
			ev.Passed = false
			ev.Blocked = true
			ev.Message = fmt.Sprintf("policy %s failed", r.Name)
			return ev
		}
		if !r.Passed {
			ev.Message = fmt.Sprintf("policy %s warned", r.Name)
		}
	}
	return ev
}
