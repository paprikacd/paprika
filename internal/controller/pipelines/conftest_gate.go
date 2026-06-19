package pipelines

import (
	"context"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// ConftestEvaluator resolves, compiles, and evaluates ConftestPolicies against rendered
// manifests. Compile errors and missing policies are returned as blocking governance.Violations.
type ConftestEvaluator interface {
	Evaluate(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error)
}

const (
	conftestConditionType            = "ConftestPassed"
	conftestReasonPassed             = "Passed"
	conftestReasonPassedWithWarnings = "PassedWithWarnings"
	conftestReasonPolicyViolation    = "PolicyViolation"
	conftestReasonPolicyNotReady     = "PolicyNotReady"
	conftestSeverityNotReady         = "not-ready"
)
