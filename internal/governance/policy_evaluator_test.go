package governance

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/policy"
)

func TestPolicyEvaluator_SelectsByProject(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, policyv1alpha1.AddToScheme(scheme))

	pol := &policyv1alpha1.Policy{
		ObjectMeta: metav1.ObjectMeta{Name: "require-labels"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:      policyv1alpha1.PolicySeverityCritical,
			DefaultAction: policyv1alpha1.PolicyActionEnforce,
			Projects:      []string{"payments"},
			Match: policyv1alpha1.PolicyMatch{
				Kinds: []string{"Deployment"},
			},
			Expression: `has(object.metadata.labels.app)`,
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pol).Build()
	e := NewPolicyEvaluator(c)

	manifests := []*unstructured.Unstructured{
		{Object: map[string]interface{}{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]interface{}{"name": "app", "namespace": "payments"}}},
	}
	violations, err := e.Evaluate(context.Background(), "payments", manifests, policy.EvaluateOptions{Namespace: "payments"})
	require.NoError(t, err)
	require.Len(t, violations, 1)
	assert.True(t, violations[0].Blocking())
}

func TestPolicyEvaluator_SkipsOtherProjects(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, policyv1alpha1.AddToScheme(scheme))

	pol := &policyv1alpha1.Policy{
		ObjectMeta: metav1.ObjectMeta{Name: "require-labels"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:      policyv1alpha1.PolicySeverityCritical,
			DefaultAction: policyv1alpha1.PolicyActionEnforce,
			Projects:      []string{"payments"},
			Match:         policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression:    `has(object.metadata.labels.app)`,
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pol).Build()
	e := NewPolicyEvaluator(c)

	manifests := []*unstructured.Unstructured{
		{Object: map[string]interface{}{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]interface{}{"name": "app"}}},
	}
	violations, err := e.Evaluate(context.Background(), "other", manifests, policy.EvaluateOptions{})
	require.NoError(t, err)
	assert.Empty(t, violations)
}
