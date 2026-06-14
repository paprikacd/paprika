package policy

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

func TestEvaluator_PassesValidManifest(t *testing.T) {
	policies := []policyv1alpha1.Policy{{
		ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityCritical,
			Match:      policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
		},
	}}
	bundle := []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
        - name: nginx
          image: nginx:1.25
`)
	eval := NewEvaluator(policies)
	res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{})
	require.NoError(t, err)
	require.True(t, res.Passed)
	require.False(t, res.Blocked)
}

func TestEvaluator_FailingEnforceBlocks(t *testing.T) {
	policies := []policyv1alpha1.Policy{{
		ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityCritical,
			Match:      policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
		},
	}}
	bundle := []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
        - name: nginx
          image: latest
`)
	eval := NewEvaluator(policies)
	res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{})
	require.NoError(t, err)
	require.False(t, res.Passed)
	require.True(t, res.Blocked)
	require.Contains(t, res.Message, "no-latest failed")
}

func TestEvaluator_WarningDoesNotBlock(t *testing.T) {
	policies := []policyv1alpha1.Policy{{
		ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityWarning,
			Match:      policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
		},
	}}
	bundle := []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
        - name: nginx
          image: latest
`)
	eval := NewEvaluator(policies)
	res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{})
	require.NoError(t, err)
	require.True(t, res.Passed)
	require.False(t, res.Blocked)
	require.Contains(t, res.Message, "no-latest warned")
}

func TestEvaluator_SkipPolicy(t *testing.T) {
	policies := []policyv1alpha1.Policy{{
		ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityCritical,
			Match:      policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
		},
	}}
	bundle := []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
        - name: nginx
          image: latest
`)
	eval := NewEvaluator(policies)
	res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{SkipPolicies: []string{"no-latest"}})
	require.NoError(t, err)
	require.True(t, res.Passed)
	require.False(t, res.Blocked)
	require.Empty(t, res.Results)
}

func TestEvaluator_PolicyOverride(t *testing.T) {
	policies := []policyv1alpha1.Policy{{
		ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityCritical,
			Match:      policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
		},
	}}
	bundle := []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
        - name: nginx
          image: latest
`)
	eval := NewEvaluator(policies)
	res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{
		PolicyOverrides: map[string]Action{"no-latest": WarnAction},
	})
	require.NoError(t, err)
	require.True(t, res.Passed)
	require.False(t, res.Blocked)
	require.Equal(t, string(policyv1alpha1.PolicyActionWarn), res.Results[0].Action)
}

func TestMatchAPIGroups(t *testing.T) {
	require.True(t, matchAPIGroups([]string{}, "apps/v1"))
	require.True(t, matchAPIGroups([]string{""}, "v1"))
	require.True(t, matchAPIGroups([]string{"apps"}, "apps/v1"))
	require.False(t, matchAPIGroups([]string{"apps"}, "v1"))
	require.True(t, matchAPIGroups([]string{"", "apps"}, "v1"))
}

func TestMatch_LabelSelector(t *testing.T) {
	obj := &unstructured.Unstructured{}
	obj.SetKind("Deployment")
	obj.SetAPIVersion("apps/v1")
	obj.SetLabels(map[string]string{"app": "nginx"})

	selector := &metav1.LabelSelector{
		MatchLabels: map[string]string{"app": "nginx"},
	}
	require.True(t, match(&policyv1alpha1.PolicyMatch{LabelSelector: selector}, obj, ""))

	selector2 := &metav1.LabelSelector{
		MatchLabels: map[string]string{"app": "redis"},
	}
	require.False(t, match(&policyv1alpha1.PolicyMatch{LabelSelector: selector2}, obj, ""))
}

func TestMatch_Namespaces(t *testing.T) {
	obj := &unstructured.Unstructured{}
	obj.SetKind("Deployment")
	obj.SetAPIVersion("apps/v1")
	obj.SetNamespace("prod")

	require.True(t, match(&policyv1alpha1.PolicyMatch{Namespaces: []string{"prod", "dev"}}, obj, ""))
	require.False(t, match(&policyv1alpha1.PolicyMatch{Namespaces: []string{"dev"}}, obj, ""))
}

func TestMatch_EmptyMatchesAll(t *testing.T) {
	obj := &unstructured.Unstructured{}
	obj.SetKind("ConfigMap")
	obj.SetAPIVersion("v1")
	obj.SetNamespace("default")

	require.True(t, match(&policyv1alpha1.PolicyMatch{}, obj, ""))
}

func TestDefaultAction(t *testing.T) {
	require.Equal(t, policyv1alpha1.PolicyActionEnforce, defaultAction(policyv1alpha1.PolicySeverityCritical))
	require.Equal(t, policyv1alpha1.PolicyActionWarn, defaultAction(policyv1alpha1.PolicySeverityWarning))
}

func TestResolveAction(t *testing.T) {
	pol := policyv1alpha1.Policy{
		ObjectMeta: metav1.ObjectMeta{Name: "p"},
		Spec: policyv1alpha1.PolicySpec{
			Severity: policyv1alpha1.PolicySeverityCritical,
		},
	}
	require.Equal(t, policyv1alpha1.PolicyActionEnforce, resolveAction(&pol, nil))

	pol.Spec.DefaultAction = policyv1alpha1.PolicyActionWarn
	require.Equal(t, policyv1alpha1.PolicyActionWarn, resolveAction(&pol, nil))

	overrides := map[string]Action{"p": EnforceAction}
	require.Equal(t, policyv1alpha1.PolicyActionEnforce, resolveAction(&pol, overrides))
}
