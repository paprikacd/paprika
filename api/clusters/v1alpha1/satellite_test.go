package v1alpha1

import (
	"testing"
	"time"
)

func TestSatelliteTimeout(t *testing.T) {
	cluster := &Cluster{}
	if got := SatelliteTimeout(cluster); got != 90*time.Second {
		t.Fatalf("default timeout: %s", got)
	}
	cluster.Spec.ConnectionTimeout = "5m"
	if got := SatelliteTimeout(cluster); got != 5*time.Minute {
		t.Fatalf("connection timeout floor: %s", got)
	}
	cluster.Spec.HealthCheck = &HealthCheckConfig{Interval: "1000000h"}
	if got := SatelliteTimeout(cluster); got <= 0 {
		t.Fatalf("duration overflowed: %s", got)
	}
}
