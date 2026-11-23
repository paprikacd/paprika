// Package insights implements Paprika's independently deployable observability
// query and dashboard service. Provider credentials never cross its HTTP API.
package insights

import (
	"encoding/json"
	"slices"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// ProviderConfig stores endpoint and credential references, never secret values.
// Provisioned providers come from startup configuration; managed providers may
// be persisted by authenticated administrators through the host API proxy.
type ProviderConfig struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Type           string            `json:"type"`
	URL            string            `json:"url"`
	BearerTokenEnv string            `json:"bearerTokenEnv,omitempty"`
	HeadersEnv     map[string]string `json:"headersEnv,omitempty"`
	// MinStepSeconds is the finest range-query step the provider can serve, in
	// (0, 3600] seconds. It is absent to take the provider type's default.
	MinStepSeconds float64 `json:"minStepSeconds,omitempty"`
}

type Provider struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Type         string   `json:"type"`
	Capabilities []string `json:"capabilities"`
	Managed      bool     `json:"managed"`
	// Shared providers are resolved through the caller-authorized observability
	// catalog. ProviderRef is a public Kubernetes identity, never an endpoint.
	Source      string `json:"source,omitempty"`
	ProviderRef string `json:"providerRef,omitempty"`
	Transport   string `json:"transport,omitempty"`
	// State is the gateway's last probe verdict for a shared provider, one of
	// the closed connector states. It is informational: a query is never refused
	// on it, because the verdict can be up to a probe interval old.
	State string `json:"state,omitempty"`
	// MinStepSeconds is the lowest metrics step Insights sends to this provider.
	// Finer requested steps are raised to it. It is absent when the provider
	// takes no step.
	MinStepSeconds float64 `json:"minStepSeconds,omitempty"`
}

// UnsupportedProvider is a shared provider that the gateway catalog lists but
// Insights cannot query. Reason is a closed code and Message is fixed Insights
// wording taken from the catalog; the gateway's own reason text is never sent.
type UnsupportedProvider struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// TypeLabel is the catalog's display name for a known type. It is absent
	// for a type this Insights build does not know.
	TypeLabel string `json:"typeLabel,omitempty"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
}

type ProviderConfigView struct {
	ProviderConfig
	Managed bool   `json:"managed"`
	ETag    string `json:"etag"`
}

func (p *Provider) supports(kind string) bool { return slices.Contains(p.Capabilities, kind) }

type MetadataResult struct {
	Values    []string              `json:"values"`
	Truncated bool                  `json:"truncated,omitempty"`
	Series    *MetricSeriesMetadata `json:"series,omitempty"`
}

// MetricSeriesMetadata describes a bounded set of stored series in an approximate
// time window. It is not the provider's active-series or global cardinality count.
type MetricSeriesMetadata struct {
	Count           int                   `json:"count"`
	Limit           int                   `json:"limit"`
	Start           int64                 `json:"start"`
	End             int64                 `json:"end"`
	Truncated       bool                  `json:"truncated,omitempty"`
	LabelsTruncated bool                  `json:"labelsTruncated,omitempty"`
	Labels          []MetricLabelMetadata `json:"labels"`
}

type MetricLabelMetadata struct {
	Name            string   `json:"name"`
	Cardinality     int      `json:"cardinality"`
	Values          []string `json:"values"`
	ValuesTruncated bool     `json:"valuesTruncated,omitempty"`
}

// Query uses Unix seconds for range bounds and step. Returned timestamps use
// Unix milliseconds, so the frontend can pass them directly to Date and charts.
type Query struct {
	ProviderID string  `json:"providerId"`
	Query      string  `json:"query"`
	Kind       string  `json:"kind"`
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	Step       float64 `json:"step"`
	TraceID    string  `json:"traceId,omitempty"`
}

type Point struct {
	Timestamp float64  `json:"timestamp"`
	Value     *float64 `json:"value"`
}

type Series struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
	Points []Point           `json:"points"`
}

type Trace struct {
	TraceID    string  `json:"traceId"`
	Service    string  `json:"service"`
	Operation  string  `json:"operation"`
	DurationMs float64 `json:"durationMs"`
	StartTime  float64 `json:"startTime"`
	Status     string  `json:"status"`
}

type QueryResult struct {
	Series    []Series         `json:"series,omitempty"`
	Traces    []Trace          `json:"traces,omitempty"`
	Spans     []TraceSpan      `json:"spans,omitempty"`
	Records   *dataframe.Frame `json:"records,omitempty"`
	Truncated bool             `json:"truncated,omitempty"`
	// Truncation says why Truncated is set. It is present only when Truncated is.
	Truncation  *QueryTruncation  `json:"truncation,omitempty"`
	Diagnostics *QueryDiagnostics `json:"diagnostics,omitempty"`
}

// QueryTruncation names the reason a result is incomplete.
//
// Reason is one of "row_limit" (the bounded cap was reached: the first Limit
// units are shown), "partial" (the source reported an incomplete response) or
// "provider_warning" (the source reported warnings). Unit is one of "series",
// "traces", "points" or "rows". Limit is zero when the cap is not known here.
type QueryTruncation struct {
	Reason string `json:"reason"`
	Limit  int    `json:"limit,omitempty"`
	Unit   string `json:"unit,omitempty"`
}

// TraceSpan contains bounded trace topology, timing and safe semantic dimensions.
type TraceSpan struct {
	SpanID            string           `json:"spanId"`
	ParentSpanID      string           `json:"parentSpanId,omitempty"`
	Service           string           `json:"service"`
	Operation         string           `json:"operation"`
	StartTime         float64          `json:"startTime"`
	DurationMs        float64          `json:"durationMs"`
	Status            string           `json:"status"`
	Attributes        []TraceAttribute `json:"attributes,omitempty"`
	AttributesOmitted int              `json:"attributesOmitted,omitempty"`
}

type TraceAttribute struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Dashboard documents follow the strict versioned contract shared with the UI.
type Dashboard = json.RawMessage
