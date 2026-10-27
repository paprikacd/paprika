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
	Records   *dataframe.Frame `json:"records,omitempty"`
	Truncated bool             `json:"truncated,omitempty"`
}

// Dashboard documents follow the strict versioned contract shared with the UI.
type Dashboard = json.RawMessage
