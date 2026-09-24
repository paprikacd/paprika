package metrics

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

type healthMetricSnapshot struct {
	application, namespace string
	check                  api.HealthCheck
	result                 api.HealthCheckResult
	updated                time.Time
}

type healthInstruments struct {
	mu           sync.Mutex
	snapshots    map[string][]healthMetricSnapshot
	observations metric.Int64Counter
	duration     metric.Float64Histogram
	gauges       map[string]metric.Float64ObservableGauge
	registration metric.Registration
	now          func() time.Time
}

var defaultHealthInstruments = newHealthInstruments(meter)

func newHealthInstruments(m metric.Meter) *healthInstruments {
	h := &healthInstruments{snapshots: map[string][]healthMetricSnapshot{}, gauges: map[string]metric.Float64ObservableGauge{}, now: time.Now}
	h.observations = mustCounter(m, "paprika.healthcheck.observations", "Actual health check evaluations; cached reads do not increment this counter")
	var err error
	h.duration, err = m.Float64Histogram("paprika.healthcheck.duration", metric.WithUnit("s"), metric.WithDescription("Wall time of an actual health check evaluation"), metric.WithExplicitBucketBoundaries(defBuckets...))
	if err != nil {
		panic(err)
	}
	definitions := []struct{ name, unit, description string }{
		{"paprika.healthcheck.up", "1", "Latest fresh check: 1 healthy, 0 degraded; absent when stale or unknown"},
		{"paprika.healthcheck.last_observed", "s", "Unix timestamp of the last real health check"},
		{"paprika.healthcheck.fresh", "1", "Whether the latest observation is within two check intervals"},
		{"paprika.slo.target.ratio", "1", "Configured availability target"},
		{"paprika.slo.availability.ratio", "1", "Healthy fraction of observed probes; use coverage and state alongside it"},
		{"paprika.slo.coverage.ratio", "1", "Observed fraction of slots since monitoring began, bounded by the rolling window"},
		{"paprika.slo.window.coverage.ratio", "1", "Observed fraction of the entire configured rolling window"},
		{"paprika.slo.error_budget.remaining.ratio", "1", "Rolling-window error budget remaining; negative means exceeded"},
		{"paprika.slo.burn_rate", "1", "Observed failure fraction divided by the allowed failure fraction"},
		{"paprika.slo.state", "1", "Current SLO analysis state, represented by its bounded state label"},
	}
	observables := make([]metric.Observable, 0, len(definitions))
	for _, d := range definitions {
		g, e := m.Float64ObservableGauge(d.name, metric.WithUnit(d.unit), metric.WithDescription(d.description))
		if e != nil {
			panic(e)
		}
		h.gauges[d.name] = g
		observables = append(observables, g)
	}
	h.registration, err = m.RegisterCallback(h.collect, observables...)
	if err != nil {
		panic(err)
	}
	return h
}

func healthAttributes(namespace, application, check string) []attribute.KeyValue {
	return []attribute.KeyValue{attribute.String("namespace", namespace), attribute.String("application", application), attribute.String("check", check)}
}

func (h *healthInstruments) record(ctx context.Context, namespace, application, check string, status api.HealthStatus, duration time.Duration) {
	attrs := healthAttributes(namespace, application, check)
	result := "unknown"
	switch status {
	case api.HealthHealthy:
		result = "healthy"
	case api.HealthDegraded:
		result = "degraded"
	case api.HealthProgressing:
		result = "progressing"
	case api.HealthUnknown:
		result = "unknown"
	}
	h.observations.Add(ctx, 1, metric.WithAttributes(append(attrs, attribute.String("result", result))...))
	h.duration.Record(ctx, duration.Seconds(), metric.WithAttributes(attrs...))
}

func (h *healthInstruments) replace(app *api.Application) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := app.Namespace + "/" + app.Name
	delete(h.snapshots, key)
	results := map[string]*api.HealthCheckResult{}
	for i := range app.Status.HealthChecks {
		r := &app.Status.HealthChecks[i]
		results[r.Name] = r
	}
	for _, check := range app.Spec.HealthChecks {
		r, ok := results[check.Name]
		if !ok || r.CheckedAt == nil {
			continue
		}
		h.snapshots[key] = append(h.snapshots[key], healthMetricSnapshot{application: app.Name, namespace: app.Namespace, check: *check.DeepCopy(), result: *r.DeepCopy(), updated: h.now()})
	}
}

func (h *healthInstruments) collect(_ context.Context, observer metric.Observer) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	for key, snapshots := range h.snapshots {
		if len(snapshots) == 0 || now.Sub(snapshots[0].updated) > 2*time.Hour {
			delete(h.snapshots, key)
			continue
		}
		for i := range snapshots {
			h.observeSnapshot(observer, &snapshots[i], now)
		}
	}
	return nil
}

// RecordHealthObservation uses the shared OTel meter, so both the Prometheus
// reader (/metrics) and any configured OTLP reader receive the same instruments.
func RecordHealthObservation(ctx context.Context, namespace, application, check string, status api.HealthStatus, duration time.Duration) {
	defaultHealthInstruments.record(ctx, namespace, application, check, status, duration)
}

func ReplaceHealthMetrics(app *api.Application) { defaultHealthInstruments.replace(app) }

func DeleteHealthMetrics(namespace, application string) {
	defaultHealthInstruments.mu.Lock()
	defer defaultHealthInstruments.mu.Unlock()
	delete(defaultHealthInstruments.snapshots, namespace+"/"+application)
}

func (h *healthInstruments) observeSnapshot(observer metric.Observer, s *healthMetricSnapshot, now time.Time) {
	attrs := healthAttributes(s.namespace, s.application, s.check.Name)
	observe := func(name string, value float64, extra ...attribute.KeyValue) {
		observer.ObserveFloat64(h.gauges[name], value, metric.WithAttributes(append(append([]attribute.KeyValue{}, attrs...), extra...)...))
	}
	fresh := observationFresh(s, now)
	observe("paprika.healthcheck.last_observed", float64(s.result.CheckedAt.Unix()))
	freshValue := float64(0)
	if fresh {
		freshValue = 1
	}
	observe("paprika.healthcheck.fresh", freshValue)
	if fresh {
		switch s.result.Status {
		case api.HealthHealthy:
			observe("paprika.healthcheck.up", 1)
		case api.HealthDegraded:
			observe("paprika.healthcheck.up", 0)
		case api.HealthUnknown, api.HealthProgressing:
		}
	}

	if s.check.SLO == nil {
		return
	}
	summary := health.SummarizeSLO(s.check, s.result.SLOHistory, now)
	observe("paprika.slo.state", 1, attribute.String("state", summary.State))
	observe("paprika.slo.target.ratio", summary.Target/100)
	observe("paprika.slo.coverage.ratio", summary.Coverage/100)
	observe("paprika.slo.window.coverage.ratio", summary.WindowCoverage/100)
	if summary.Healthy+summary.Unhealthy > 0 {
		observe("paprika.slo.availability.ratio", summary.Availability/100)
		observe("paprika.slo.error_budget.remaining.ratio", summary.BudgetRemaining/100)
		observe("paprika.slo.burn_rate", summary.BurnRate)
	}
}

func observationFresh(s *healthMetricSnapshot, now time.Time) bool {
	interval, err := time.ParseDuration(s.check.Interval)
	if err != nil || interval <= 0 {
		interval = 30 * time.Second
	}
	age := now.Sub(s.result.CheckedAt.Time)
	return age >= 0 && age <= 2*interval
}
