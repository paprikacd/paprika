package apiserver

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestManagementPolicyStringsExpandsTheWildcard(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		policies []pipelinesv1alpha1.ManagementPolicy
		want     []string
	}{
		{
			name: "unset means every policy, spelt out",
			want: []string{"Observe", "Apply", "Prune", "Delete", "SelfHeal", "Rollout"},
		},
		{
			name:     "a concrete list passes through",
			policies: []pipelinesv1alpha1.ManagementPolicy{pipelinesv1alpha1.ManagementPolicyObserve},
			want:     []string{"Observe"},
		},
		{
			name:     "an empty list reports nothing",
			policies: pipelinesv1alpha1.ManagementPolicySet{},
			want:     []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cluster := &clustersv1alpha1.Cluster{
				Spec: clustersv1alpha1.ClusterSpec{ManagementPolicies: tt.policies},
			}
			got := managementPolicyStrings(cluster)
			if len(got) != len(tt.want) {
				t.Fatalf("policies = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("policies = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

func TestSatelliteStatusMessage(t *testing.T) {
	t.Parallel()

	if got := satelliteStatusMessage(nil); got != nil {
		t.Fatalf("a cluster with no satellite must project nil, got %#v", got)
	}

	seen := metav1.NewTime(time.Unix(1_700_000_000, 0))
	state := &clustersv1alpha1.SatelliteStatus{
		OperatingState:    clustersv1alpha1.SatelliteOperatingAutonomous,
		AutonomousSince:   &seen,
		LastSeen:          &seen,
		ActiveOverrides:   2,
		EffectivePolicies: []pipelinesv1alpha1.ManagementPolicy{pipelinesv1alpha1.ManagementPolicyObserve},
	}

	message := satelliteStatusMessage(state)
	if message == nil {
		t.Fatal("satellite state projected to nil")
	}
	if message.OperatingState != "Autonomous" {
		t.Errorf("operating state = %q", message.OperatingState)
	}
	if message.LastSeenUnixMs != seen.UnixMilli() || message.AutonomousSinceUnixMs != seen.UnixMilli() {
		t.Errorf("timestamps = %d/%d, want %d", message.LastSeenUnixMs, message.AutonomousSinceUnixMs, seen.UnixMilli())
	}
	if message.ActiveOverrides != 2 {
		t.Errorf("active overrides = %d, want 2", message.ActiveOverrides)
	}
	if len(message.EffectivePolicies) != 1 || message.EffectivePolicies[0] != "Observe" {
		t.Errorf("effective policies = %v", message.EffectivePolicies)
	}
}

func TestClusterMessageCarriesPoliciesAndSatellite(t *testing.T) {
	t.Parallel()

	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "paprika-system"},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:               clustersv1alpha1.ClusterModeAgent,
			ManagementPolicies: []pipelinesv1alpha1.ManagementPolicy{pipelinesv1alpha1.ManagementPolicyObserve},
		},
		Status: clustersv1alpha1.ClusterStatus{
			Satellite: &clustersv1alpha1.SatelliteStatus{
				OperatingState: clustersv1alpha1.SatelliteOperatingConnected,
			},
		},
	}

	message := clusterMessage(cluster, fleet.ClusterSummary{}, clusterReferences{})

	if len(message.ManagementPolicies) != 1 || message.ManagementPolicies[0] != "Observe" {
		t.Errorf("management policies = %v", message.ManagementPolicies)
	}
	if message.Satellite == nil || message.Satellite.OperatingState != "Connected" {
		t.Errorf("satellite = %#v", message.Satellite)
	}
}

func TestClusterMessageOmitsSatelliteWhenAbsent(t *testing.T) {
	t.Parallel()

	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "local", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeInCluster},
	}

	message := clusterMessage(cluster, fleet.ClusterSummary{}, clusterReferences{})

	if message.Satellite != nil {
		t.Errorf("a cluster with no satellite must not project one: %#v", message.Satellite)
	}
	if len(message.ManagementPolicies) == 0 {
		t.Error("an unset ceiling must project the full policy list")
	}
}
