package conftest

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

const (
	denyMissingLabel = `package main
deny[msg] {
	input.kind == "Deployment"
	not input.metadata.labels.app
	msg := "Deployment missing app label"
}
`
	violateBadImage = `package main
violation[msg] {
	input.kind == "Deployment"
	input.spec.template.spec.containers[_].image == "bad:latest"
	msg := "uses bad image"
}
`
	warnNoLimits = `package main
warn[msg] {
	input.kind == "Deployment"
	not input.spec.template.spec.containers[0].resources.limits
	msg := "no cpu/memory limits"
}
`
	brokenRego = `package main
deny { syntax error here
`
)

func deployment(name string, labels map[string]string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetKind("Deployment")
	u.SetAPIVersion("apps/v1")
	u.SetName(name)
	u.SetLabels(labels)
	return u
}

func makePolicy(name, rego string, enforcement paprikav1.ConftestEnforcementMode, gen int64) *paprikav1.ConftestPolicy {
	p := &paprikav1.ConftestPolicy{Spec: paprikav1.ConftestPolicySpec{Rego: rego, Enforcement: enforcement}}
	p.SetName(name)
	p.SetNamespace("default")
	p.SetUID(types.UID(name + "-uid"))
	p.SetGeneration(gen)
	p.SetGroupVersionKind(paprikav1.GroupVersion.WithKind("ConftestPolicy"))
	return p
}

func TestEvaluate(t *testing.T) {
	cases := []struct {
		name            string
		policy          *paprikav1.ConftestPolicy
		manifests       []*unstructured.Unstructured
		wantBlock       int
		wantWarn        int
		wantErr         bool
		wantBlockSev    string // if set, first blocking violation's Severity must match (distinguishes a real rule fire from a not-found/compile error)
		wantBlockMsgSub string // if set, first blocking violation's Message must contain it
	}{
		{
			name:            "enforce deny blocks on missing label",
			policy:          makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1),
			manifests:       []*unstructured.Unstructured{deployment("d1", nil)},
			wantBlock:       1,
			wantBlockSev:    "deny",
			wantBlockMsgSub: "missing app label",
		},
		{
			name:      "enforce deny passes when label present",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", map[string]string{"app": "x"})},
			wantBlock: 0,
		},
		{
			name:            "violation rule treated as deny and blocks",
			policy:          makePolicy("p", violateBadImage, paprikav1.ConftestEnforce, 1),
			manifests:       []*unstructured.Unstructured{deploymentWithImage("d1", "bad:latest")},
			wantBlock:       1,
			wantBlockSev:    "violation",
			wantBlockMsgSub: "uses bad image",
		},
		{
			name:      "warn policy deny becomes warning not blocking",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestWarn, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", nil)},
			wantWarn:  1,
			wantBlock: 0,
		},
		{
			name:      "warn rule on enforce policy is warning not blocking",
			policy:    makePolicy("p", warnNoLimits, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", map[string]string{"app": "x"})},
			wantWarn:  1,
			wantBlock: 0,
		},
		{
			name:      "clean pass no violations",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", map[string]string{"app": "x"})},
			wantBlock: 0,
			wantWarn:  0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scheme := runtime.NewScheme()
			require.NoError(t, paprikav1.AddToScheme(scheme))
			c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(tc.policy).Build()
			e := NewEvaluator(c)
			vs, err := e.Evaluate(context.Background(), "default",
				[]paprikav1.ConftestPolicyRef{{Name: tc.policy.Name}}, tc.manifests)
			if tc.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Len(t, vs.Blocking(), tc.wantBlock, "blocking")
			assert.Len(t, vs.Warnings(), tc.wantWarn, "warnings")
			if tc.wantBlockSev != "" {
				blocking := vs.Blocking()
				require.NotEmpty(t, blocking, "expected a blocking violation to inspect")
				assert.Equal(t, tc.wantBlockSev, blocking[0].Severity, "blocking violation severity")
				assert.Contains(t, blocking[0].Message, tc.wantBlockMsgSub, "blocking violation message")
			}
		})
	}
}

func TestEvaluateMissingPolicyIsBlockingNotReady(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	e := NewEvaluator(fake.NewClientBuilder().WithScheme(scheme).Build())
	vs, err := e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "ghost"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	blocking := vs.Blocking()
	require.Len(t, blocking, 1)
	assert.Equal(t, "not-ready", blocking[0].Severity)
	assert.Equal(t, governance.PolicyActionEnforce, blocking[0].Action)
}

func TestEvaluateCompileErrorIsBlockingNotReady(t *testing.T) {
	p := makePolicy("bad", brokenRego, paprikav1.ConftestEnforce, 1)
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(p).Build()
	e := NewEvaluator(c)
	vs, err := e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "bad"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	blocking := vs.Blocking()
	require.Len(t, blocking, 1)
	assert.Equal(t, "not-ready", blocking[0].Severity)
}

func TestCacheRecompilesOnGenerationBump(t *testing.T) {
	p := makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1)
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(p).Build()
	e := NewEvaluator(c)
	// First eval compiles.
	_, err := e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "p"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	require.Len(t, e.cache, 1, "expected a cached entry")

	// Bump generation; the cache entry should be replaced.
	p.SetGeneration(2)
	require.NoError(t, c.Update(context.Background(), p))
	_, err = e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "p"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	require.Len(t, e.cache, 1)
	require.Equal(t, int64(2), e.cache[p.UID].generation)
}

func deploymentWithImage(name, image string) *unstructured.Unstructured {
	u := deployment(name, map[string]string{"app": "x"})
	u.Object["spec"] = map[string]interface{}{
		"template": map[string]interface{}{
			"spec": map[string]interface{}{
				"containers": []interface{}{
					map[string]interface{}{"name": "c", "image": image},
				},
			},
		},
	}
	return u
}
