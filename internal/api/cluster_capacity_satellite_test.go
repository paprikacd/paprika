package apiserver

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func satelliteCluster(name string, mode clustersv1alpha1.ClusterMode, capacity *clustersv1alpha1.SatelliteCapacity) *clustersv1alpha1.Cluster {
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: mode},
	}
	if capacity != nil {
		cluster.Status.Satellite = &clustersv1alpha1.SatelliteStatus{Capacity: capacity}
	}
	return cluster
}

func satelliteScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add clusters scheme: %v", err)
	}
	return scheme
}

func TestSatelliteCapacityServesMeasuredMeters(t *testing.T) {
	t.Parallel()

	// metav1.Time round-trips through RFC 3339 at second precision, which is also
	// the resolution the meter's age is useful at.
	observed := metav1.NewTime(time.Unix(1_700_000_000, 0))
	capacity := &clustersv1alpha1.SatelliteCapacity{
		CPUMillicores: clustersv1alpha1.SatelliteResourceUsage{
			Used: 1500, Requested: 2000, Allocatable: 4000, UsedKnown: true,
		},
		MemoryBytes: clustersv1alpha1.SatelliteResourceUsage{
			Used: 2 << 30, Requested: 3 << 30, Allocatable: 8 << 30, UsedKnown: true,
		},
		ObservedAt: &observed,
	}
	server := &PaprikaServer{client: fake.NewClientBuilder().
		WithScheme(satelliteScheme(t)).
		WithObjects(satelliteCluster("edge", clustersv1alpha1.ClusterModeAgent, capacity)).
		Build()}

	meters := server.clusterCapacity(context.Background(), "paprika-system", "edge")

	if meters.UsageProvider != satelliteUsageProvider {
		t.Errorf("usage provider = %q, want %q", meters.UsageProvider, satelliteUsageProvider)
	}
	assertMeter(t, "cpu", meters.Cpu, 1500, 2000, 4000, true)
	assertMeter(t, "memory", meters.Memory, 2<<30, 3<<30, 8<<30, true)
	if meters.Cpu.ObservedAtUnixMs != observed.UnixMilli() {
		t.Errorf("observed at = %d, want %d", meters.Cpu.ObservedAtUnixMs, observed.UnixMilli())
	}
}

func TestSatelliteCapacityReportsUnknownUsageWithoutMetrics(t *testing.T) {
	t.Parallel()

	capacity := &clustersv1alpha1.SatelliteCapacity{
		CPUMillicores: clustersv1alpha1.SatelliteResourceUsage{Requested: 1000, Allocatable: 2000},
		MemoryBytes:   clustersv1alpha1.SatelliteResourceUsage{Requested: 1 << 30, Allocatable: 4 << 30},
	}
	server := &PaprikaServer{client: fake.NewClientBuilder().
		WithScheme(satelliteScheme(t)).
		WithObjects(satelliteCluster("edge", clustersv1alpha1.ClusterModeAgent, capacity)).
		Build()}

	meters := server.clusterCapacity(context.Background(), "paprika-system", "edge")

	assertMeter(t, "cpu", meters.Cpu, 0, 1000, 2000, false)
	assertMeter(t, "memory", meters.Memory, 0, 1<<30, 4<<30, false)
	if meters.Cpu.UnavailableReason != satelliteUsedUnavailableReason {
		t.Errorf("unavailable reason = %q", meters.Cpu.UnavailableReason)
	}
	if meters.Cpu.ObservedAtUnixMs != 0 {
		t.Errorf("observed at = %d, want 0 when nothing was measured", meters.Cpu.ObservedAtUnixMs)
	}
}

func TestSatelliteCapacityIsNotUsedForDialableClusters(t *testing.T) {
	t.Parallel()

	capacity := &clustersv1alpha1.SatelliteCapacity{
		CPUMillicores: clustersv1alpha1.SatelliteResourceUsage{Used: 1500, Allocatable: 4000, UsedKnown: true},
	}
	// A direct cluster has a live API the control plane reads itself; the
	// satellite's heartbeat-old figure must not win over it.
	server := &PaprikaServer{client: fake.NewClientBuilder().
		WithScheme(satelliteScheme(t)).
		WithObjects(satelliteCluster("edge", clustersv1alpha1.ClusterModeDirect, capacity)).
		Build()}

	if meters := server.satelliteReportedCapacity(context.Background(), "paprika-system", "edge"); meters != nil {
		t.Fatalf("a direct cluster must fall through to the live read, got %#v", meters)
	}
}

func TestSatelliteCapacityAbsentForUnreportedCluster(t *testing.T) {
	t.Parallel()

	server := &PaprikaServer{client: fake.NewClientBuilder().
		WithScheme(satelliteScheme(t)).
		WithObjects(satelliteCluster("edge", clustersv1alpha1.ClusterModeAgent, nil)).
		Build()}

	if meters := server.satelliteReportedCapacity(context.Background(), "paprika-system", "edge"); meters != nil {
		t.Fatalf("a cluster with no satellite report must not answer with meters, got %#v", meters)
	}
}

// assertMeter checks one meter's three figures and its usage state.
func assertMeter(t *testing.T, label string, meter *paprikav1.ResourceMeter, used, requested, allocatable float64, usedKnown bool) {
	t.Helper()
	if meter == nil {
		t.Fatalf("%s meter is nil", label)
	}
	if meter.Requested != requested || meter.RequestedState != paprikav1.DataState_DATA_STATE_OK {
		t.Errorf("%s requested = %v (state %v), want %v OK", label, meter.Requested, meter.RequestedState, requested)
	}
	if meter.Allocatable != allocatable || meter.AllocatableState != paprikav1.DataState_DATA_STATE_OK {
		t.Errorf("%s allocatable = %v (state %v), want %v OK", label, meter.Allocatable, meter.AllocatableState, allocatable)
	}
	if usedKnown {
		if meter.Used != used || meter.UsedState != paprikav1.DataState_DATA_STATE_OK {
			t.Errorf("%s used = %v (state %v), want %v OK", label, meter.Used, meter.UsedState, used)
		}
		return
	}
	if meter.Used != 0 || meter.UsedState != paprikav1.DataState_DATA_STATE_NOT_CONFIGURED {
		t.Errorf("%s used = %v (state %v), want 0 NOT_CONFIGURED", label, meter.Used, meter.UsedState)
	}
}
