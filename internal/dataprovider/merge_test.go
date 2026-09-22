package dataprovider

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
)

func TestMergeCombinesComplementaryProviders(t *testing.T) {
	t.Parallel()
	structural := CapacityReading{CPUMillicores: Meter{
		Allocatable: Sample{Value: 6000, State: StateOK},
		Requested:   Sample{Value: 750, State: StateOK},
		Used:        Sample{State: StateNotConfigured},
	}}
	usage := CapacityReading{CPUMillicores: Meter{
		Used: Sample{Value: 2000, State: StateOK},
	}}

	got := Merge(structural, usage)
	require.Equal(t, StateOK, got.CPUMillicores.Allocatable.State)
	require.InDelta(t, 6000, got.CPUMillicores.Allocatable.Value, 0.001)
	require.Equal(t, StateOK, got.CPUMillicores.Used.State)
	require.InDelta(t, 2000, got.CPUMillicores.Used.Value, 0.001)
}

func TestMergeNeverLetsAnAbsentFieldOverwriteARealOne(t *testing.T) {
	t.Parallel()
	measured := CapacityReading{CPUMillicores: Meter{Used: Sample{Value: 2000, State: StateOK}}}
	absent := CapacityReading{CPUMillicores: Meter{Used: Sample{State: StateNotAvailable}}}
	got := Merge(measured, absent)
	require.Equal(t, StateOK, got.CPUMillicores.Used.State)
	require.InDelta(t, 2000, got.CPUMillicores.Used.Value, 0.001)
}

func TestMergeMergesEveryDimension(t *testing.T) {
	t.Parallel()
	structural := CapacityReading{
		CPUMillicores: Meter{Allocatable: Sample{Value: 6000, State: StateOK}},
		MemoryBytes:   Meter{Allocatable: Sample{Value: 32 << 30, State: StateOK}},
	}
	usage := CapacityReading{
		CPUMillicores: Meter{Used: Sample{Value: 2000, State: StateOK}},
		MemoryBytes:   Meter{Used: Sample{Value: 8 << 30, State: StateOK}},
	}

	got := Merge(structural, usage)
	require.Equal(t, StateOK, got.MemoryBytes.Allocatable.State)
	require.InDelta(t, 32<<30, got.MemoryBytes.Allocatable.Value, 0.001)
	require.Equal(t, StateOK, got.MemoryBytes.Used.State)
	require.InDelta(t, 8<<30, got.MemoryBytes.Used.Value, 0.001)
}

func TestMergeReplacesALessInformativeNonOKState(t *testing.T) {
	t.Parallel()
	// KubernetesCapacity reports Used as NOT_CONFIGURED because it cannot ever
	// measure it; a bound MetricsServer that finds no metrics.k8s.io reports
	// NOT_AVAILABLE, which is the more accurate account of the same field.
	structural := CapacityReading{CPUMillicores: Meter{
		Used: Sample{State: StateNotConfigured, Reason: "no usage source is bound"},
	}}
	usage := CapacityReading{CPUMillicores: Meter{
		Used: Sample{State: StateNotAvailable, Reason: "metrics-server is not installed"},
	}}

	got := Merge(structural, usage)
	require.Equal(t, StateNotAvailable, got.CPUMillicores.Used.State)
	require.Equal(t, "metrics-server is not installed", got.CPUMillicores.Used.Reason)
}

func TestMergeKeepsAStatedFieldRatherThanAnUnsetOne(t *testing.T) {
	t.Parallel()
	// A reading that says nothing at all about a field (the zero Sample, whose
	// state is the reserved unspecified value) must not erase a field an
	// earlier reading gave a real account of — otherwise a single-field
	// provider would blank every field it does not measure.
	stated := CapacityReading{CPUMillicores: Meter{
		Requested: Sample{State: StateForbidden, Reason: "not permitted to list pods"},
	}}
	silent := CapacityReading{}

	got := Merge(stated, silent)
	require.Equal(t, StateForbidden, got.CPUMillicores.Requested.State)
	require.Equal(t, "not permitted to list pods", got.CPUMillicores.Requested.Reason)
}

func TestMergeReportsTheOldestContributingObservation(t *testing.T) {
	t.Parallel()
	older := time.Date(2026, 9, 10, 10, 0, 0, 0, time.UTC)
	newer := older.Add(time.Minute)
	structural := CapacityReading{CPUMillicores: Meter{
		Allocatable: Sample{Value: 6000, State: StateOK},
		ObservedAt:  older,
	}}
	usage := CapacityReading{CPUMillicores: Meter{
		Used:       Sample{Value: 2000, State: StateOK},
		ObservedAt: newer,
	}}

	// A meter assembled from two reads is only as fresh as its stalest part,
	// so the merged observation time is the older of the two contributors.
	got := Merge(structural, usage)
	require.Equal(t, older, got.CPUMillicores.ObservedAt)
}

func TestMergeIgnoresTheObservationTimeOfANonContributor(t *testing.T) {
	t.Parallel()
	observed := time.Date(2026, 9, 10, 10, 0, 0, 0, time.UTC)
	contributor := CapacityReading{CPUMillicores: Meter{
		Used:       Sample{Value: 2000, State: StateOK},
		ObservedAt: observed,
	}}
	// Read at some other time, but every sample failed: its clock says nothing
	// about how fresh the merged meter is.
	failed := CapacityReading{CPUMillicores: Meter{
		Used:       Sample{State: StateError},
		ObservedAt: observed.Add(-time.Hour),
	}}

	require.Equal(t, observed, Merge(contributor, failed).CPUMillicores.ObservedAt)
	require.Equal(t, observed, Merge(failed, contributor).CPUMillicores.ObservedAt)
}

func TestMergeOfNothingIsTheZeroReading(t *testing.T) {
	t.Parallel()
	require.Equal(t, CapacityReading{}, Merge())
}

func TestResolveAllReturnsOneWinnerPerProvider(t *testing.T) {
	t.Parallel()
	scope := Scope{Namespace: "tenant", Cluster: "eu-west-1", Project: "payments"}
	bindings := []Binding{
		{ProviderName: "structural", ScopeKind: v1alpha1.ScopeGlobal},
		{ProviderName: "structural", ScopeKind: v1alpha1.ScopeCluster, ScopeName: "eu-west-1"},
		{ProviderName: "usage", ScopeKind: v1alpha1.ScopeGlobal},
	}

	got := ResolveAll(scope, bindings)
	require.Len(t, got, 2, "each provider composes into the meter, so each resolves independently")
	require.Equal(t, "structural", got[0].ProviderName)
	require.Equal(t, v1alpha1.ScopeCluster, got[0].ScopeKind,
		"the most specific binding wins within one provider")
	require.Equal(t, "usage", got[1].ProviderName)
	require.Equal(t, v1alpha1.ScopeGlobal, got[1].ScopeKind)
}

func TestResolveAllDropsProvidersNoBindingScopesIn(t *testing.T) {
	t.Parallel()
	scope := Scope{Namespace: "tenant"}
	bindings := []Binding{
		{ProviderName: "elsewhere", ScopeKind: v1alpha1.ScopeNamespace, ScopeName: "other"},
		{ProviderName: "here", ScopeKind: v1alpha1.ScopeNamespace, ScopeName: "tenant"},
	}

	got := ResolveAll(scope, bindings)
	require.Len(t, got, 1)
	require.Equal(t, "here", got[0].ProviderName)
}

func TestResolveAllIsDeterministic(t *testing.T) {
	t.Parallel()
	scope := Scope{Cluster: "eu-west-1"}
	bindings := []Binding{
		{ProviderName: "usage", ScopeKind: v1alpha1.ScopeGlobal},
		{ProviderName: "structural", ScopeKind: v1alpha1.ScopeGlobal},
		{ProviderName: "cost", ScopeKind: v1alpha1.ScopeGlobal},
	}

	// Read order decides which provider wins a field two providers both
	// report, so it cannot depend on map iteration order.
	for range 8 {
		got := ResolveAll(scope, bindings)
		require.Len(t, got, 3)
		require.Equal(t, []string{"cost", "structural", "usage"},
			[]string{got[0].ProviderName, got[1].ProviderName, got[2].ProviderName})
	}
}

func TestResolveAllOfNothingIsEmpty(t *testing.T) {
	t.Parallel()
	require.Empty(t, ResolveAll(Scope{Namespace: "tenant"}, nil))
}
