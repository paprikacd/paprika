package satellitecontrol

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/satellite"
)

func TestApplyReportStatusStoresCapacityAndPools(t *testing.T) {
	t.Parallel()

	report := &satellite.Report{
		Capacity: clusters.SatelliteCapacity{
			CPUMillicores: clusters.SatelliteResourceUsage{Used: 1500, Requested: 2000, Allocatable: 4000, UsedKnown: true},
			MemoryBytes:   clusters.SatelliteResourceUsage{Used: 1 << 30, Requested: 2 << 30, Allocatable: 8 << 30, UsedKnown: true},
		},
		ProviderType: "vultr",
		NodePools:    []clusters.ClusterNodePool{{Name: "general", NodeCount: 2, AllocatableCPUMillis: 4000}},
	}
	state := &clusters.SatelliteStatus{LastSeen: &metav1.Time{Time: time.Unix(1_700_000_000, 0)}}
	cluster := &clusters.Cluster{}

	applyReportStatus(cluster, report, state)

	capacity := cluster.Status.Satellite.Capacity
	if capacity == nil {
		t.Fatal("capacity was not recorded")
	}
	if capacity.CPUMillicores.Used != 1500 || !capacity.CPUMillicores.UsedKnown {
		t.Errorf("cpu usage = %#v", capacity.CPUMillicores)
	}
	if capacity.ObservedAt == nil || !capacity.ObservedAt.Equal(state.LastSeen) {
		t.Errorf("capacity observation time = %v, want the report's arrival time", capacity.ObservedAt)
	}
	if got := cluster.Status.Satellite.ProviderType; got != "vultr" {
		t.Errorf("provider type = %q, want vultr", got)
	}
	if len(cluster.Status.Satellite.NodePools) != 1 || cluster.Status.Satellite.NodePools[0].Name != "general" {
		t.Errorf("node pools = %#v", cluster.Status.Satellite.NodePools)
	}
}

func TestApplyReportStatusCapacityIsIndependentOfTheReport(t *testing.T) {
	t.Parallel()

	report := &satellite.Report{
		Capacity:  clusters.SatelliteCapacity{CPUMillicores: clusters.SatelliteResourceUsage{Allocatable: 4000}},
		NodePools: []clusters.ClusterNodePool{{Name: "general", NodeCount: 1}},
	}
	state := &clusters.SatelliteStatus{LastSeen: &metav1.Time{Time: time.Unix(1_700_000_000, 0)}}
	cluster := &clusters.Cluster{}

	applyReportStatus(cluster, report, state)

	// The retry loop reuses the decoded report on a conflict, so status must own
	// its copy rather than alias the report's slices.
	report.Capacity.CPUMillicores.Allocatable = 9999
	report.NodePools[0].NodeCount = 42

	if got := cluster.Status.Satellite.Capacity.CPUMillicores.Allocatable; got != 4000 {
		t.Errorf("capacity aliases the report: allocatable = %d", got)
	}
	if got := cluster.Status.Satellite.NodePools[0].NodeCount; got != 1 {
		t.Errorf("node pools alias the report: count = %d", got)
	}
}

func TestReportedPoliciesPrefersTheClusterCeiling(t *testing.T) {
	t.Parallel()

	report := &satellite.Report{Policies: []clusters.ManagementPolicy{clusters.ManagementPolicyAll}}
	withCeiling := &clusters.Cluster{Spec: clusters.ClusterSpec{
		ManagementPolicies: []clusters.ManagementPolicy{clusters.ManagementPolicyObserve},
	}}
	if got := reportedPolicies(withCeiling, report); len(got) != 1 || got[0] != clusters.ManagementPolicyObserve {
		t.Errorf("cluster ceiling was not authoritative: %v", got)
	}

	silent := &clusters.Cluster{}
	if got := reportedPolicies(silent, report); len(got) != len(paprikav1.AllManagementPolicies()) {
		t.Errorf("a satellite's own claim must fill in when the spec is silent: %v", got)
	}

	skip := &clusters.Cluster{Spec: clusters.ClusterSpec{ManagementPolicies: paprikav1.ManagementPolicySet{}}}
	if got := reportedPolicies(skip, report); len(got) != 0 {
		t.Errorf("an explicitly empty ceiling must record nothing, got %v", got)
	}
}

func TestReportedOperatingState(t *testing.T) {
	t.Parallel()

	report := &satellite.Report{OperatingState: clusters.SatelliteOperatingAutonomous}
	if got := reportedOperatingState(&clusters.Cluster{}, report); got != clusters.SatelliteOperatingAutonomous {
		t.Errorf("reported state = %q, want the satellite's own", got)
	}
	disabled := &clusters.Cluster{Spec: clusters.ClusterSpec{Disabled: true}}
	if got := reportedOperatingState(disabled, report); got != clusters.SatelliteOperatingDisabled {
		t.Errorf("disabled cluster state = %q, want Disabled", got)
	}
	if got := reportedOperatingState(&clusters.Cluster{}, &satellite.Report{}); got != "" {
		t.Errorf("an unreported state must stay empty, got %q", got)
	}
}

func TestValidateReportAcceptsCapacityAndRejectsNegatives(t *testing.T) {
	t.Parallel()

	base := func() *satellite.Report {
		return &satellite.Report{
			ProtocolVersion:  satellite.ProtocolVersion,
			ClusterNamespace: "paprika-system",
			ClusterName:      "edge",
			ClusterUID:       "uid",
			SessionID:        "session",
			Sequence:         1,
			Snapshot:         true,
			ObservedAt:       time.Unix(1_700_000_000, 0),
			Inventory: clusters.ClusterInventory{
				NodeCount: 1, ReadyNodeCount: 1, PodCount: 1, RunningPodCount: 1, NamespaceCount: 1,
			},
		}
	}

	valid := base()
	valid.Capacity = clusters.SatelliteCapacity{
		CPUMillicores: clusters.SatelliteResourceUsage{Used: 1000, Requested: 2000, Allocatable: 4000, UsedKnown: true},
	}
	valid.NodePools = []clusters.ClusterNodePool{{Name: "general", NodeCount: 1}}
	valid.Policies = []clusters.ManagementPolicy{clusters.ManagementPolicyObserve}
	valid.Autonomy = clusters.AutonomyDelegated
	valid.OperatingState = clusters.SatelliteOperatingAutonomous
	if err := validateReport(valid); err != nil {
		t.Fatalf("a report with capacity, pools and policies was rejected: %v", err)
	}

	negative := base()
	negative.Capacity = clusters.SatelliteCapacity{
		CPUMillicores: clusters.SatelliteResourceUsage{Used: -1},
	}
	if err := validateReport(negative); err == nil {
		t.Error("a negative usage figure was accepted")
	}

	badPool := base()
	badPool.NodePools = []clusters.ClusterNodePool{{Name: "Not A Pool", NodeCount: 1}}
	if err := validateReport(badPool); err == nil {
		t.Error("an invalid pool name was accepted")
	}

	badPolicy := base()
	badPolicy.Policies = []clusters.ManagementPolicy{"Destroy"}
	if err := validateReport(badPolicy); err == nil {
		t.Error("an unknown management policy was accepted")
	}

	badAutonomy := base()
	badAutonomy.Autonomy = "Rogue"
	if err := validateReport(badAutonomy); err == nil {
		t.Error("an unknown autonomy mode was accepted")
	}

	badState := base()
	badState.OperatingState = "Confused"
	if err := validateReport(badState); err == nil {
		t.Error("an unknown operating state was accepted")
	}
}
