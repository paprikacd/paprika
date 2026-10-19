package pipelines

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func policyTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add clusters scheme: %v", err)
	}
	if err := paprikav1.AddToScheme(scheme); err != nil {
		t.Fatalf("add pipelines scheme: %v", err)
	}
	return scheme
}

func policyTestCluster(name, namespace string, mode paprikav1.ClusterMode, policies []paprikav1.ManagementPolicy) *clustersv1alpha1.Cluster {
	return &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:               mode,
			ManagementPolicies: policies,
		},
	}
}

func TestResolveStagePolicies(t *testing.T) {
	t.Parallel()

	const operatorNamespace = "paprika-system"
	observeOnly := []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve}

	tests := []struct {
		name      string
		objects   []*clustersv1alpha1.Cluster
		ref       paprikav1.ClusterRef
		requested []paprikav1.ManagementPolicy
		want      []paprikav1.ManagementPolicy
	}{
		{
			name: "unregistered named target keeps full management",
			ref:  paprikav1.ClusterRef{Name: "edge", Namespace: operatorNamespace},
			want: paprikav1.AllManagementPolicies(),
		},
		{
			name:    "cluster ceiling narrows an unset stage request",
			objects: []*clustersv1alpha1.Cluster{policyTestCluster("edge", operatorNamespace, paprikav1.ClusterModeDirect, observeOnly)},
			ref:     paprikav1.ClusterRef{Name: "edge", Namespace: operatorNamespace},
			want:    observeOnly,
		},
		{
			name:      "stage request narrows an unrestricted cluster",
			objects:   []*clustersv1alpha1.Cluster{policyTestCluster("edge", operatorNamespace, paprikav1.ClusterModeDirect, nil)},
			ref:       paprikav1.ClusterRef{Name: "edge", Namespace: operatorNamespace},
			requested: []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve, paprikav1.ManagementPolicyApply},
			want:      []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve, paprikav1.ManagementPolicyApply},
		},
		{
			name:      "a stage cannot widen the cluster ceiling",
			objects:   []*clustersv1alpha1.Cluster{policyTestCluster("edge", operatorNamespace, paprikav1.ClusterModeDirect, observeOnly)},
			ref:       paprikav1.ClusterRef{Name: "edge", Namespace: operatorNamespace},
			requested: paprikav1.AllManagementPolicies(),
			want:      observeOnly,
		},
		{
			name:      "an explicitly empty stage request observes through an unrestricted cluster",
			objects:   []*clustersv1alpha1.Cluster{policyTestCluster("edge", operatorNamespace, paprikav1.ClusterModeDirect, nil)},
			ref:       paprikav1.ClusterRef{Name: "edge", Namespace: operatorNamespace},
			requested: paprikav1.ManagementPolicySet{},
			want:      []paprikav1.ManagementPolicy{},
		},
		{
			name:    "empty cluster ref reads the in-cluster registration",
			objects: []*clustersv1alpha1.Cluster{policyTestCluster("paprika-in-cluster", operatorNamespace, paprikav1.ClusterModeInCluster, observeOnly)},
			ref:     paprikav1.ClusterRef{},
			want:    observeOnly,
		},
		{
			name:    "another namespace's in-cluster registration is not this cluster",
			objects: []*clustersv1alpha1.Cluster{policyTestCluster("other-in-cluster", "tenant-a", paprikav1.ClusterModeInCluster, observeOnly)},
			ref:     paprikav1.ClusterRef{},
			want:    paprikav1.AllManagementPolicies(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			builder := fake.NewClientBuilder().WithScheme(policyTestScheme(t))
			for _, object := range tt.objects {
				builder = builder.WithObjects(object)
			}
			stage := &paprikav1.Stage{
				ObjectMeta: metav1.ObjectMeta{Name: "app-dev", Namespace: "tenant-a"},
				Spec: paprikav1.StageSpec{
					Cluster:            tt.ref,
					ManagementPolicies: tt.requested,
				},
			}
			got, err := resolveStagePolicies(context.Background(), builder.Build(), operatorNamespace, stage, "tenant-a")
			if err != nil {
				t.Fatalf("resolveStagePolicies: %v", err)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("policies = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestResolveStagePoliciesFailsClosedOnReadError(t *testing.T) {
	t.Parallel()

	// A read that fails for any reason other than "no such registration" must
	// surface, not degrade to full management: applying writes on the strength of
	// a failed policy read is the one failure mode an observe-only cluster cannot
	// tolerate.
	reader := fake.NewClientBuilder().
		WithScheme(policyTestScheme(t)).
		WithInterceptorFuncs(interceptor.Funcs{
			Get: func(context.Context, client.WithWatch, client.ObjectKey, client.Object, ...client.GetOption) error {
				return errors.New("apiserver unavailable")
			},
		}).
		Build()
	stage := &paprikav1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "app-dev", Namespace: "tenant-a"},
		Spec:       paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"}},
	}

	_, err := resolveStagePolicies(context.Background(), reader, "paprika-system", stage, "tenant-a")
	if err == nil {
		t.Fatal("a failed policy read must be reported, not treated as an absent ceiling")
	}
	if errors.Is(err, ErrManagementPolicyWithheld) {
		t.Fatalf("a read failure is not a policy refusal: %v", err)
	}
}

func TestResolveStagePoliciesWithoutClusterType(t *testing.T) {
	t.Parallel()

	// A manager that does not know the Cluster type has no ceiling to read. That
	// is the same fact as an unregistered target, so the stage's own request
	// stands — production managers always register the type, and treating a
	// missing registration as an empty ceiling would make every fixture in this
	// package observe-only.
	reader := fake.NewClientBuilder().WithScheme(runtime.NewScheme()).Build()
	stage := &paprikav1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "app-dev", Namespace: "tenant-a"},
		Spec: paprikav1.StageSpec{
			Cluster:            paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"},
			ManagementPolicies: []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve},
		},
	}

	got, err := resolveStagePolicies(context.Background(), reader, "paprika-system", stage, "tenant-a")
	if err != nil {
		t.Fatalf("resolveStagePolicies: %v", err)
	}
	if !slices.Equal(got, []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve}) {
		t.Fatalf("policies = %v, want the stage's own observe-only request", got)
	}
}

func TestPolicySetRefusalNamesActionAndTarget(t *testing.T) {
	t.Parallel()

	set := policySet{
		policies: []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve},
		target:   "paprika-system/edge",
	}
	err := set.refusal(paprikav1.ManagementPolicyApply)
	if !errors.Is(err, ErrManagementPolicyWithheld) {
		t.Fatalf("refusal must wrap ErrManagementPolicyWithheld, got %v", err)
	}
	for _, want := range []string{"Apply", "paprika-system/edge", "Observe"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not mention %q", err.Error(), want)
		}
	}
}

func TestPolicySetAllowsRespectsWithheldActions(t *testing.T) {
	t.Parallel()

	set := policySet{policies: []paprikav1.ManagementPolicy{
		paprikav1.ManagementPolicyObserve, paprikav1.ManagementPolicyApply,
	}}
	if !set.allows(paprikav1.ManagementPolicyApply) {
		t.Error("Apply was granted")
	}
	for _, withheld := range []paprikav1.ManagementPolicy{
		paprikav1.ManagementPolicyPrune,
		paprikav1.ManagementPolicyDelete,
		paprikav1.ManagementPolicyRollout,
		paprikav1.ManagementPolicySelfHeal,
	} {
		if set.allows(withheld) {
			t.Errorf("%s was withheld but reported as granted", withheld)
		}
	}
}

func TestRolloutPolicyErrorOnlyGatesProgressiveStages(t *testing.T) {
	t.Parallel()

	observeOnly := []paprikav1.ManagementPolicy{paprikav1.ManagementPolicyObserve}
	builder := fake.NewClientBuilder().
		WithScheme(policyTestScheme(t)).
		WithObjects(policyTestCluster("edge", "paprika-system", paprikav1.ClusterModeDirect, observeOnly))
	r := &ReleaseReconciler{client: builder.Build(), Namespace: "paprika-system"}

	rolling := &paprikav1.Stage{Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"}}}
	if err := r.rolloutPolicyError(context.Background(), rolling, "tenant-a"); err != nil {
		t.Fatalf("a plain rolling stage shifts no traffic and must not need Rollout: %v", err)
	}

	canary := &paprikav1.Stage{Spec: paprikav1.StageSpec{
		Cluster: paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"},
		Canary:  &paprikav1.CanaryConfig{Steps: []int{10, 100}},
	}}
	err := r.rolloutPolicyError(context.Background(), canary, "tenant-a")
	if !errors.Is(err, ErrManagementPolicyWithheld) {
		t.Fatalf("a canary stage on an observe-only cluster must be refused, got %v", err)
	}
}

func TestStageTargetName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		ref  paprikav1.ClusterRef
		want string
	}{
		{"empty ref is in-cluster", paprikav1.ClusterRef{}, "the in-cluster target"},
		{"named without namespace", paprikav1.ClusterRef{Name: "edge"}, "edge"},
		{"named with namespace", paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"}, "paprika-system/edge"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := stageTargetName(&tt.ref, "stage"); got != tt.want {
				t.Errorf("stageTargetName = %q, want %q", got, tt.want)
			}
		})
	}
}
