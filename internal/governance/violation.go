package governance

import policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"

type PolicyAction string

const (
	PolicyActionEnforce PolicyAction = PolicyAction(policyv1alpha1.PolicyActionEnforce)
	PolicyActionWarn    PolicyAction = PolicyAction(policyv1alpha1.PolicyActionWarn)
)

type Violation struct {
	Rule     string
	Severity string
	Message  string
	Action   PolicyAction
}

// SeverityNotReady is a sentinel Severity marking a violation produced because a policy
// could not be fully evaluated (it failed to compile, or was missing/unresolvable). Consumers
// use it to distinguish "evaluation incomplete" from a genuine policy denial.
const SeverityNotReady = "not-ready"

func (v Violation) Blocking() bool {
	return v.Action == PolicyActionEnforce
}

type Violations []Violation

func (vs Violations) Blocking() Violations {
	var out Violations
	for _, v := range vs {
		if v.Blocking() {
			out = append(out, v)
		}
	}
	return out
}

func (vs Violations) Warnings() Violations {
	var out Violations
	for _, v := range vs {
		if !v.Blocking() {
			out = append(out, v)
		}
	}
	return out
}
