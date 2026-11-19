package insights

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxMetadataValues = 1000
const metadataCacheBytes = 256 << 10
const metadataTTL = 30 * time.Second

var validPromLabel = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,127}$`)
var validPromMetric = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]{0,255}$`)
var validTempoTag = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$`)

type metadataCacheEntry struct {
	result  MetadataResult
	expires time.Time
	bytes   int
}

// metadataQuery is one metadata lookup. Start and End are Unix seconds. Both zero means the trailing
// 24 hours, and a window is cached at 60 second resolution.
type metadataQuery struct {
	Kind     string
	Label    string
	Metric   string
	Selector string
	Start    int64
	End      int64
}

// maxMetadataWindow bounds how far back a label lookup may reach, so one request cannot ask a provider for a
// whole retention period of series.
const maxMetadataWindow = 31 * 24 * time.Hour

// validSeriesSelector accepts a bare metric name or one brace-enclosed matcher list. A selector is a fixed
// template with values already quoted, so it carries no other syntax.
var validSeriesSelector = regexp.MustCompile(`^(?:[A-Za-z_:][A-Za-z0-9_:]*)?\{[^{}]*\}$|^[A-Za-z_:][A-Za-z0-9_:]*$`)

func (p *providerClient) metadata(ctx context.Context, q *metadataQuery) (MetadataResult, error) {
	if p.public.Type != "prometheus" && p.public.Type != "tempo" {
		return MetadataResult{}, errors.New("metric label discovery is unavailable for this provider; use its documented operations or SQL schema")
	}
	if q.Selector != "" && p.public.Type != "prometheus" {
		return MetadataResult{}, errors.New("a series selector needs a Prometheus provider")
	}
	now := time.Now()
	start, end, window, err := metadataWindow(q, now)
	if err != nil {
		return MetadataResult{}, err
	}
	key := q.Kind + "\x00" + q.Label + "\x00" + q.Metric + "\x00" + q.Selector + "\x00" + window
	if cached, ok := p.cachedMetadata(key, now); ok {
		return cached, nil
	}
	if q.Kind == "series" {
		series, seriesErr := p.metricSeries(ctx, q.Metric, now)
		if seriesErr == nil {
			p.cacheMetadata(key, series, now)
		}
		return series, seriesErr
	}
	result, err := p.fetchMetadata(ctx, q, start, end)
	if err != nil {
		return MetadataResult{}, err
	}
	p.cacheMetadata(key, result, now)
	return result, nil
}

// cachedMetadata returns a live cache entry for key, as a copy.
func (p *providerClient) cachedMetadata(key string, now time.Time) (MetadataResult, bool) {
	p.metadataMu.Lock()
	defer p.metadataMu.Unlock()
	if entry, ok := p.metadataCache[key]; ok && now.Before(entry.expires) {
		return cloneMetadata(entry.result), true
	}
	return MetadataResult{}, false
}

// fetchMetadata asks the provider for one label's values over the window.
func (p *providerClient) fetchMetadata(ctx context.Context, q *metadataQuery, start, end int64) (MetadataResult, error) {
	path, params, err := metadataRequest(p.public.Type, q.Kind, q.Label, q.Metric, q.Selector)
	if err != nil {
		return MetadataResult{}, err
	}
	params.Set("start", strconv.FormatInt(start, 10))
	params.Set("end", strconv.FormatInt(end, 10))
	body, err := p.fetch(ctx, path, params, 1<<20)
	if err != nil {
		return MetadataResult{}, err
	}
	values, truncated, err := decodeMetadata(body, p.public.Type, q.Kind)
	if err != nil {
		return MetadataResult{}, err
	}
	return normalizeMetadata(values, truncated), nil
}

func (p *providerClient) cacheMetadata(key string, result MetadataResult, now time.Time) {
	data, err := json.Marshal(result)
	if err != nil || len(data) > metadataCacheBytes {
		return
	}
	p.metadataMu.Lock()
	defer p.metadataMu.Unlock()
	total := len(data)
	for cached, entry := range p.metadataCache {
		if cached == key || !now.Before(entry.expires) {
			delete(p.metadataCache, cached)
		} else {
			total += entry.bytes
		}
	}
	// Bound the cache even when clients explore arbitrary label combinations.
	for total > metadataCacheBytes || len(p.metadataCache) >= 32 {
		for cached, entry := range p.metadataCache {
			delete(p.metadataCache, cached)
			total -= entry.bytes
			break
		}
	}
	p.metadataCache[key] = metadataCacheEntry{result: cloneMetadata(result), expires: now.Add(metadataTTL), bytes: len(data)}
}

func cloneMetadata(result MetadataResult) MetadataResult {
	result.Values = slices.Clone(result.Values)
	if result.Series != nil {
		series := *result.Series
		series.Labels = slices.Clone(series.Labels)
		for i := range series.Labels {
			series.Labels[i].Values = slices.Clone(series.Labels[i].Values)
		}
		result.Series = &series
	}
	return result
}

func (p *providerClient) testConnection(ctx context.Context) error {
	if p.remote != nil {
		if p.public.supports("records") {
			expression := map[string]string{"shorted": `{"operation":"top_shorts","args":{"limit":1}}`, "uptime": `{"operation":"services","args":{"limit":1}}`, "postgresql": "SELECT 1 AS value"}[p.public.Type]
			now := float64(time.Now().Unix())
			_, err := p.query(ctx, &Query{ProviderID: p.public.ID, Kind: "records", Query: expression, Start: now - 60, End: now, Step: 1})
			return err
		}
		_, err := p.metadata(ctx, &metadataQuery{Kind: "labels"})
		return err
	}
	path := "/api/echo"
	params := url.Values{}
	if p.public.Type == "prometheus" {
		path = "/api/v1/query"
		params.Set("query", "vector(1)")
		params.Set("timeout", "10s")
	}
	body, err := p.fetch(ctx, path, params, 64<<10)
	if err != nil {
		return err
	}
	if p.public.Type == "prometheus" {
		var response struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(body, &response) != nil || response.Status != "success" {
			return errUpstream
		}
	} else if strings.TrimSpace(string(body)) != "echo" {
		return errUpstream
	}
	return nil
}

func normalizeMetadata(values []string, truncated bool) MetadataResult {
	result := MetadataResult{Values: make([]string, 0, min(len(values), maxMetadataValues)), Truncated: truncated}
	seen := make(map[string]bool)
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		if len(value) > 256 || len(result.Values) >= maxMetadataValues {
			result.Truncated = true
			continue
		}
		result.Values = append(result.Values, value)
	}
	sort.Strings(result.Values)
	return result
}

func metadataRequest(providerType, kind, label, metricName, selector string) (string, url.Values, error) {
	params := url.Values{"limit": {strconv.Itoa(maxMetadataValues + 1)}}
	if providerType != "prometheus" {
		path, err := tempoMetadataPath(kind, label)
		return path, params, err
	}
	path, err := prometheusMetadataPath(kind, label)
	if err != nil {
		return "", nil, err
	}
	if selector != "" {
		params.Set("match[]", selector)
		return path, params, nil
	}
	if metricName != "" {
		if !validPromMetric.MatchString(metricName) {
			return "", nil, errors.New("select a valid metric name")
		}
		params.Set("match[]", metricName)
	}
	return path, params, nil
}

// metadataWindow returns the window a lookup covers, its cache key part and any refusal. A selector needs a
// Prometheus provider and cannot be combined with a metric, and an explicit window must be ordered and bounded.
func metadataWindow(q *metadataQuery, now time.Time) (start, end int64, window string, err error) {
	if q.Selector != "" {
		if q.Metric != "" {
			return 0, 0, "", errors.New("use a metric or a selector, not both")
		}
		if len(q.Selector) > 1024 || !validSeriesSelector.MatchString(q.Selector) {
			return 0, 0, "", errors.New("select a valid series selector")
		}
	}
	if q.Start == 0 && q.End == 0 {
		end = now.Unix()
		return now.Add(-24 * time.Hour).Unix(), end, "24h", nil
	}
	if q.Start <= 0 || q.End <= q.Start || time.Duration(q.End-q.Start)*time.Second > maxMetadataWindow {
		return 0, 0, "", errors.New("the metadata window must end after it starts and span at most 31 days")
	}
	return q.Start, q.End, strconv.FormatInt(q.Start/60, 10) + "-" + strconv.FormatInt(q.End/60, 10), nil
}

func prometheusMetadataPath(kind, label string) (string, error) {
	switch kind {
	case "metrics":
		return "/api/v1/label/__name__/values", nil
	case "labels":
		return "/api/v1/labels", nil
	case "values":
		if !validPromLabel.MatchString(label) {
			return "", errors.New("select a valid label name")
		}
		return "/api/v1/label/" + label + "/values", nil
	default:
		return "", errors.New("metadata kind must be metrics, labels, values, or series")
	}
}

func tempoMetadataPath(kind, label string) (string, error) {
	switch kind {
	case "labels":
		return "/api/search/tags", nil
	case "values":
		if !validTempoTag.MatchString(label) {
			return "", errors.New("select a valid trace tag name")
		}
		return "/api/search/tag/" + label + "/values", nil
	default:
		return "", errors.New("tempo metadata supports labels and values")
	}
}

func decodeMetadata(body []byte, providerType, kind string) (values []string, truncated bool, err error) {
	if providerType != "prometheus" {
		return decodeTempoMetadata(body, kind)
	}
	var response struct {
		Status    string   `json:"status"`
		Data      []string `json:"data"`
		Truncated bool     `json:"truncated"`
		Warnings  []string `json:"warnings"`
	}
	if json.Unmarshal(body, &response) != nil || response.Status != "success" {
		return nil, false, errUpstream
	}
	return response.Data, response.Truncated || len(response.Warnings) > 0, nil
}

func decodeTempoMetadata(body []byte, kind string) (values []string, truncated bool, err error) {
	var response struct {
		TagNames  []string        `json:"tagNames"`
		TagValues []string        `json:"tagValues"`
		Error     json.RawMessage `json:"error"`
		Truncated bool            `json:"truncated"`
		Warnings  []string        `json:"warnings"`
	}
	if json.Unmarshal(body, &response) != nil || len(response.Error) > 0 || strings.TrimSpace(string(body)) == "null" {
		return nil, false, errUpstream
	}
	values = response.TagValues
	if kind == "labels" {
		values = response.TagNames
	}
	if values == nil {
		return nil, false, errUpstream
	}
	return values, response.Truncated || len(response.Warnings) > 0, nil
}
