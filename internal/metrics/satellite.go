package metrics

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Satellite transport attribute values. A report or task travels either as an
// HTTPS POST or down the bidirectional link; they fail in different ways, so a
// single total would hide which transport is unhealthy.
const (
	SatelliteTransportPost   = "post"
	SatelliteTransportStream = "stream"
)

// Satellite report outcomes. Resync is not a failure: the control plane is
// asking the satellite to open a new session, and counting it as rejected would
// hide a real rejection.
const (
	SatelliteReportAccepted = "accepted"
	SatelliteReportRejected = "rejected"
	SatelliteReportResync   = "resync"
)

// Satellite link lifecycle events.
const (
	SatelliteLinkAttached = "attached"
	SatelliteLinkDetached = "detached"
	SatelliteLinkRefused  = "refused"
)

// Satellite task outcomes.
const (
	SatelliteTaskOK      = "ok"
	SatelliteTaskFailed  = "failed"
	SatelliteTaskOffline = "offline"
	SatelliteTaskError   = "error"
)

var (
	SatelliteReports        = mustCounter(meter, "paprika.satellite.reports", "Satellite inventory reports by outcome")
	SatelliteReportDuration = mustFloatHistogram(meter, "paprika.satellite.report.duration", "s", "Time to accept a satellite inventory report")
	SatelliteReportBytes    = mustHistogram(meter, "paprika.satellite.report.bytes", "By", "Uncompressed accepted satellite report size")

	// SatelliteLinkEvents counts attach, detach and refused handshakes. A
	// refused handshake is a credential or identity problem and needs an
	// operator; attach/detach churn is a flapping link.
	SatelliteLinkEvents = mustCounter(meter, "paprika.satellite.link.events", "Satellite link lifecycle events by type")

	// SatelliteTasks counts dispatched tasks. The round trip is what a release
	// waits on, so its duration is separate from the release's own.
	SatelliteTasks = mustCounter(meter, "paprika.satellite.tasks", "Satellite tasks dispatched by action and outcome")

	SatelliteTaskDuration = mustFloatHistogram(meter, "paprika.satellite.task.duration", "s",
		"Round-trip duration of a dispatched satellite task", metric.WithExplicitBucketBoundaries(defBuckets...))
)

// Satellite report attributes name the transport as well as the outcome: a
// link that cannot accept reports and a POST endpoint that rejects them are
// different incidents.
func SatelliteReportAttributes(transport, outcome string) metric.MeasurementOption {
	return metric.WithAttributes(
		attribute.String("transport", transport),
		attribute.String("outcome", outcome),
	)
}

// SatelliteTaskAttributes names the task kind and its outcome.
func SatelliteTaskAttributes(action, outcome string) metric.MeasurementOption {
	return metric.WithAttributes(
		attribute.String("action", action),
		attribute.String("outcome", outcome),
	)
}

// SatelliteLinkAttributes names the link event.
func SatelliteLinkAttributes(event string) metric.MeasurementOption {
	return metric.WithAttributes(attribute.String("event", event))
}

// SatelliteObservation is one cluster's satellite state at scrape time.
type SatelliteObservation struct {
	Namespace string
	Name      string
	// HasReport is false before the first accepted report, where the age is
	// unknown rather than zero.
	HasReport        bool
	ReportAgeSeconds float64
	Applications     int64
}

// SatelliteObserver returns the current per-cluster satellite state.
type SatelliteObserver func(context.Context) []SatelliteObservation

// RegisterSatelliteGauges publishes per-cluster report freshness.
//
// Report age is the metric that says a satellite went quiet: the link may look
// established while no report arrives, and every consumer of the fleet view is
// then reading stale state. Applications is the denominator that makes a
// truncated report visible.
func RegisterSatelliteGauges(source SatelliteObserver) (metric.Registration, error) {
	return registerSatelliteGauges(meter, source)
}

func registerSatelliteGauges(m metric.Meter, source SatelliteObserver) (metric.Registration, error) {
	age, err := m.Float64ObservableGauge("paprika.satellite.report.age",
		metric.WithUnit("s"),
		metric.WithDescription("Seconds since the last accepted satellite report"))
	if err != nil {
		return nil, fmt.Errorf("create satellite report age gauge: %w", err)
	}
	applications, err := m.Int64ObservableGauge("paprika.satellite.applications",
		metric.WithUnit("1"),
		metric.WithDescription("Applications the satellite last reported"))
	if err != nil {
		return nil, fmt.Errorf("create satellite applications gauge: %w", err)
	}
	registration, err := m.RegisterCallback(func(ctx context.Context, observer metric.Observer) error {
		for _, observation := range source(ctx) {
			attrs := metric.WithAttributes(
				attribute.String("namespace", observation.Namespace),
				attribute.String("cluster", observation.Name),
			)
			if observation.HasReport {
				observer.ObserveFloat64(age, observation.ReportAgeSeconds, attrs)
			}
			observer.ObserveInt64(applications, observation.Applications, attrs)
		}
		return nil
	}, age, applications)
	if err != nil {
		return nil, fmt.Errorf("register satellite gauges: %w", err)
	}
	return registration, nil
}

// SatelliteLinkState is one cluster's control-plane link.
type SatelliteLinkState struct {
	Namespace string
	Name      string
}

// RegisterSatelliteLinkGauge publishes which clusters currently hold a link.
//
// The gauge is observed at scrape time so a dropped link is visible without
// waiting for the next report to fail. Only clusters that are connected appear;
// alert on the absence of a series you expect, or pair it with report age.
func RegisterSatelliteLinkGauge(source func() []SatelliteLinkState) (metric.Registration, error) {
	return registerSatelliteLinkGauge(meter, source)
}

func registerSatelliteLinkGauge(m metric.Meter, source func() []SatelliteLinkState) (metric.Registration, error) {
	up, err := m.Int64ObservableGauge("paprika.satellite.link.up",
		metric.WithUnit("1"),
		metric.WithDescription("Whether a satellite link is attached for this cluster"))
	if err != nil {
		return nil, fmt.Errorf("create satellite link gauge: %w", err)
	}
	registration, err := m.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		for _, state := range source() {
			observer.ObserveInt64(up, 1, metric.WithAttributes(
				attribute.String("namespace", state.Namespace),
				attribute.String("cluster", state.Name),
			))
		}
		return nil
	}, up)
	if err != nil {
		return nil, fmt.Errorf("register satellite link gauge: %w", err)
	}
	return registration, nil
}

// MustRegisterSatelliteLinkGauge is RegisterSatelliteLinkGauge for a caller
// with no error path at hand, such as process startup. Instrument construction
// is deterministic, so a failure means the instrument itself is malformed and
// not that the environment is unhappy; every other constructor in this package
// panics for the same reason.
func MustRegisterSatelliteLinkGauge(source func() []SatelliteLinkState) {
	if _, err := RegisterSatelliteLinkGauge(source); err != nil {
		panic(err)
	}
}
