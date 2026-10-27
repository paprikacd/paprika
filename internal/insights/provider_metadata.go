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

func (p *providerClient) metadata(ctx context.Context, kind, label, metricName string) (MetadataResult, error) {
	if p.public.Type != "prometheus" && p.public.Type != "tempo" {
		return MetadataResult{}, errors.New("metric label discovery is unavailable for this provider; use its documented operations or SQL schema")
	}
	key := kind + "\x00" + label + "\x00" + metricName
	now := time.Now()
	p.metadataMu.Lock()
	if entry, ok := p.metadataCache[key]; ok && now.Before(entry.expires) {
		p.metadataMu.Unlock()
		return cloneMetadata(entry.result), nil
	}
	p.metadataMu.Unlock()
	if kind == "series" {
		result, err := p.metricSeries(ctx, metricName, now)
		if err == nil {
			p.cacheMetadata(key, result, now)
		}
		return result, err
	}
	path, params, err := metadataRequest(p.public.Type, kind, label, metricName)
	if err != nil {
		return MetadataResult{}, err
	}
	params.Set("start", strconv.FormatInt(now.Add(-24*time.Hour).Unix(), 10))
	params.Set("end", strconv.FormatInt(now.Unix(), 10))
	body, err := p.fetch(ctx, path, params, 1<<20)
	if err != nil {
		return MetadataResult{}, err
	}
	values, truncated, err := decodeMetadata(body, p.public.Type, kind)
	if err != nil {
		return MetadataResult{}, err
	}
	result := normalizeMetadata(values, truncated)
	p.cacheMetadata(key, result, now)
	return result, nil
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
			_, err := p.query(ctx, Query{ProviderID: p.public.ID, Kind: "records", Query: expression, Start: now - 60, End: now, Step: 1})
			return err
		}
		_, err := p.metadata(ctx, "labels", "", "")
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

func metadataRequest(providerType, kind, label, metricName string) (string, url.Values, error) {
	params := url.Values{"limit": {strconv.Itoa(maxMetadataValues + 1)}}
	if providerType != "prometheus" {
		path, err := tempoMetadataPath(kind, label)
		return path, params, err
	}
	path, err := prometheusMetadataPath(kind, label)
	if err != nil {
		return "", nil, err
	}
	if metricName != "" {
		if !validPromMetric.MatchString(metricName) {
			return "", nil, errors.New("select a valid metric name")
		}
		params.Set("match[]", metricName)
	}
	return path, params, nil
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
