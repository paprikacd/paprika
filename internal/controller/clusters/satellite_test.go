package clusters

import (
	"context"
	"slices"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/metrics"
)

func TestReconcileSatelliteFreshnessAndDisabled(t *testing.T) {
	for _, tc := range []struct {
		name     string
		age      time.Duration
		disabled bool
		reported bool
		want     clustersv1alpha1.ClusterPhase
	}{
		{"awaiting", 0, false, false, clustersv1alpha1.ClusterPhasePending},
		{"connected", time.Second, false, true, clustersv1alpha1.ClusterPhaseHealthy},
		{"disconnected", 2 * time.Minute, false, true, clustersv1alpha1.ClusterPhaseUnhealthy},
		{"disabled", time.Second, true, true, clustersv1alpha1.ClusterPhaseDisabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Name: "east", Namespace: "paprika-system"}, Spec: clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Disabled: tc.disabled, Satellite: &clustersv1alpha1.SatelliteSpec{TokenSecretRef: clustersv1alpha1.SecretRef{Name: "east-satellite-token"}}}, Status: clustersv1alpha1.ClusterStatus{Phase: clustersv1alpha1.ClusterPhaseHealthy, Inventory: &clustersv1alpha1.ClusterInventory{NodeCount: 3}, Conditions: []metav1.Condition{{Type: "Healthy", Status: metav1.ConditionTrue, Reason: "Old", LastTransitionTime: metav1.Now()}}}}
			if tc.reported {
				lastSeen := metav1.NewTime(time.Now().Add(-tc.age))
				cluster.Status.Satellite = &clustersv1alpha1.SatelliteStatus{ClusterUID: "physical-east", SessionID: "s1", Sequence: 99, LastSeen: &lastSeen, Applications: []clustersv1alpha1.SatelliteApplication{{Namespace: "shop", Name: "api"}}}
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clustersv1alpha1.Cluster{}).WithObjects(cluster).Build()
			r := &ClusterReconciler{client: c, Scheme: scheme}
			key := client.ObjectKeyFromObject(cluster)
			result, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
			if err != nil {
				t.Fatal(err)
			}
			if result.RequeueAfter <= 0 {
				t.Fatal("no heartbeat expiry requeue")
			}
			var got clustersv1alpha1.Cluster
			if err := c.Get(context.Background(), key, &got); err != nil {
				t.Fatal(err)
			}
			if got.Status.Phase != tc.want {
				t.Fatalf("phase %s want %s", got.Status.Phase, tc.want)
			}
			if !meta.IsStatusConditionTrue(got.Status.Conditions, string(tc.want)) {
				t.Fatal("active phase condition missing")
			}
			if tc.want != clustersv1alpha1.ClusterPhaseHealthy && meta.IsStatusConditionTrue(got.Status.Conditions, "Healthy") {
				t.Fatal("stale healthy condition")
			}
			if got.Status.Inventory.NodeCount != 3 {
				t.Fatal("health controller clobbered reported inventory")
			}
			if tc.reported && (got.Status.Satellite.Sequence != 99 || len(got.Status.Satellite.Applications) != 1) {
				t.Fatal("health controller clobbered reporting baseline")
			}
		})
	}
}

// TestSatelliteObservationsCoverTheRegistrationsThatMatter pins which clusters
// the freshness gauge describes: satellites, plus agent registrations that have
// not reported yet. A direct cluster has no report to be stale.
func TestSatelliteObservationsCoverTheRegistrationsThatMatter(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add scheme: %v", err)
	}
	reported := time.Now().Add(-90 * time.Second)
	satellite := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "reported", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Satellite: &clustersv1alpha1.SatelliteSpec{}},
		Status: clustersv1alpha1.ClusterStatus{Satellite: &clustersv1alpha1.SatelliteStatus{
			LastSeen:     &metav1.Time{Time: reported},
			Applications: []clustersv1alpha1.SatelliteApplication{{Name: "web"}, {Name: "api"}},
		}},
	}
	connecting := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "connecting", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Satellite: &clustersv1alpha1.SatelliteSpec{}},
	}
	direct := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "direct", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeDirect},
	}

	r := &ClusterReconciler{client: fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(satellite, connecting, direct).Build()}

	observations := r.satelliteObservations(context.Background())
	byName := make(map[string]metrics.SatelliteObservation, len(observations))
	for _, observation := range observations {
		byName[observation.Name] = observation
	}
	if _, ok := byName["direct"]; ok {
		t.Fatal("a direct cluster should not appear in satellite freshness")
	}
	reportedState, ok := byName["reported"]
	if !ok {
		t.Fatal("the reporting satellite is missing")
	}
	if !reportedState.HasReport || reportedState.ReportAgeSeconds < 60 {
		t.Fatalf("reported age = %+v, want a report roughly 90s old", reportedState)
	}
	if reportedState.Applications != 2 {
		t.Fatalf("applications = %d, want 2", reportedState.Applications)
	}
	connectingState, ok := byName["connecting"]
	if !ok {
		t.Fatal("an agent registration without a report must still be counted")
	}
	if connectingState.HasReport {
		t.Fatal("a registration that never reported must not carry an age")
	}
}

// A policy edit and a later health reconcile must never widen the latest
// satellite claim, even if the target goes quiet. Widening a previously
// narrowed Cluster ceiling must recover the original reported claim.
func TestSatellitePolicyStatusSurvivesHealthReconcileAndSpecChanges(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	claim := []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve, clustersv1alpha1.ManagementPolicyApply}
	now := metav1.Now()
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "east", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeDirect, Satellite: &clustersv1alpha1.SatelliteSpec{TokenSecretRef: clustersv1alpha1.SecretRef{Name: "token"}}, ManagementPolicies: []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve}},
		Status:     clustersv1alpha1.ClusterStatus{Satellite: &clustersv1alpha1.SatelliteStatus{ClusterUID: "target", SessionID: "session", Sequence: 1, LastSeen: &now, ReportedPolicies: &claim}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clustersv1alpha1.Cluster{}).WithObjects(cluster).Build()
	r := &ClusterReconciler{client: c, Scheme: scheme}
	key := client.ObjectKeyFromObject(cluster)
	reconcile := func(want []clustersv1alpha1.ManagementPolicy) {
		t.Helper()
		if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err != nil {
			t.Fatal(err)
		}
		var got clustersv1alpha1.Cluster
		if err := c.Get(context.Background(), key, &got); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(got.Status.Satellite.EffectivePolicies, want) {
			t.Fatalf("effective = %v, want %v", got.Status.Satellite.EffectivePolicies, want)
		}
		if got.Status.Satellite.ReportedPolicies == nil || !slices.Equal(*got.Status.Satellite.ReportedPolicies, claim) {
			t.Fatalf("claim changed: %v", got.Status.Satellite.ReportedPolicies)
		}
	}
	reconcile([]clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve})
	var updated clustersv1alpha1.Cluster
	if err := c.Get(context.Background(), key, &updated); err != nil {
		t.Fatal(err)
	}
	updated.Spec.ManagementPolicies = []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyAll}
	if err := c.Update(context.Background(), &updated); err != nil {
		t.Fatal(err)
	}
	reconcile(claim)
}

func TestSatellitePolicyStatusDoesNotGuessMissingClaim(t *testing.T) {
	t.Parallel()
	cluster := &clustersv1alpha1.Cluster{Status: clustersv1alpha1.ClusterStatus{Satellite: &clustersv1alpha1.SatelliteStatus{EffectivePolicies: []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyApply}}}}
	applySatelliteStatus(cluster)
	if cluster.Status.Satellite.EffectivePolicies != nil {
		t.Fatalf("missing claim produced policies %v", cluster.Status.Satellite.EffectivePolicies)
	}
}
