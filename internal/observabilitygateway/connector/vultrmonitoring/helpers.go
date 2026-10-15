// Shared helpers for the vultrmonitoring connector: strict configuration
// parsing with the vendor endpoint as default, the metric catalog the
// explorer enumerates, and the result/error builders every connector
// package keeps locally.
package vultrmonitoring

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Fixed sentences the results carry; raw error text never reaches them.
const (
	reasonCredentials   = "a Vultr API key credential is required"
	reasonNotEnumerated = "that label is not enumerable on the vultr-monitoring connector"
)

// metricCatalog is the static metric set the Vultr v2 API exposes; the
// explorer enumerates it and the Query argument selects from it.
var metricCatalog = []string{
	MetricAccountBandwidth,
	MetricInstanceIncomingBytes,
	MetricInstanceOutgoingBytes,
}

// instanceLabels are the instance fields the connector surfaces on its
// series; the explorer enumerates them as labels and enumerates their
// values from the live instance list.
var instanceLabels = []string{"instance_id", "label", "region", "status"}

// parseConfig decodes the strict configuration document: the optional
// endpoint override (the vendor API is the default), the optional headers
// and insecureSkipTLS keys, and nothing else. Unlike the httphelp connectors
// an endpoint is NOT required — api.vultr.com is the default.
func parseConfig(config json.RawMessage) (httphelp.Config, error) {
	cfg := httphelp.Config{Endpoint: defaultEndpoint}
	if len(bytes.TrimSpace(config)) == 0 {
		return cfg, nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(config, &raw); err != nil {
		return httphelp.Config{}, fmt.Errorf("config: invalid JSON document: %w", err)
	}
	for key := range raw {
		if key != "endpoint" && key != "headers" && key != "insecureSkipTLS" {
			return httphelp.Config{}, fmt.Errorf("config: unknown key %q", key)
		}
	}
	if value, ok := raw["endpoint"]; ok {
		var endpoint string
		if err := json.Unmarshal(value, &endpoint); err != nil {
			return httphelp.Config{}, fmt.Errorf("config: key %q must be a string", "endpoint")
		}
		parsed, err := url.Parse(endpoint)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return httphelp.Config{}, fmt.Errorf("config: key %q must be an absolute http(s) URL", "endpoint")
		}
		cfg.Endpoint = strings.TrimRight(endpoint, "/")
	}
	if value, ok := raw["headers"]; ok {
		var headers map[string]string
		if err := json.Unmarshal(value, &headers); err != nil {
			return httphelp.Config{}, fmt.Errorf("config: key %q must be an object of string values", "headers")
		}
		cfg.Headers = headers
	}
	if value, ok := raw["insecureSkipTLS"]; ok {
		var insecure bool
		if err := json.Unmarshal(value, &insecure); err != nil {
			return httphelp.Config{}, fmt.Errorf("config: key %q must be a boolean", "insecureSkipTLS")
		}
		cfg.InsecureSkipTLS = insecure
	}
	return cfg, nil
}

// unsupported builds the result — and error — for a query shape the
// connector does not serve. The result carries the fixed user-facing
// sentence; the error wraps connector.ErrUnsupported so the caller bug can
// be classified programmatically.
func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// notConfigured reports the missing API key as data: the provider is
// configured but has no credential to send.
func notConfigured() *connector.QueryResult {
	return &connector.QueryResult{State: connector.StateNotConfigured, Reason: reasonCredentials}
}

// queryError converts a backend failure into its sanitized result: the
// State classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract.
func queryError(err error) *connector.QueryResult {
	state := httphelp.ClassifyState(err)
	return &connector.QueryResult{State: state, Reason: httphelp.ReasonFor(state)}
}
