package v1alpha1

import "time"

// SatelliteTimeout allows three normal health-check intervals before an
// outbound observation is stale, with connectionTimeout as a lower bound.
func SatelliteTimeout(cluster *Cluster) time.Duration {
	interval := 30 * time.Second
	if cluster.Spec.HealthCheck != nil {
		if d, err := time.ParseDuration(cluster.Spec.HealthCheck.Interval); err == nil && d > 0 {
			interval = d
		}
	}
	// Saturate instead of overflowing for very large valid Go durations.
	timeout := time.Duration(1<<63 - 1)
	if interval <= timeout/3 {
		timeout = 3 * interval
	}
	if d, err := time.ParseDuration(cluster.Spec.ConnectionTimeout); err == nil && d > timeout {
		timeout = d
	}
	return timeout
}
