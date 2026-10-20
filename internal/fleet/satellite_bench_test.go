package fleet

import (
	"fmt"
	"testing"
)

// benchSatelliteFleet builds a local snapshot plus one snapshot per satellite.
//
// sharedIdentity=true models the common case: the same application deployed to
// every cluster, which merges into one logical application with N placements.
// sharedIdentity=false models the widest case: every cluster reports its own
// application set, so the merged snapshot holds clusters×apps entries.
func benchSatelliteFleet(clusters, appsPerCluster int, sharedIdentity bool) (*Snapshot, []SatelliteSnapshot) {
	local := NewSnapshot(1)
	for i := 0; i < 20; i++ {
		central := satelliteAppFixture("checkout-control", fmt.Sprintf("central-%02d", i), HealthHealthy, 6)
		central.SatelliteOnly = false
		addApplicationMutable(local, &central)
	}

	satellites := make([]SatelliteSnapshot, clusters)
	for c := 0; c < clusters; c++ {
		satellite := satelliteFixture(fmt.Sprintf("edge-%04d", c))
		satellite.Applications = make([]ApplicationSummary, appsPerCluster)
		for a := 0; a < appsPerCluster; a++ {
			namespace := "checkout"
			name := fmt.Sprintf("app-%04d", a)
			if !sharedIdentity {
				namespace = fmt.Sprintf("team-%04d", c)
				name = fmt.Sprintf("app-%04d-%04d", c, a)
			}
			satellite.Applications[a] = satelliteAppFixture(namespace, name, HealthHealthy, 3)
		}
		satellites[c] = satellite
	}
	return local, satellites
}

// BenchmarkMergeSatelliteSnapshots measures the merge the satellite index runs
// whenever any registration's observations change. It is the control plane's
// fleet-scale hot path: every report from any cluster eventually lands here.
func BenchmarkMergeSatelliteSnapshots(b *testing.B) {
	for _, shared := range []bool{true, false} {
		for _, clusters := range []int{10, 100, 500} {
			shape := "distinct-apps"
			if shared {
				shape = "shared-app"
			}
			b.Run(fmt.Sprintf("%s/clusters=%d", shape, clusters), func(b *testing.B) {
				local, satellites := benchSatelliteFleet(clusters, 20, shared)
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					merged, err := MergeSatelliteSnapshots(local, satellites, uint64(i+2))
					if err != nil {
						b.Fatalf("merge: %v", err)
					}
					if merged == nil {
						b.Fatal("merge returned no snapshot")
					}
				}
			})
		}
	}
}

// BenchmarkQueryFleetMapAfterMerge measures a fleet-map query over a merged
// snapshot, which is what the console asks for on every page load.
func BenchmarkQueryFleetMapAfterMerge(b *testing.B) {
	local, satellites := benchSatelliteFleet(100, 20, true)
	merged, err := MergeSatelliteSnapshots(local, satellites, 2)
	if err != nil {
		b.Fatalf("merge: %v", err)
	}
	scope := QueryScope{Projects: ProjectSet{fleetID("checkout", "default"): {}, fleetID("checkout-control", "default"): {}}}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		result, queryErr := merged.QueryMap(scope, FleetMapQuery{}, nil)
		if queryErr != nil {
			b.Fatalf("query: %v", queryErr)
		}
		if len(result.Roots) == 0 {
			b.Fatal("query returned no roots")
		}
	}
}
