// Package conftest compiles and evaluates user-authored Rego policies against rendered
// manifests using OPA in-process with conftest rule conventions (deny / warn / violation).
package conftest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/open-policy-agent/opa/ast"  //nolint:staticcheck // OPA v0-compat shim: accepts the legacy Rego syntax (deny[msg]{...}) used by off-the-shelf conftest policies.
	"github.com/open-policy-agent/opa/rego" //nolint:staticcheck // OPA v0-compat shim: accepts the legacy Rego syntax (deny[msg]{...}) used by off-the-shelf conftest policies.
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

const (
	ruleDeny      = "deny"
	ruleWarn      = "warn"
	ruleViolation = "violation"
	moduleName    = "policy.rego"
)

type compiledEntry struct {
	name        string
	generation  int64
	enforcement paprikav1.ConftestEnforcementMode
	queries     map[string]*rego.PreparedEvalQuery // keyed by rule (deny/warn/violation)
}

// Evaluator resolves, compiles (cached by UID+generation), and evaluates ConftestPolicies.
type Evaluator struct {
	client client.Client
	mu     sync.RWMutex
	cache  map[types.UID]*compiledEntry
}

// NewEvaluator returns an Evaluator that reads ConftestPolicy objects via c.
func NewEvaluator(c client.Client) *Evaluator {
	return &Evaluator{client: c, cache: make(map[types.UID]*compiledEntry)}
}

// Evaluate resolves, compiles, and evaluates the referenced policies against the manifests.
// Compile errors and missing referenced policies are returned as blocking governance.Violations
// (Severity == "not-ready"). Post-compile engine errors are returned as the Go error.
func (e *Evaluator) Evaluate(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error) {
	var out governance.Violations
	for _, ref := range refs {
		entry, loadViolations, err := e.load(ctx, namespace, ref)
		if err != nil {
			return nil, fmt.Errorf("load conftest policy %q: %w", ref.Name, err)
		}
		out = append(out, loadViolations...)
		if entry == nil {
			continue
		}
		for _, obj := range manifests {
			vs, err := entry.eval(ctx, obj)
			if err != nil {
				return nil, fmt.Errorf("evaluate conftest policy %q: %w", ref.Name, err)
			}
			out = append(out, vs...)
		}
	}
	return out, nil
}

func (e *Evaluator) load(ctx context.Context, namespace string, ref paprikav1.ConftestPolicyRef) (*compiledEntry, governance.Violations, error) {
	var policy paprikav1.ConftestPolicy
	if err := e.client.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: namespace}, &policy); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, governance.Violations{{
				Rule: ref.Name, Severity: governance.SeverityNotReady,
				Message: fmt.Sprintf("conftest policy %q not found", ref.Name),
				Action:  governance.PolicyActionEnforce,
			}}, nil
		}
		return nil, nil, err
	}

	e.mu.RLock()
	entry, ok := e.cache[policy.UID]
	e.mu.RUnlock()
	if ok && entry.generation == policy.Generation {
		return entry, nil, nil
	}

	compiled, err := compile(ctx, policy.Name, policy.Spec.Rego)
	if err != nil {
		// Do not cache failed compiles so a fixed policy takes effect on the next reconcile.
		return nil, governance.Violations{{
			Rule: policy.Name, Severity: governance.SeverityNotReady,
			Message: fmt.Sprintf("compile conftest policy %q: %v", policy.Name, err),
			Action:  governance.PolicyActionEnforce,
		}}, nil
	}
	compiled.generation = policy.Generation
	compiled.enforcement = enforcementOrDefault(policy.Spec.Enforcement)

	e.mu.Lock()
	e.cache[policy.UID] = compiled
	// The cache is keyed by ConftestPolicy UID and only grows on a generation change for an
	// existing UID. Delete/recreate churn produces a new UID per object, so the prior entry is
	// not reclaimed until process restart; in practice this is bounded by distinct policy
	// lifetimes. A periodic prune against a List is a possible future improvement.
	e.mu.Unlock()
	return compiled, nil, nil
}

// CompilePolicy validates that the Rego source compiles. Exposed so the status controller
// can report policy readiness without depending on the internal compiled representation.
func CompilePolicy(ctx context.Context, name, regoSrc string) error {
	_, err := compile(ctx, name, regoSrc)
	return err
}

// compile parses and compiles a Rego source, preparing deny/warn/violation queries.
func compile(ctx context.Context, name, regoSrc string) (*compiledEntry, error) {
	mod, err := ast.ParseModule(moduleName, regoSrc)
	if err != nil {
		return nil, err
	}
	if mod == nil || mod.Package == nil {
		return nil, errors.New("rego source has no package declaration")
	}
	pkgPath := strings.TrimPrefix(mod.Package.Path.String(), "data.")

	entry := &compiledEntry{name: name, queries: map[string]*rego.PreparedEvalQuery{}}
	for _, rule := range []string{ruleDeny, ruleWarn, ruleViolation} {
		q := fmt.Sprintf("data.%s.%s", pkgPath, rule)
		// In OPA v1.x Rego.PrepareForEval returns a single PreparedEvalQuery per Rego
		// (not a slice); we pass a single query so we take the value directly.
		pq, err := rego.New(rego.Module(moduleName, regoSrc), rego.Query(q)).PrepareForEval(ctx)
		if err != nil {
			return nil, err
		}
		entry.queries[rule] = &pq
	}
	return entry, nil
}

func enforcementOrDefault(m paprikav1.ConftestEnforcementMode) paprikav1.ConftestEnforcementMode {
	if m == "" {
		return paprikav1.ConftestEnforce
	}
	return m
}

func (e *compiledEntry) eval(ctx context.Context, obj *unstructured.Unstructured) (governance.Violations, error) {
	var out governance.Violations
	for _, rule := range []string{ruleDeny, ruleViolation, ruleWarn} {
		pq := e.queries[rule]
		if pq == nil {
			continue
		}
		results, err := pq.Eval(ctx, rego.EvalInput(obj.Object))
		if err != nil {
			return nil, err
		}
		out = append(out, toViolations(e.name, rule, e.actionFor(rule), results)...)
	}
	return out, nil
}

func (e *compiledEntry) actionFor(rule string) governance.PolicyAction {
	if rule == ruleWarn {
		return governance.PolicyActionWarn
	}
	if e.enforcement == paprikav1.ConftestWarn {
		return governance.PolicyActionWarn
	}
	return governance.PolicyActionEnforce
}

func toViolations(policyName, severity string, action governance.PolicyAction, results rego.ResultSet) governance.Violations {
	var out governance.Violations
	for _, r := range results {
		for _, expr := range r.Expressions {
			list, ok := expr.Value.([]interface{})
			if !ok {
				continue
			}
			for _, item := range list {
				msg, ok := item.(string)
				if !ok {
					continue
				}
				out = append(out, governance.Violation{
					Rule: policyName, Severity: severity, Message: msg, Action: action,
				})
			}
		}
	}
	return out
}
