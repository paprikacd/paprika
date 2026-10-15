// Shared helpers for the vultrmonitoring connector: strict configuration
// parsing with the vendor endpoint as default, the metric catalog the
// explorer enumerates, and the result/error builders every connector
// package keeps locally.
package vultrmonitoring

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Fixed sentences the results carry; raw error text never reaches them.
const (
	reasonCredentials   = "a Vultr API key credential is required" //nolint:gosec // G101: a fixed status message, not a credential.
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
	var raw map[string]json.RawMessage
	if len(bytes.TrimSpace(config)) > 0 {
		if err := json.Unmarshal(config, &raw); err != nil {
			return httphelp.Config{}, fmt.Errorf("config: invalid JSON document: %w", err)
		}
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	if _, present := raw["endpoint"]; !present {
		raw["endpoint"] = json.RawMessage(strconv.Quote(defaultEndpoint))
	}
	normalized, err := json.Marshal(raw)
	if err != nil {
		return httphelp.Config{}, fmt.Errorf("config: encoding configuration: %w", err)
	}
	// Reuse the strict endpoint/header rules so the vendor default cannot
	// bypass inline-credential, header-injection or request-size protections.
	cfg, err := httphelp.ParseConfig(normalized)
	if err != nil {
		return httphelp.Config{}, fmt.Errorf("config: %w", err)
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
