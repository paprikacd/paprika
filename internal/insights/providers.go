package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
)

const (
	maxResponseBytes = 8 << 20
	maxSeries        = 100
	maxPoints        = 5000
	maxTotalPoints   = 100000
	maxTraces        = 100
)

var validID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`)
var validHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

var errUpstream = errors.New("provider query failed; check the query and provider configuration")

type providerClient struct {
	public        Provider
	remote        *observeProvider
	baseURL       *url.URL
	headers       http.Header
	client        *http.Client
	metadataMu    sync.Mutex
	metadataCache map[string]metadataCacheEntry
}

func newProvider(config *ProviderConfig) (*providerClient, error) {
	if err := validateProviderConfigBounds(config); err != nil {
		return nil, err
	}
	capability := "metrics"
	switch config.Type {
	case "prometheus":
	case "tempo":
		capability = "traces"
	default:
		return nil, fmt.Errorf("provider %s has unsupported type", config.ID)
	}
	u, err := url.Parse(config.URL)
	if err != nil || !validProviderBaseURL(u) {
		return nil, fmt.Errorf("provider %s requires an HTTP(S) URL without credentials, query, or fragment", config.ID)
	}
	headers, err := providerHeaders(config)
	if err != nil {
		return nil, err
	}
	transport, err := providerTransport()
	if err != nil {
		return nil, err
	}
	transport.MaxIdleConnsPerHost = 8
	transport.ResponseHeaderTimeout = 15 * time.Second
	return &providerClient{
		public:  Provider{ID: config.ID, Name: config.Name, Type: config.Type, Capabilities: []string{capability}},
		baseURL: u, headers: headers,
		metadataCache: make(map[string]metadataCacheEntry),
		client: &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			// Provider credentials must never follow an upstream redirect.
			return http.ErrUseLastResponse
		}},
	}, nil
}

func validateQuery(q Query) error {
	if q.Kind != "metrics" && q.Kind != "traces" && q.Kind != "records" {
		return errors.New("query kind must be metrics, traces or records")
	}
	if strings.TrimSpace(q.Query) == "" || len(q.Query) > 16384 {
		return errors.New("query must contain between 1 and 16384 bytes")
	}
	return validateQueryRange(q)
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func (p *providerClient) query(ctx context.Context, q Query) (QueryResult, error) {
	if !p.public.supports(q.Kind) {
		return QueryResult{}, errors.New("provider does not support this query kind")
	}
	if p.remote != nil {
		body, err := p.remote.query(ctx, q)
		if err != nil {
			return QueryResult{}, err
		}
		return decodeObserveQuery(q.Kind, body)
	}
	params := url.Values{"start": {strconv.FormatFloat(q.Start, 'f', -1, 64)}, "end": {strconv.FormatFloat(q.End, 'f', -1, 64)}}
	path := "/api/v1/query_range"
	if q.Kind == "metrics" {
		params.Set("query", q.Query)
		params.Set("step", strconv.FormatFloat(q.Step, 'f', -1, 64))
		params.Set("timeout", "15s")
		params.Set("limit", strconv.Itoa(maxSeries))
	} else {
		path = "/api/search"
		params.Set("q", q.Query)
		params.Set("limit", strconv.Itoa(maxTraces))
		// Tempo accepts integer Unix seconds.
		params.Set("start", strconv.FormatInt(int64(q.Start), 10))
		params.Set("end", strconv.FormatInt(int64(q.End), 10))
	}
	body, err := p.fetch(ctx, path, params, maxResponseBytes)
	if err != nil {
		return QueryResult{}, err
	}
	if q.Kind == "metrics" {
		return decodePrometheus(body)
	}
	return decodeTempo(body)
}

func decodeObserveQuery(kind string, body []byte) (QueryResult, error) {
	switch kind {
	case "metrics":
		return decodePrometheus(body)
	case "records":
		frame, err := dataframe.Decode(body)
		if err != nil {
			return QueryResult{}, errUpstream
		}
		return QueryResult{Records: frame, Truncated: frame.Truncated}, nil
	default:
		return decodeTempo(body)
	}
}

func (p *providerClient) fetch(ctx context.Context, path string, params url.Values, limit int64) ([]byte, error) {
	if p.remote != nil {
		return p.remote.metadata(ctx, path, params, limit)
	}
	u := *p.baseURL
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawPath = ""
	u.RawQuery = params.Encode()
	// #nosec G704 -- Provider origins are validated operator configuration; path is internal and redirects are disabled.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), http.NoBody)
	if err != nil {
		return nil, errUpstream
	}
	req.Header = p.headers.Clone()
	req.Header.Set("Accept", "application/json")
	resp, err := p.client.Do(req) // #nosec G704 -- Local provider endpoints are explicitly operator-configured and redirects are disabled.
	if err != nil {
		return nil, errUpstream
	}
	defer closeReadBody(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, errUpstream
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, errUpstream
	}
	return body, nil
}

func decodePrometheus(body []byte) (QueryResult, error) {
	response, err := parsePrometheusMatrix(body)
	if err != nil {
		return QueryResult{}, err
	}
	result := QueryResult{Series: make([]Series, 0, min(len(response.Data.Result), maxSeries)), Truncated: response.Truncated || len(response.Warnings) > 0}
	total := 0
	for _, row := range response.Data.Result {
		if len(result.Series) >= maxSeries || total >= maxTotalPoints {
			result.Truncated = true
			break
		}
		series := Series{Name: seriesName(row.Metric), Labels: row.Metric, Points: make([]Point, 0, min(len(row.Values), maxPoints))}
		for _, pair := range row.Values {
			if len(series.Points) >= maxPoints || total >= maxTotalPoints {
				result.Truncated = true
				break
			}
			point, err := decodePrometheusPoint(pair)
			if err != nil {
				return QueryResult{}, err
			}
			series.Points = append(series.Points, point)
			total++
		}
		result.Series = append(result.Series, series)
	}
	return result, nil
}

func seriesName(labels map[string]string) string {
	name := labels["__name__"]
	keys := make([]string, 0, len(labels))
	for key := range labels {
		if key != "__name__" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+strconv.Quote(labels[key]))
	}
	if len(parts) > 0 {
		name += "{" + strings.Join(parts, ", ") + "}"
	}
	if name == "" {
		return "Value"
	}
	return name
}

func decodeTempo(body []byte) (QueryResult, error) {
	var response struct {
		Warnings  []string `json:"warnings"`
		Truncated bool     `json:"truncated"`
		Metrics   struct {
			CompletedJobs int `json:"completedJobs"`
			TotalJobs     int `json:"totalJobs"`
		} `json:"metrics"`
		Traces []tempoTrace `json:"traces"`
	}
	if json.Unmarshal(body, &response) != nil {
		return QueryResult{}, errUpstream
	}
	result := QueryResult{Traces: make([]Trace, 0, min(len(response.Traces), maxTraces)), Truncated: response.Truncated || len(response.Warnings) > 0 || response.Metrics.TotalJobs > response.Metrics.CompletedJobs}
	for _, row := range response.Traces {
		if len(result.Traces) >= maxTraces {
			result.Truncated = true
			break
		}
		trace, err := decodeTempoTrace(row)
		if err != nil {
			return QueryResult{}, err
		}
		result.Traces = append(result.Traces, trace)
	}
	return result, nil
}

func providerHeaders(config *ProviderConfig) (http.Header, error) {
	headers := make(http.Header)
	if config.BearerTokenEnv != "" {
		token, ok := os.LookupEnv(config.BearerTokenEnv)
		if !ok || strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
			return nil, fmt.Errorf("provider %s bearer-token environment variable is missing or invalid", config.ID)
		}
		headers.Set("Authorization", "Bearer "+token)
	}
	if err := addProviderHeaders(headers, config); err != nil {
		return nil, err
	}
	return headers, nil
}

func addProviderHeaders(headers http.Header, config *ProviderConfig) error {
	seenHeaders := make(map[string]bool)
	for name, env := range config.HeadersEnv {
		canonical := http.CanonicalHeaderKey(name)
		if !validProviderHeader(name, env, canonical) || seenHeaders[canonical] {
			return fmt.Errorf("provider %s has an invalid custom header", config.ID)
		}
		seenHeaders[canonical] = true
		value, ok := os.LookupEnv(env)
		if !ok || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("provider %s header environment variable is missing or invalid", config.ID)
		}
		headers.Set(canonical, value)
	}
	return nil
}

func validProviderHeader(name, env, canonical string) bool {
	if !validHeaderName.MatchString(name) || len(name) > 128 || len(env) > 128 {
		return false
	}
	switch canonical {
	case "Host", "Connection", "Content-Length", "Transfer-Encoding":
		return false
	}
	return true
}

func providerTransport() (*http.Transport, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport must support cloning")
	}
	return base.Clone(), nil
}

func validateQueryRange(q Query) error {
	if !finite(q.Start) || !finite(q.End) || q.Start <= 0 || q.End <= q.Start || q.End-q.Start > 31*24*60*60 {
		return errors.New("query requires an increasing Unix-second range of at most 31 days")
	}
	if q.Kind == "metrics" && (!finite(q.Step) || q.Step < 1 || math.Floor((q.End-q.Start)/q.Step) >= maxPoints) {
		return errors.New("step must be at least 1 second and produce at most 5000 points per series")
	}
	return nil
}

func decodePrometheusPoint(pair [2]json.RawMessage) (Point, error) {
	var timestamp float64
	var value string
	if json.Unmarshal(pair[0], &timestamp) != nil || json.Unmarshal(pair[1], &value) != nil || !finite(timestamp) || !finite(timestamp*1000) {
		return Point{}, errUpstream
	}
	v, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return Point{}, errUpstream
	}
	point := Point{Timestamp: timestamp * 1000}
	// Prometheus legitimately returns NaN/Inf. Null preserves the gap;
	// replacing it with zero would fabricate an observation.
	if finite(v) {
		point.Value = &v
	}
	return point, nil
}

type tempoTrace struct {
	TraceID           string  `json:"traceID"` //nolint:tagliatelle // Tempo search uses this exact upstream field name.
	RootServiceName   string  `json:"rootServiceName"`
	RootTraceName     string  `json:"rootTraceName"`
	StartTimeUnixNano string  `json:"startTimeUnixNano"`
	DurationMs        float64 `json:"durationMs"`
}

func decodeTempoTrace(row tempoTrace) (Trace, error) {
	start, err := strconv.ParseInt(row.StartTimeUnixNano, 10, 64)
	if err != nil || start < 0 || row.TraceID == "" || !finite(row.DurationMs) || row.DurationMs < 0 {
		return Trace{}, errUpstream
	}
	return Trace{TraceID: row.TraceID, Service: row.RootServiceName, Operation: row.RootTraceName,
		DurationMs: row.DurationMs, StartTime: float64(start) / 1e6,
		// Search metadata does not report a trace-wide status.
		Status: "unknown",
	}, nil
}

func validateProviderConfigBounds(config *ProviderConfig) error {
	if !validID.MatchString(config.ID) || trimJS(config.Name) == "" || stringUnits(trimJS(config.Name)) > 120 {
		return errors.New("provider needs a valid id and name")
	}
	if len(config.URL) > 2048 || len(config.BearerTokenEnv) > 128 || len(config.HeadersEnv) > 16 {
		return errors.New("provider configuration exceeds field limits")
	}
	return nil
}

func validProviderBaseURL(u *url.URL) bool {
	return u.Hostname() != "" && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}

type prometheusMatrixResponse struct {
	Status    string   `json:"status"`
	Warnings  []string `json:"warnings"`
	Truncated bool     `json:"truncated"`
	Data      struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string    `json:"metric"`
			Values [][2]json.RawMessage `json:"values"`
		} `json:"result"`
	} `json:"data"`
}

func parsePrometheusMatrix(body []byte) (prometheusMatrixResponse, error) {
	var response prometheusMatrixResponse
	if json.Unmarshal(body, &response) != nil || response.Status != "success" || response.Data.ResultType != "matrix" {
		return response, errUpstream
	}
	return response, nil
}
