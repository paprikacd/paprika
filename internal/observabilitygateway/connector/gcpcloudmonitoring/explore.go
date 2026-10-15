// Schema exploration for Google Cloud Monitoring: metric names, label keys
// and per-metric descriptors, enumerated through the metricDescriptors.list
// API. Every kind maps onto that one list endpoint with a different filter
// and client-side projection:
//
//   - metric_names pages through the descriptors and unions metric.type,
//     server-scoped by `metric.type = starts_with("<prefix>")` when a Prefix
//     is set, else account-wide.
//   - label_names unions labels[].key across the same descriptors; a Metric
//     constraint selects `metric.type = "<name>"` exactly, a Prefix falls
//     back to the same starts_with scope as metric_names.
//   - metric_metadata fetches the descriptor for one exact metric type and
//     returns it untouched — the native MetricDescriptor JSON carries
//     type, description, unit, metricKind and valueType.
//
// Unions are computed client-side across pages, so names and label keys are
// wrapped in the {"status":"success","data":[...]} envelope the reference
// connectors answer in; the metadata descriptor passes through natively.
//
// Label VALUES are deliberately not served: Cloud Monitoring enumerates
// descriptor label keys but has no API for the values a label takes — those
// live only inside timeSeries data, which is a query, not a schema. The
// connector reports StateNotAvailable rather than inventing an enumeration.
//
// metricDescriptors.list paginates by nextPageToken; the connector walks the
// token (capped at exploreMaxPages pages) and stops early once a positive
// Limit holds enough distinct entries.
package gcpcloudmonitoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcommon"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// exploreMaxPages bounds every metricDescriptors walk so one project with
// thousands of descriptors cannot paginate indefinitely.
const exploreMaxPages = 20

// CloudMonitoring satisfies connector.Explorer: metricDescriptors.list
// enumerates the metric and label schema.
var _ connector.Explorer = CloudMonitoring{}

// descriptorPage is one metricDescriptors.list response page: the raw
// descriptors (metadata passes one through untouched) and the next token.
type descriptorPage struct {
	Descriptors []json.RawMessage `json:"metricDescriptors"`
	NextToken   string            `json:"nextPageToken"`
}

// descriptorType reads the one field every MetricDescriptor carries, used to
// match an exact metric name without projecting away the rest of the
// document.
type descriptorType struct {
	Type string `json:"type"`
}

// Explore enumerates one schema slice of the Cloud Monitoring backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudMonitoring) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if reason := exploreShapeError(req.Kind, req.Metric); reason != "" {
		return exploreUnsupported(reason)
	}

	cfg, err := gcpcommon.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("gcp-cloudmonitoring: %w", err)
	}
	project, err := gcpcommon.ResolveProject(cfg.ProjectID, req.Credentials)
	if err != nil {
		return exploreError(err), nil
	}
	client, err := gcpcommon.Client(ctx, req.Credentials, cfg.InsecureSkipTLS)
	if err != nil {
		result, credErr := exploreCredentialError(err)
		return result, credErr
	}

	switch req.Kind {
	case connector.ExploreMetricNames:
		return exploreMetricNames(ctx, client, cfg, project, req.Prefix, req.Limit), nil
	case connector.ExploreLabelNames:
		return exploreLabelNames(ctx, client, cfg, project, req.Metric, req.Prefix, req.Limit), nil
	case connector.ExploreMetricMetadata:
		// The shape check guaranteed Metric is set.
		return exploreMetricMetadata(ctx, client, cfg, project, req.Metric), nil
	case connector.ExploreLabelValues, connector.ExploreTraceServices:
		return exploreUnsupported(exploreShapeError(req.Kind, req.Metric))
	}
	// Unknown kinds were rejected by the shape check above.
	return exploreUnsupported(exploreShapeError(req.Kind, req.Metric))
}

// exploreShapeError validates the request shape before configuration is
// parsed, mirroring Query's order; a non-empty return names the caller bug.
func exploreShapeError(kind connector.ExploreKind, metric string) string {
	switch kind {
	case connector.ExploreMetricNames, connector.ExploreLabelNames:
		return ""
	case connector.ExploreLabelValues:
		return "cloud monitoring does not enumerate label values; only label keys are enumerable"
	case connector.ExploreMetricMetadata:
		if metric == "" {
			return "a metric name is required"
		}
		return ""
	case connector.ExploreTraceServices:
		return "gcp-cloudmonitoring connector does not enumerate trace services"
	default:
		return fmt.Sprintf("exploration kind %q is not served by the gcp-cloudmonitoring connector", kind)
	}
}

// exploreMetricNames unions metric.type across descriptor pages, scoped by
// `metric.type = starts_with("<prefix>")` when a prefix is set.
func exploreMetricNames(ctx context.Context, client *http.Client, cfg gcpcommon.Config, project, prefix string, limit int) *connector.ExploreResult {
	set := map[string]struct{}{}
	limited := false
	filter := ""
	if prefix != "" {
		filter = fmt.Sprintf(`metric.type = starts_with(%q)`, prefix)
	}
	err := walkDescriptorPages(ctx, client, cfg, project, filter, descriptorPageSize(limit), func(page descriptorPage) bool {
		for _, raw := range page.Descriptors {
			var head descriptorType
			if err := json.Unmarshal(raw, &head); err == nil && head.Type != "" {
				set[head.Type] = struct{}{}
			}
		}
		limited = limit > 0 && len(set) >= limit && (len(set) > limit || page.NextToken != "")
		return limit <= 0 || len(set) < limit
	})
	if err != nil {
		return exploreError(err)
	}
	if limited {
		return namesResult(sortedKeys(set, limit), "result limit reached; narrow the prefix to discover more names")
	}
	return namesResult(sortedKeys(set, limit))
}

// exploreLabelNames unions labels[].key across descriptor pages, scoped to
// an exact metric type when Metric is set, else by the prefix.
func exploreLabelNames(ctx context.Context, client *http.Client, cfg gcpcommon.Config, project, metric, prefix string, limit int) *connector.ExploreResult {
	set := map[string]struct{}{}
	limited := false
	filter := ""
	if metric != "" {
		filter = fmt.Sprintf(`metric.type = %q`, metric)
	} else if prefix != "" {
		filter = fmt.Sprintf(`metric.type = starts_with(%q)`, prefix)
	}
	pageSize := descriptorPageSize(limit)
	if metric != "" {
		pageSize = 1
	}
	err := walkDescriptorPages(ctx, client, cfg, project, filter, pageSize, func(page descriptorPage) bool {
		for _, raw := range page.Descriptors {
			var labels struct {
				Labels []struct {
					Key string `json:"key"`
				} `json:"labels"`
			}
			if err := json.Unmarshal(raw, &labels); err != nil {
				continue
			}
			for _, label := range labels.Labels {
				if label.Key != "" {
					set[label.Key] = struct{}{}
				}
			}
		}
		limited = limit > 0 && len(set) >= limit && (len(set) > limit || page.NextToken != "")
		return limit <= 0 || len(set) < limit
	})
	if err != nil {
		return exploreError(err)
	}
	if limited {
		return namesResult(sortedKeys(set, limit), "result limit reached; select a metric to discover more label names")
	}
	return namesResult(sortedKeys(set, limit))
}

// exploreMetricMetadata returns the native descriptor JSON for one exact
// metric type, or StateNotAvailable when no descriptor matches.
func exploreMetricMetadata(ctx context.Context, client *http.Client, cfg gcpcommon.Config, project, metric string) *connector.ExploreResult {
	filter := fmt.Sprintf(`metric.type = %q`, metric)
	var match json.RawMessage
	err := walkDescriptorPages(ctx, client, cfg, project, filter, 1, func(page descriptorPage) bool {
		for _, raw := range page.Descriptors {
			var head descriptorType
			if err := json.Unmarshal(raw, &head); err != nil {
				continue
			}
			if head.Type == metric {
				match = raw
				return false
			}
		}
		return true
	})
	if err != nil {
		return exploreError(err)
	}
	if match == nil {
		return &connector.ExploreResult{
			State:  connector.StateNotAvailable,
			Reason: "no metric descriptor matches the requested metric name",
		}
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: match}
}

// walkDescriptorPages hands each metricDescriptors.list page to visit,
// stopping early when visit returns false, when the token runs out, or after
// exploreMaxPages pages. Backend and decode errors return wrapped for
// exploreError to classify.
func walkDescriptorPages(ctx context.Context, client *http.Client, cfg gcpcommon.Config, project, filter string, pageSize int, visit func(descriptorPage) bool) error {
	params := url.Values{
		"pageSize": []string{strconv.Itoa(descriptorPageSize(pageSize))},
		"filter":   []string{projectFilter(project, filter)},
	}
	token := ""
	seenTokens := map[string]bool{}
	for page := 0; page < exploreMaxPages; page++ {
		if token != "" {
			params.Set("pageToken", token)
		} else {
			params.Del("pageToken")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			gcpcommon.URL(cfg, defaultEndpoint, metricDescriptorsPath(project), params), http.NoBody)
		if err != nil {
			// The URL is not echoed: with a validated endpoint and a fixed
			// path this is unreachable, and if it is reached the message
			// must not carry the endpoint.
			return errors.New("building backend request: invalid endpoint or path")
		}
		data, err := gcpcommon.Do(req, client)
		if err != nil {
			return fmt.Errorf("listing metric descriptors: %w", err)
		}
		var decoded descriptorPage
		if err := json.Unmarshal(data, &decoded); err != nil {
			return fmt.Errorf("decoding metricDescriptors response: %w", err)
		}
		if !visit(decoded) {
			return nil
		}
		token = decoded.NextToken
		if token == "" {
			return nil
		}
		if seenTokens[token] {
			return errors.New("schema discovery repeated a pagination token")
		}
		seenTokens[token] = true
	}
	return errors.New("schema discovery exceeded its pagination bound")
}

// Descriptor count is a server-side bound, distinct from the number of
// label keys projected from each descriptor. Exact metric lookups use one;
// broader discovery uses the caller's bounded requested result limit.
func descriptorPageSize(limit int) int {
	return httphelp.ClampLimit(limit, defaultLimit, maxLimit)
}

// sortedKeys returns the set's keys sorted, capped at limit when positive so
// the early-stop bound carries through to the caller-visible result.
func sortedKeys(set map[string]struct{}, limit int) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if limit > 0 && len(keys) > limit {
		keys = keys[:limit]
	}
	return keys
}

// namesResult wraps a sorted string set in the {"status":"success",
// "data":[...]} shape the reference connectors answer in, so every
// exploration kind responds in one recognizable envelope.
func namesResult(items []string, warnings ...string) *connector.ExploreResult {
	data, err := json.Marshal(struct {
		Status   string   `json:"status"`
		Data     []string `json:"data"`
		Warnings []string `json:"warnings,omitempty"`
	}{Status: "success", Data: items, Warnings: warnings})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}
}

// exploreUnsupported builds the result — and error — for an exploration kind
// the connector does not serve, mirroring Query's unsupported contract.
func exploreUnsupported(reason string) (*connector.ExploreResult, error) {
	return &connector.ExploreResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// exploreError converts a backend failure into its sanitized result: the
// State classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract. Detail for logs travels in the
// handler's logs, not in the result.
func exploreError(err error) *connector.ExploreResult {
	state := gcpcommon.ClassifyState(err)
	return &connector.ExploreResult{State: state, Reason: gcpcommon.ReasonFor(state)}
}

// exploreCredentialError maps a credential-construction failure onto the
// dual result+error contract: the fixed user-facing sentence travels in the
// result, connector-wrapped sanitized detail in the error for logs. The
// missing-ambient-identity sentence mirrors gcpcommon.reasonNoAmbientCredentials.
func exploreCredentialError(err error) (*connector.ExploreResult, error) {
	if errors.Is(err, gcpcommon.ErrNoAmbientCredentials) {
		return &connector.ExploreResult{
			State:  connector.StateNotConfigured,
			Reason: "no Google credentials are configured; set a credentialsSecretRef or attach Workload Identity",
		}, fmt.Errorf("gcp-cloudmonitoring: %w", err)
	}
	return &connector.ExploreResult{
		State:  connector.StateForbidden,
		Reason: gcpcommon.ReasonFor(connector.StateForbidden),
	}, fmt.Errorf("gcp-cloudmonitoring: %w", err)
}
