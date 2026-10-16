// Package connector defines the pluggable observability-backend model: the
// value types a query is expressed in, and the Connector interface that
// concrete implementations (Prometheus, Loki, Tempo and generic OTLP
// retrieval proxies) satisfy. It intentionally depends on no backend client
// SDK — backends are queried over plain HTTP and JSON — so implementations
// stay unit-testable in isolation.
package connector

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Signal is one observability data plane a query can ask for.
type Signal string

// Signal values understood by QueryRequest.
const (
	// SignalLogs is the log data plane.
	SignalLogs Signal = "logs"
	// SignalMetrics is the metrics data plane.
	SignalMetrics Signal = "metrics"
	// SignalTraces is the distributed-trace data plane.
	SignalTraces Signal = "traces"
)

// State is the outcome vocabulary of one query, in the values a caller can
// write to status without further translation. The values deliberately
// parallel the clusterprovider state vocabulary
// (internal/clusterprovider/clusterprovider.go) so both provider boards
// read the same way.
type State string

// State values written to QueryResult.State.
const (
	// StateOK means the backend answered; Data is its JSON response.
	StateOK State = "OK"
	// StateNotConfigured means no backend endpoint has been configured.
	StateNotConfigured State = "NotConfigured"
	// StateNotAvailable means the backend is configured but cannot serve
	// the request: the queried path does not exist, or the query shape is
	// one the connector does not supply.
	StateNotAvailable State = "NotAvailable"
	// StateError means the backend was queried and failed for a reason that
	// is neither credential denial nor absence.
	StateError State = "Error"
	// StateForbidden means the backend refused the supplied credentials.
	StateForbidden State = "Forbidden"
)

// Provider type names, shared by configuration, the wiring New in
// internal/observabilitygateway, and status.
const (
	ProviderPrometheus = "prometheus"
	ProviderLoki       = "loki"
	ProviderTempo      = "tempo"
	ProviderOTLP       = "otlp"

	// Google Cloud connectors. Credentials are a Google credential JSON
	// (service_account, external_account or impersonated_service_account —
	// the same restriction the cluster provider applies) or nil for ambient
	// identity (GKE Workload Identity / metadata server).
	ProviderGCPCloudLogging    = "gcp-cloudlogging"
	ProviderGCPCloudMonitoring = "gcp-cloudmonitoring"
	ProviderGCPCloudTrace      = "gcp-cloudtrace"

	// AWS connectors. Credentials are a JSON document with snake_case keys
	// ({"access_key_id","secret_access_key","session_token"} — the document
	// the EKS cluster provider accepts) or nil for the ambient SDK chain
	// (IRSA, IMDS, environment).
	ProviderAWSCloudWatchLogs    = "aws-cloudwatch-logs"
	ProviderAWSCloudWatchMetrics = "aws-cloudwatch-metrics"
	ProviderAWSXRay              = "aws-xray"
	ProviderAWSCloudTrail        = "aws-cloudtrail"

	// ProviderVultrMonitoring is the Vultr bandwidth connector (account
	// totals and per-instance series). Credentials are a raw Vultr API
	// key, sent as an Authorization: Bearer token; nil reports
	// NotConfigured — Vultr has no ambient identity chain.
	ProviderVultrMonitoring = "vultr-monitoring"

	// ProviderMock is the synthetic in-process backend for load testing,
	// demos and e2e: it serves every signal without network egress and
	// generates deterministic data in each backend's wire shape.
	ProviderMock = "mock"
)

// ErrForbidden marks backend credential denials so callers can report
// StateForbidden rather than StateError — the distinction an operator acts
// on.
var ErrForbidden = errors.New("provider credential refused")

// ErrNotConfigured marks a missing connector configuration: the integration
// is selected but no endpoint has been provided.
var ErrNotConfigured = errors.New("provider not configured")

// ErrNotAvailable marks a backend that does not expose the queried path, so
// a missing API surface is not misreported as a generic failure.
var ErrNotAvailable = errors.New("observability backend path not available")

// ErrUnsupported marks a query shape the connector does not serve — a caller
// bug, since the descriptor advertised what it supplies.
var ErrUnsupported = errors.New("query shape not supported by this connector")

// Descriptor advertises what a Connector is capable of, so callers can
// decide which signals it may be trusted to serve rather than inferring it
// from behavior.
type Descriptor struct {
	Name string
	// Signals lists the data planes this connector can query. A signal
	// absent from this list must never be reported as StateOK by the
	// connector.
	Signals []Signal
	// NeedsEgress is true when Query makes an outbound network call to the
	// backend, so callers can gate it behind network policy.
	NeedsEgress bool
}

// CanSupply reports whether the connector claims to be able to serve signal.
func (d Descriptor) CanSupply(signal Signal) bool {
	for _, s := range d.Signals {
		if s == signal {
			return true
		}
	}
	return false
}

// TimeRange bounds a query in absolute time. A zero Start or End means
// unbounded on that side, which connectors translate into their backend's
// own "omitted parameter" form.
type TimeRange struct {
	Start time.Time
	End   time.Time
}

// QueryRequest is one Query call. Connectors are stateless structs, so
// everything a call needs travels in the request; nothing is held between
// calls.
type QueryRequest struct {
	// Signal selects the data plane to query.
	Signal Signal
	// Query carries the backend's native query language — PromQL, LogQL or
	// TraceQL depending on the connector — and may be empty for connectors
	// that also support fetch-by-parameter mode (e.g. tempo by TraceID).
	Query string
	// TraceID selects one trace directly, for connectors that can fetch it.
	TraceID string
	// Range bounds the query in absolute time.
	Range TimeRange
	// Limit caps the number of returned entries; interpretation and
	// clamping are the connector's own.
	Limit int
	// PageToken continues a provider-native query page. It is opaque and
	// must be used with the same provider, query, range and limit as the
	// preceding request; tokens are never logged by the gateway.
	PageToken string
	// Config is the connector's provider-specific configuration as opaque
	// JSON, validated ahead of use by ValidateConfig.
	Config json.RawMessage
	// Credentials is the backend credential document: nil or empty means
	// the backend needs no auth; a "user:password" form (containing a
	// colon) selects HTTP Basic; anything else is sent as an
	// Authorization: Bearer token.
	Credentials []byte
}

// MaxPageTokenBytes bounds opaque continuation data before it reaches a
// provider. The token is never included in validation errors.
const MaxPageTokenBytes = 4096

// QueryResult is one query's outcome. Data is the backend's JSON response
// passed through untouched, wrapped with the State and Reason a caller shows
// an operator. Reason is always a fixed sentence, never backend output:
// endpoint URLs and response bodies can carry credential material, so
// anything more detailed belongs in logs, not in status.
type QueryResult struct {
	State  State
	Reason string
	Data   json.RawMessage
}

// Connector is one observability backend integration. Implementations are
// stateless structs, safe to hold for the lifetime of the process; per-call
// state belongs in QueryRequest.
type Connector interface {
	// Descriptor advertises this connector's name, signals and network
	// needs.
	Descriptor() Descriptor
	// ValidateConfig checks provider-specific configuration ahead of use,
	// before it is ever passed to Query.
	ValidateConfig(config json.RawMessage) error
	// Query runs one request against the backend.
	//
	// The error contract keeps status writes sanitized: backend failures —
	// credential denial, missing paths, transport errors — are reported as
	// a QueryResult with State set and a fixed-sentence Reason, and a nil
	// error. Only caller bugs return an error: a configuration document
	// that failed ValidateConfig, and a query shape outside the advertised
	// descriptor (wrapping ErrUnsupported), for which a StateNotAvailable
	// result is returned alongside so UI surfaces can render either.
	Query(ctx context.Context, req QueryRequest) (*QueryResult, error)
}

// ExploreKind selects which slice of a backend's schema an Explore call
// enumerates. The kinds are named for what a caller is trying to work out
// "what can I query here?" — metric names, the labels on a metric, the
// values a label takes, a metric's type/help/unit metadata, or the services
// a trace backend knows about.
type ExploreKind string

// ExploreKind values a connector may serve. Kinds a connector does not
// serve return a StateNotAvailable ExploreResult, never an error.
const (
	// ExploreMetricNames enumerates the backend's metric names.
	ExploreMetricNames ExploreKind = "metric_names"
	// ExploreLabelNames enumerates label names — globally, or constrained
	// to one metric when ExploreRequest.Metric is set.
	ExploreLabelNames ExploreKind = "label_names"
	// ExploreLabelValues enumerates the values one label takes —
	// globally, or constrained to one metric when
	// ExploreRequest.Metric is set. ExploreRequest.Label is required.
	ExploreLabelValues ExploreKind = "label_values"
	// ExploreMetricMetadata describes one metric: its type, help text and
	// unit. ExploreRequest.Metric is required.
	ExploreMetricMetadata ExploreKind = "metric_metadata"
	// ExploreTraceServices enumerates the service names a trace backend
	// has spans for.
	ExploreTraceServices ExploreKind = "trace_services"
)

// ExploreRequest is one Explore call. As with QueryRequest, connectors are
// stateless so everything a call needs travels in the request.
type ExploreRequest struct {
	// Kind selects what to enumerate.
	Kind ExploreKind
	// Metric optionally constrains label enumeration to one metric and
	// selects the metric described by ExploreMetricMetadata.
	Metric string
	// Label names the label whose values ExploreLabelValues enumerates.
	Label string
	// Prefix optionally filters ExploreMetricNames to names containing the
	// substring (the backend's own prefix/regex API is used where one
	// exists; otherwise the connector filters the response).
	Prefix string
	// Limit caps the number of returned entries; interpretation and
	// clamping are the connector's own.
	Limit int
	// Params carries optional provider-specific filter keys, documented per
	// connector. aws-cloudwatch-metrics reads "namespace" to scope
	// ListMetrics.
	Params map[string]string
	// Config is the connector's provider-specific configuration, validated
	// ahead of use by ValidateConfig.
	Config json.RawMessage
	// Credentials is the backend credential document, in the same form
	// QueryRequest.Credentials documents.
	Credentials []byte
}

// ExploreResult is one Explore call's outcome, carrying the same sanitized
// State/Reason contract as QueryResult: Data is the backend's JSON passed
// through untouched and Reason is always a fixed sentence.
type ExploreResult struct {
	State  State
	Reason string
	Data   json.RawMessage
}

// Explorer is implemented by connectors that can enumerate their backend's
// schema — what metrics, labels, label values, metadata or services exist —
// so callers can work out what to query before writing the query. It is an
// optional interface over Connector: backends with no enumeration API (or
// where it is not worth wiring yet) simply do not implement it, and the
// gateway reports StateNotAvailable for their exploration kinds.
type Explorer interface {
	Connector
	// Explore enumerates one schema slice. The error contract mirrors
	// Query: backend failures return a State-set result with nil error;
	// only caller bugs — invalid config or an unsupported kind (wrapping
	// ErrUnsupported) — return an error alongside a StateNotAvailable
	// result.
	Explore(ctx context.Context, req ExploreRequest) (*ExploreResult, error)
}
