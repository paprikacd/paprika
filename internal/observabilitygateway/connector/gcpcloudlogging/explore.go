// Schema exploration for Google Cloud Logging: the log-based metric names
// one project carries, enumerated through the projects.logMetrics.list API.
// A log metric is the way a logs operator names a queryable quantity, so
// metric_names is the only kind "what can I query here" maps onto for this
// backend. Label kinds have no counterpart — log entries carry arbitrary
// JSON payloads, not an enumerable label schema — and metric metadata is
// not part of the logMetrics surface.
//
// The API returns each metric as a full resource name
// (projects/<project>/metrics/<name>); the connector answers with the short
// metric ID — the segment an operator writes into a filter — so the result
// reads like the metric-name lists the reference connectors return. The
// names are unioned client-side across pages and wrapped in the
// {"status":"success","data":[...]} envelope. projects.logMetrics.list
// paginates by nextPageToken; the connector walks every page (capped at
// exploreMaxPages) and applies ExploreRequest.Limit after the union.
package gcpcloudlogging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcommon"
)

// exploreMaxPages bounds every logMetrics walk so one project with thousands
// of metrics cannot paginate indefinitely.
const exploreMaxPages = 20

// CloudLogging satisfies connector.Explorer: projects.logMetrics.list
// enumerates the log-based metric names a project carries.
var _ connector.Explorer = CloudLogging{}

// logMetricsListPage is one projects.logMetrics.list response page.
type logMetricsListPage struct {
	Metrics []struct {
		Name string `json:"name"`
	} `json:"metrics"`
	NextToken string `json:"nextPageToken"`
}

// Explore enumerates one schema slice of the Cloud Logging backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudLogging) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if req.Kind != connector.ExploreMetricNames {
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the gcp-cloudlogging connector", req.Kind))
	}

	cfg, err := gcpcommon.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("gcp-cloudlogging: %w", err)
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
	return exploreMetricNames(ctx, client, cfg, project, req.Prefix, req.Limit), nil
}

// exploreMetricNames unions the short metric IDs of every page of
// projects.logMetrics.list, limited after the union.
func exploreMetricNames(ctx context.Context, client *http.Client, cfg gcpcommon.Config, project, prefix string, limit int) *connector.ExploreResult {
	names := map[string]struct{}{}
	token := ""
	seenTokens := map[string]bool{}
	limited := false
	for page := 0; page < exploreMaxPages; page++ {
		decoded, err := fetchLogMetricsPage(ctx, client, cfg, project, token)
		if err != nil {
			return exploreError(err)
		}
		collectMetricNames(names, &decoded, prefix)
		token = decoded.NextToken
		if limit > 0 && len(names) >= limit {
			limited = token != "" || len(names) > limit
			break
		}
		if token == "" {
			break
		}
		if seenTokens[token] || page == exploreMaxPages-1 {
			return &connector.ExploreResult{State: connector.StateError, Reason: "schema discovery exceeded its pagination bound; narrow the request"}
		}
		seenTokens[token] = true
	}
	if limited {
		return namesResult(sortedKeys(names, limit), "result limit reached; narrow the prefix to discover more names")
	}
	return namesResult(sortedKeys(names, limit))
}

func collectMetricNames(names map[string]struct{}, page *logMetricsListPage, prefix string) {
	for _, metric := range page.Metrics {
		if name := shortMetricName(metric.Name); name != "" && strings.Contains(name, prefix) {
			names[name] = struct{}{}
		}
	}
}

// fetchLogMetricsPage reads one projects.logMetrics.list page; token empty
// reads the first page.
func fetchLogMetricsPage(ctx context.Context, client *http.Client, cfg gcpcommon.Config, project, token string) (logMetricsListPage, error) {
	params := url.Values{"pageSize": []string{strconv.Itoa(maxLimit)}}
	if token != "" {
		params.Set("pageToken", token)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet,
		gcpcommon.URL(cfg, defaultEndpoint, logMetricsPath(project), params), http.NoBody)
	if err != nil {
		// The URL is not echoed: with a validated endpoint and a fixed path
		// this is unreachable, and if it is reached the message must not
		// carry the endpoint.
		return logMetricsListPage{}, errors.New("building backend request: invalid endpoint or path")
	}
	data, err := gcpcommon.Do(httpReq, client)
	if err != nil {
		return logMetricsListPage{}, fmt.Errorf("listing log metrics: %w", err)
	}
	var decoded logMetricsListPage
	if err := json.Unmarshal(data, &decoded); err != nil {
		return logMetricsListPage{}, fmt.Errorf("decoding logMetrics response: %w", err)
	}
	return decoded, nil
}

// logMetricsPath is the per-project projects.logMetrics.list path.
func logMetricsPath(project string) string {
	return "/v2/projects/" + project + "/metrics"
}

// LogMetric.name is a short ID and may itself contain slashes (for example
// nginx/requests). Accept full resource names from compatible proxies too.
func shortMetricName(resource string) string {
	if strings.HasPrefix(resource, "projects/") {
		_, name, _ := strings.Cut(resource, "/metrics/")
		return name
	}
	return resource
}

// sortedKeys returns the set's keys sorted, capped at limit when positive.
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
		}, fmt.Errorf("gcp-cloudlogging: %w", err)
	}
	return &connector.ExploreResult{
		State:  connector.StateForbidden,
		Reason: gcpcommon.ReasonFor(connector.StateForbidden),
	}, fmt.Errorf("gcp-cloudlogging: %w", err)
}
