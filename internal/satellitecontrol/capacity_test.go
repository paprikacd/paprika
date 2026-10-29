package satellitecontrol

import (
	"encoding/json"
	"slices"
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

func TestReportPoliciesIntersectCeilingAndRetainClaim(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name                 string
		ceiling, claim, want []clusters.ManagementPolicy
	}{
		{"narrow satellite", []clusters.ManagementPolicy{clusters.ManagementPolicyObserve, clusters.ManagementPolicyApply}, []clusters.ManagementPolicy{clusters.ManagementPolicyObserve}, []clusters.ManagementPolicy{clusters.ManagementPolicyObserve}},
		{"narrow cluster", []clusters.ManagementPolicy{clusters.ManagementPolicyObserve}, []clusters.ManagementPolicy{clusters.ManagementPolicyAll}, []clusters.ManagementPolicy{clusters.ManagementPolicyObserve}},
		{"legacy omitted claim defaults full", nil, nil, paprikav1.AllManagementPolicies()},
		{"explicit empty claim", nil, []clusters.ManagementPolicy{}, []clusters.ManagementPolicy{}},
		{"explicit empty ceiling", []clusters.ManagementPolicy{}, []clusters.ManagementPolicy{clusters.ManagementPolicyAll}, []clusters.ManagementPolicy{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Exercise the real wire representation: an explicit empty claim must
			// survive transport instead of becoming an omitted/defaulted value.
			encoded, err := json.Marshal(&satellite.Report{Policies: tc.claim})
			if err != nil {
				t.Fatal(err)
			}
			var report satellite.Report
			if err := json.Unmarshal(encoded, &report); err != nil {
				t.Fatal(err)
			}
			state := &clusters.SatelliteStatus{LastSeen: &metav1.Time{Time: time.Unix(1_700_000_000, 0)}}
			cluster := &clusters.Cluster{Spec: clusters.ClusterSpec{ManagementPolicies: tc.ceiling}}
			applyReportStatus(cluster, &report, state)
			if state.ReportedPolicies == nil {
				t.Fatal("report claim was not recorded")
			}
			statusJSON, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			var persisted clusters.SatelliteStatus
			if err := json.Unmarshal(statusJSON, &persisted); err != nil {
				t.Fatal(err)
			}
			if persisted.ReportedPolicies == nil || !slices.Equal(*persisted.ReportedPolicies, *state.ReportedPolicies) {
				t.Fatalf("status round-trip lost the claim: %s", statusJSON)
			}
			if !slices.Equal(state.EffectivePolicies, tc.want) {
				t.Fatalf("effective = %v, want %v", state.EffectivePolicies, tc.want)
			}
			if !slices.Equal(*state.ReportedPolicies, paprikav1.NormalizeManagementPolicies(tc.claim)) {
				t.Fatalf("claim = %v, want %v", *state.ReportedPolicies, tc.claim)
			}
			// Copying the claim prevents a caller from changing persisted status.
			if len(report.Policies) > 0 {
				report.Policies[0] = "unexpected"
				if (*state.ReportedPolicies)[0] == "unexpected" {
					t.Fatal("claim aliases report")
				}
			}
		})
	}
}

func TestLegacyReportWithoutPoliciesKeepsDefault(t *testing.T) {
	t.Parallel()
	var report satellite.Report
	if err := json.Unmarshal([]byte(`{}`), &report); err != nil {
		t.Fatal(err)
	}
	if got := reportedPolicies(&report); !slices.Equal(got, paprikav1.DefaultManagementPolicies()) {
		t.Fatalf("legacy omitted claim = %v, want wildcard", got)
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
