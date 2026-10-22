package metrics

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"k8s.io/apimachinery/pkg/types"
)

// reconcileMetricState answers "is the control plane keeping up?" without a
// PromQL query: the latest timestamp for every controller result and every
// application reconcile is exported as an observable gauge.
type reconcileResultKey struct {
	controller string
	result     string
}

type reconcileMetricState struct {
	mu           sync.RWMutex
	controllers  map[reconcileResultKey]int64
	applications map[types.NamespacedName]int64
}

type reconcileInstruments struct {
	controllerLast  metric.Int64ObservableGauge
	applicationLast metric.Int64ObservableGauge
	state           *reconcileMetricState
	registration    metric.Registration
}

var defaultReconcileInstruments = mustNewReconcileInstruments(meter)

func newReconcileInstruments(m metric.Meter) (*reconcileInstruments, error) {
	controllerLast, err := m.Int64ObservableGauge(
		"paprika.controller.last_reconcile.timestamp",
		metric.WithDescription("Unix timestamp of the last reconcile attempt, by controller and result"),
		metric.WithUnit("s"),
	)
	if err != nil {
		return nil, fmt.Errorf("create controller last reconcile gauge: %w", err)
	}
	applicationLast, err := m.Int64ObservableGauge(
		"paprika.application.last_reconcile.timestamp",
		metric.WithDescription("Unix timestamp of the last reconcile attempt for an application"),
		metric.WithUnit("s"),
	)
	if err != nil {
		return nil, fmt.Errorf("create application last reconcile gauge: %w", err)
	}

	state := &reconcileMetricState{
		controllers:  make(map[reconcileResultKey]int64),
		applications: make(map[types.NamespacedName]int64),
	}
	instruments := &reconcileInstruments{
		controllerLast:  controllerLast,
		applicationLast: applicationLast,
		state:           state,
	}

	registration, err := m.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		state.mu.RLock()
		defer state.mu.RUnlock()
		for key, timestamp := range state.controllers {
			observer.ObserveInt64(controllerLast, timestamp, metric.WithAttributes(
				attribute.String("controller", key.controller),
				attribute.String("result", key.result),
			))
		}
		for key, timestamp := range state.applications {
			observer.ObserveInt64(applicationLast, timestamp, metric.WithAttributes(
				attribute.String("application", key.Name),
				attribute.String("namespace", key.Namespace),
			))
		}
		return nil
	}, controllerLast, applicationLast)
	if err != nil {
		return nil, fmt.Errorf("register reconcile gauge callback: %w", err)
	}
	instruments.registration = registration
	return instruments, nil
}

func mustNewReconcileInstruments(m metric.Meter) *reconcileInstruments {
	instruments, err := newReconcileInstruments(m)
	if err != nil {
		panic(err)
	}
	return instruments
}

// RecordControllerReconcile is the single write path for controller reconcile
// counters, durations, and last-attempt timestamps. seconds is the reconcile
// duration in seconds, matching the existing Prometheus histogram.
func RecordControllerReconcile(controller, result string, seconds float64) {
	ReconcileTotal.WithLabelValues(controller, result).Inc()
	ReconcileDuration.WithLabelValues(controller).Observe(seconds)

	timestamp := time.Now().Unix()
	state := defaultReconcileInstruments.state
	state.mu.Lock()
	state.controllers[reconcileResultKey{controller: controller, result: result}] = timestamp
	state.mu.Unlock()
}

// RecordApplicationReconcile is the single write path for per-application
// reconcile durations and last-attempt timestamps. seconds is the reconcile
// duration in seconds.
func RecordApplicationReconcile(application, namespace string, seconds float64) {
	ApplicationReconcileDuration.WithLabelValues(application, namespace).Observe(seconds)

	timestamp := time.Now().Unix()
	state := defaultReconcileInstruments.state
	state.mu.Lock()
	state.applications[types.NamespacedName{Namespace: namespace, Name: application}] = timestamp
	state.mu.Unlock()
}
