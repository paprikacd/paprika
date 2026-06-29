// Package metrics provides Prometheus metrics for Paprika pipelines, releases, and applications.
package metrics

import (
	"errors"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"

	"github.com/benebsworth/paprika/internal/clock"
)

var (
	// PipelineDuration tracks the duration of pipeline execution in seconds.
	PipelineDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "paprika_pipeline_duration_seconds",
			Help:    "Duration of pipeline execution in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"pipeline", "namespace"},
	)

	// PipelinePhaseTotal tracks the number of pipeline phase transitions.
	PipelinePhaseTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_pipeline_phase_total",
			Help: "Number of pipeline phase transitions",
		},
		[]string{"pipeline", "namespace", "phase"},
	)

	// ReleaseDuration tracks the duration of release reconciliation in seconds.
	ReleaseDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "paprika_release_duration_seconds",
			Help:    "Duration of release reconciliation in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"release", "namespace", "target_stage"},
	)

	// ReleasePhaseTotal tracks the number of release phase transitions.
	ReleasePhaseTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_release_phase_total",
			Help: "Number of release phase transitions",
		},
		[]string{"release", "namespace", "phase"},
	)

	// CanaryStepTotal tracks the number of canary weight step transitions.
	CanaryStepTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_canary_step_total",
			Help: "Number of canary weight step transitions",
		},
		[]string{"release", "namespace", "stage"},
	)

	// CanaryWeightGauge tracks the current canary traffic weight percentage.
	CanaryWeightGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "paprika_canary_weight_current",
			Help: "Current canary traffic weight percentage",
		},
		[]string{"release", "namespace", "stage"},
	)

	// AnalysisCheckTotal tracks the number of analysis checks executed.
	AnalysisCheckTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_analysis_check_total",
			Help: "Number of analysis checks executed",
		},
		[]string{"release", "namespace", "check_type", "result"},
	)

	// RolloutCanaryStepTotal tracks the number of canary step transitions for Rollout resources.
	RolloutCanaryStepTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_rollout_canary_step_total",
			Help: "Number of canary step transitions for Rollout resources",
		},
		[]string{"rollout", "namespace"},
	)

	// RolloutCanaryWeightGauge tracks the current canary traffic weight for a Rollout.
	RolloutCanaryWeightGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "paprika_rollout_canary_weight_current",
			Help: "Current canary traffic weight percentage for a Rollout",
		},
		[]string{"rollout", "namespace"},
	)

	// RolloutPhaseTotal tracks the number of Rollout phase transitions.
	RolloutPhaseTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_rollout_phase_total",
			Help: "Number of Rollout phase transitions",
		},
		[]string{"rollout", "namespace", "phase"},
	)

	// ApplicationPhaseTotal tracks the number of application phase transitions.
	ApplicationPhaseTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_application_phase_total",
			Help: "Number of application phase transitions",
		},
		[]string{"application", "namespace", "phase"},
	)

	// ApplicationReconcileDuration tracks the duration of application reconciliation.
	ApplicationReconcileDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "paprika_application_reconcile_duration_seconds",
			Help:    "Duration of application reconciliation in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"application", "namespace"},
	)

	// APIRequestDuration tracks the duration of API requests.
	APIRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "paprika_api_request_duration_seconds",
			Help:    "Duration of API requests in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path", "status_code"},
	)

	// APIRequestTotal tracks the total number of API requests.
	APIRequestTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_api_request_total",
			Help: "Number of API requests",
		},
		[]string{"method", "path", "status_code"},
	)

	// ReconcileTotal tracks the total number of controller reconciliations.
	ReconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "paprika_reconcile_total",
			Help: "Number of controller reconciliations",
		},
		[]string{"controller", "result"},
	)

	// ReconcileDuration tracks the duration of controller reconciliations.
	ReconcileDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "paprika_reconcile_duration_seconds",
			Help:    "Duration of controller reconciliations in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"controller"},
	)

	CoordinatorReplicas = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "paprika_coordinator_replicas",
		Help: "Number of active replicas in the coordinator ring",
	})

	CoordinatorHeartbeatSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "paprika_coordinator_heartbeat_seconds",
		Help:    "Coordinator heartbeat round-trip latency in seconds",
		Buckets: prometheus.DefBuckets,
	})

	CoordinatorHeartbeatFailuresTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "paprika_coordinator_heartbeat_failures_total",
		Help: "Number of failed coordinator heartbeat attempts",
	})
)

var allCollectors = []prometheus.Collector{
	PipelineDuration,
	PipelinePhaseTotal,
	ReleaseDuration,
	ReleasePhaseTotal,
	CanaryStepTotal,
	CanaryWeightGauge,
	AnalysisCheckTotal,
	ApplicationPhaseTotal,
	ApplicationReconcileDuration,
	APIRequestDuration,
	APIRequestTotal,
	ReconcileTotal,
	ReconcileDuration,
	CoordinatorReplicas,
	CoordinatorHeartbeatSeconds,
	CoordinatorHeartbeatFailuresTotal,
	RolloutCanaryStepTotal,
	RolloutCanaryWeightGauge,
	RolloutPhaseTotal,
}

// RegisterCollectors registers Paprika collectors with the provided registerer.
// Call this once during process startup.
func RegisterCollectors(reg prometheus.Registerer) error {
	if reg == nil {
		reg = metrics.Registry
	}
	var errs []error
	for _, c := range allCollectors {
		if err := reg.Register(c); err != nil {
			errs = append(errs, fmt.Errorf("register collector: %w", err))
		}
	}
	return errors.Join(errs...)
}

// Timer returns the current time from the provided clock, useful for measuring
// elapsed time. If clk is nil, the system clock is used.
func Timer(clk clock.Clock) time.Time {
	if clk == nil {
		clk = clock.Real{}
	}
	return clk.Now()
}

// Since returns the number of seconds elapsed since the given time, measured
// using the provided clock. If clk is nil, the system clock is used.
func Since(clk clock.Clock, start time.Time) float64 {
	if clk == nil {
		clk = clock.Real{}
	}
	return clk.Now().Sub(start).Seconds()
}
