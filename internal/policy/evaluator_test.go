package policy

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

func TestEvaluator(t *testing.T) {
	t.Parallel()

	policy := policyv1alpha1.Policy{
		ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityCritical,
			Match:      policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
		},
	}

	passingBundle := []byte(`
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

	failingBundle := []byte(`
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

	tests := []struct {
		name            string
		policies        []policyv1alpha1.Policy
		bundle          []byte
		opts            EvaluateOptions
		wantPassed      bool
		wantBlocked     bool
		wantMsg         string
		wantResults     int
		wantFirstAction string
	}{
		{
			name:        "passes valid manifest",
			policies:    []policyv1alpha1.Policy{policy},
			bundle:      passingBundle,
			wantPassed:  true,
			wantResults: 1,
		},
		{
			name:        "failing enforce blocks",
			policies:    []policyv1alpha1.Policy{policy},
			bundle:      failingBundle,
			wantBlocked: true,
			wantMsg:     "no-latest failed",
			wantResults: 1,
		},
		{
			name:        "warning does not block",
			policies:    []policyv1alpha1.Policy{withSeverity(policy, policyv1alpha1.PolicySeverityWarning)},
			bundle:      failingBundle,
			wantPassed:  true,
			wantMsg:     "no-latest warned",
			wantResults: 1,
		},
		{
			name:        "skip policy",
			policies:    []policyv1alpha1.Policy{policy},
			bundle:      failingBundle,
			opts:        EvaluateOptions{SkipPolicies: []string{"no-latest"}},
			wantPassed:  true,
			wantResults: 0,
		},
		{
			name:            "policy override",
			policies:        []policyv1alpha1.Policy{policy},
			bundle:          failingBundle,
			opts:            EvaluateOptions{PolicyOverrides: map[string]Action{"no-latest": WarnAction}},
			wantPassed:      true,
			wantResults:     1,
			wantFirstAction: string(policyv1alpha1.PolicyActionWarn),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			eval := NewCELEvaluator(tc.policies)
			res, err := eval.Evaluate(context.Background(), tc.bundle, tc.opts)
			require.NoError(t, err)
			require.Equal(t, tc.wantPassed, res.Passed)
			require.Equal(t, tc.wantBlocked, res.Blocked)
			if tc.wantMsg != "" {
				require.Contains(t, res.Message, tc.wantMsg)
			}
			require.Len(t, res.Results, tc.wantResults)
			if tc.wantFirstAction != "" && len(res.Results) > 0 {
				require.Equal(t, tc.wantFirstAction, res.Results[0].Action)
			}
		})
	}
}

func withSeverity(p policyv1alpha1.Policy, severity policyv1alpha1.PolicySeverity) policyv1alpha1.Policy {
	p.Spec.Severity = severity
	return p
}

func TestMatch(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		match *policyv1alpha1.PolicyMatch
		obj   *unstructured.Unstructured
		want  bool
	}{
		{
			name:  "empty match matches all",
			match: &policyv1alpha1.PolicyMatch{},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("ConfigMap")
				o.SetAPIVersion("v1")
				o.SetNamespace("default")
				return o
			}(),
			want: true,
		},
		{
			name:  "api group match",
			match: &policyv1alpha1.PolicyMatch{APIGroups: []string{"apps"}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Deployment")
				o.SetAPIVersion("apps/v1")
				return o
			}(),
			want: true,
		},
		{
			name:  "api group mismatch",
			match: &policyv1alpha1.PolicyMatch{APIGroups: []string{"apps"}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("ConfigMap")
				o.SetAPIVersion("v1")
				return o
			}(),
			want: false,
		},
		{
			name:  "core api group match",
			match: &policyv1alpha1.PolicyMatch{APIGroups: []string{""}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("ConfigMap")
				o.SetAPIVersion("v1")
				return o
			}(),
			want: true,
		},
		{
			name:  "kind match",
			match: &policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Deployment")
				o.SetAPIVersion("apps/v1")
				return o
			}(),
			want: true,
		},
		{
			name:  "kind mismatch",
			match: &policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Service")
				o.SetAPIVersion("v1")
				return o
			}(),
			want: false,
		},
		{
			name:  "namespace match",
			match: &policyv1alpha1.PolicyMatch{Namespaces: []string{"prod", "dev"}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Deployment")
				o.SetAPIVersion("apps/v1")
				o.SetNamespace("prod")
				return o
			}(),
			want: true,
		},
		{
			name:  "namespace mismatch",
			match: &policyv1alpha1.PolicyMatch{Namespaces: []string{"dev"}},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Deployment")
				o.SetAPIVersion("apps/v1")
				o.SetNamespace("prod")
				return o
			}(),
			want: false,
		},
		{
			name: "label selector match",
			match: &policyv1alpha1.PolicyMatch{
				LabelSelector: &metav1.LabelSelector{
					MatchLabels: map[string]string{"app": "nginx"},
				},
			},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Deployment")
				o.SetAPIVersion("apps/v1")
				o.SetLabels(map[string]string{"app": "nginx"})
				return o
			}(),
			want: true,
		},
		{
			name: "label selector mismatch",
			match: &policyv1alpha1.PolicyMatch{
				LabelSelector: &metav1.LabelSelector{
					MatchLabels: map[string]string{"app": "redis"},
				},
			},
			obj: func() *unstructured.Unstructured {
				o := &unstructured.Unstructured{}
				o.SetKind("Deployment")
				o.SetAPIVersion("apps/v1")
				o.SetLabels(map[string]string{"app": "nginx"})
				return o
			}(),
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			require.Equal(t, tc.want, match(tc.match, tc.obj, ""))
		})
	}
}

func TestResolveAction(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		severity   policyv1alpha1.PolicySeverity
		defaultAct policyv1alpha1.PolicyAction
		overrides  map[string]Action
		want       policyv1alpha1.PolicyAction
	}{
		{
			name:     "critical severity defaults to enforce",
			severity: policyv1alpha1.PolicySeverityCritical,
			want:     policyv1alpha1.PolicyActionEnforce,
		},
		{
			name:     "warning severity defaults to warn",
			severity: policyv1alpha1.PolicySeverityWarning,
			want:     policyv1alpha1.PolicyActionWarn,
		},
		{
			name:       "policy default action overrides severity",
			severity:   policyv1alpha1.PolicySeverityCritical,
			defaultAct: policyv1alpha1.PolicyActionWarn,
			want:       policyv1alpha1.PolicyActionWarn,
		},
		{
			name:       "override takes precedence",
			severity:   policyv1alpha1.PolicySeverityCritical,
			defaultAct: policyv1alpha1.PolicyActionWarn,
			overrides:  map[string]Action{"p": EnforceAction},
			want:       policyv1alpha1.PolicyActionEnforce,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			pol := policyv1alpha1.Policy{
				ObjectMeta: metav1.ObjectMeta{Name: "p"},
				Spec: policyv1alpha1.PolicySpec{
					Severity:      tc.severity,
					DefaultAction: tc.defaultAct,
				},
			}
			require.Equal(t, tc.want, resolveAction(&pol, tc.overrides))
		})
	}
}
