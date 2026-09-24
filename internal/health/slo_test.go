package health

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func sloCheck() api.HealthCheck {
	return api.HealthCheck{Name: "uptime", Interval: "30s", Expression: "http.statusCode == 200", HTTPProbe: &api.HTTPProbe{URL: "http://frontend.sfh.svc/deepcheck", Timeout: 5}, SLO: &api.AvailabilitySLO{TargetPercentage: 99, Window: "1h"}}
}

func TestSLOCollectsActualObservationsAndKeepsMissingTimeUnknown(t *testing.T) {
	c := sloCheck()
	now := time.Unix(1800000000, 0).UTC()
	h := RecordSLO(c, nil, api.HealthHealthy, now)
	h = RecordSLO(c, h, api.HealthDegraded, now.Add(30*time.Second))
	s := SummarizeSLO(c, h, now.Add(30*time.Second))
	require.Equal(t, "Collecting", s.State)
	require.Equal(t, float64(50), s.Availability)
	require.Equal(t, float64(100), s.Coverage)
	require.InDelta(t, 100.0/60, s.WindowCoverage, 0.001)
	// Duplicate evaluations and a backwards clock cannot overwrite a failure.
	h = RecordSLO(c, h, api.HealthHealthy, now.Add(31*time.Second))
	h = RecordSLO(c, h, api.HealthHealthy, now)
	h = RecordSLO(c, h, api.HealthHealthy, now.Add(5*time.Minute))
	s = SummarizeSLO(c, h, now.Add(5*time.Minute))
	require.EqualValues(t, 2, s.Healthy)
	require.EqualValues(t, 1, s.Unhealthy)
	require.EqualValues(t, 8, s.Unknown)
	require.InDelta(t, 100.0*3/11, s.Coverage, 0.001)
}

func TestSLOSurvivesJSONAndTargetChangesButResetsForProbeChanges(t *testing.T) {
	c := sloCheck()
	now := time.Unix(1800000000, 0).UTC()
	h := RecordSLO(c, nil, api.HealthDegraded, now)
	encoded, err := json.Marshal(h)
	require.NoError(t, err)
	var restored api.SLOHistory
	require.NoError(t, json.Unmarshal(encoded, &restored))
	c.SLO.TargetPercentage = 99.9
	next := RecordSLO(c, &restored, api.HealthHealthy, now.Add(30*time.Second))
	require.EqualValues(t, 1, SummarizeSLO(c, next, now.Add(30*time.Second)).Unhealthy)
	require.EqualValues(t, 0, SummarizeSLO(c, &restored, now).Healthy, "recording must not mutate the cached API object")
	c.HTTPProbe.URL = "http://other.sfh.svc/deepcheck"
	reset := RecordSLO(c, next, api.HealthHealthy, now.Add(time.Minute))
	require.EqualValues(t, 0, SummarizeSLO(c, reset, now.Add(time.Minute)).Unhealthy)
	require.Equal(t, now.Add(time.Minute), reset.FirstObservedAt.Time)
}

func TestSLORollingWindowBoundsAndCompliance(t *testing.T) {
	for _, tc := range []struct {
		name            string
		failed, missing int
		want            string
	}{{"met", 1, 0, "Met"}, {"breached", 2, 0, "Breached"}, {"unknown cannot pass", 0, 2, "InsufficientData"}} {
		t.Run(tc.name, func(t *testing.T) {
			c := sloCheck()
			now := time.Unix(1800000000, 0).UTC()
			h := RecordSLO(c, nil, api.HealthDegraded, now)
			for i := 1; i <= 120; i++ {
				if i <= tc.missing {
					continue
				}
				status := api.HealthHealthy
				if i <= tc.failed {
					status = api.HealthDegraded
				}
				h = RecordSLO(c, h, status, now.Add(time.Duration(i)*30*time.Second))
			}
			s := SummarizeSLO(c, h, now.Add(time.Hour))
			require.Equal(t, tc.want, s.State)
			require.EqualValues(t, tc.failed, s.Unhealthy, "the initial failure expired exactly at the rolling boundary")
			require.EqualValues(t, tc.missing, s.Unknown)
			require.Equal(t, "Stale", SummarizeSLO(c, h, now.Add(time.Hour+61*time.Second)).State)
			h = RecordSLO(c, h, api.HealthHealthy, now.Add(3*time.Hour))
			s = SummarizeSLO(c, h, now.Add(3*time.Hour))
			require.EqualValues(t, 1, s.Healthy)
			require.EqualValues(t, 119, s.Unknown)
			require.Equal(t, "InsufficientData", s.State)
		})
	}
}

func TestSLOInvalidProbeConfiguration(t *testing.T) {
	for _, mutate := range []func(*api.HealthCheck){
		func(c *api.HealthCheck) { c.HTTPProbe = nil },
		func(c *api.HealthCheck) { c.HTTPProbe.Method = "DELETE" },
		func(c *api.HealthCheck) { c.HTTPProbe.URL = "http://user:password@example.com" },
		func(c *api.HealthCheck) { c.HTTPProbe.URL = "file:///etc/passwd" },
		func(c *api.HealthCheck) { c.Interval = "1ms" },
		func(c *api.HealthCheck) { c.Interval = "10.5s" },
		func(c *api.HealthCheck) { c.Interval = "13s" },
		func(c *api.HealthCheck) { c.HTTPProbe.Timeout = 60 },
		func(c *api.HealthCheck) { c.SLO.TargetPercentage = 100 },
		func(c *api.HealthCheck) { c.SLO.Window = "365d" },
	} {
		c := sloCheck()
		mutate(&c)
		_, _, err := SLODurations(c)
		require.Error(t, err)
	}
	c := sloCheck()
	c.SLO.Window = "30d"
	c.Interval = "10s"
	h := RecordSLO(c, nil, api.HealthHealthy, time.Now())
	require.Len(t, h.Samples, 64800)
}
