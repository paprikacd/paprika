package insights

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"time"
)

const maxMetricSeries = 1000
const maxMetricLabels = 128
const maxMetricLabelSamples = 12

func (p *providerClient) metricSeries(ctx context.Context, metricName string, now time.Time) (MetadataResult, error) {
	if p.public.Type != "prometheus" {
		return MetadataResult{}, errors.New("series inspection requires a Prometheus provider")
	}
	if !validPromMetric.MatchString(metricName) {
		return MetadataResult{}, errors.New("select a valid metric name")
	}
	start, end := now.Add(-24*time.Hour).Unix(), now.Unix()
	params := url.Values{
		"match[]": {metricName}, "limit": {strconv.Itoa(maxMetricSeries + 1)},
		"start": {strconv.FormatInt(start, 10)}, "end": {strconv.FormatInt(end, 10)},
	}
	body, err := p.fetch(ctx, "/api/v1/series", params, 1<<20)
	if err != nil {
		return MetadataResult{}, err
	}
	var response struct {
		Status    string              `json:"status"`
		Data      []map[string]string `json:"data"`
		Warnings  []string            `json:"warnings"`
		Truncated bool                `json:"truncated"`
	}
	if json.Unmarshal(body, &response) != nil || response.Status != "success" || response.Data == nil {
		return MetadataResult{}, errUpstream
	}
	// Upstream warnings may describe partial data. Treat counts conservatively;
	// never forward upstream messages, URLs, or credentials to the browser.
	stats := &MetricSeriesMetadata{Limit: maxMetricSeries, Start: start, End: end, Truncated: response.Truncated || len(response.Warnings) > 0, Labels: []MetricLabelMetadata{}}
	if err := collectMetricSeries(response.Data, stats); err != nil {
		return MetadataResult{}, err
	}
	sort.Slice(stats.Labels, func(i, j int) bool { return stats.Labels[i].Name < stats.Labels[j].Name })
	return MetadataResult{Values: []string{}, Series: stats}, nil
}

func collectMetricLabels(series map[string]string, labels map[string]map[string]bool, stats *MetricSeriesMetadata) {
	for name, value := range series {
		if name == "__name__" {
			continue
		}
		if len(name) > 128 || len(labels) >= maxMetricLabels && labels[name] == nil {
			stats.LabelsTruncated = true
			continue
		}
		if labels[name] == nil {
			labels[name] = make(map[string]bool)
		}
		labels[name][value] = true
	}
}

func metricLabelsMetadata(labels map[string]map[string]bool) []MetricLabelMetadata {
	result := make([]MetricLabelMetadata, 0, len(labels))
	for name, distinct := range labels {
		label := MetricLabelMetadata{Name: name, Cardinality: len(distinct), Values: []string{}}
		for value := range distinct {
			if len(value) <= 256 {
				label.Values = append(label.Values, value)
			}
		}
		sort.Strings(label.Values)
		if len(label.Values) > maxMetricLabelSamples {
			label.Values = label.Values[:maxMetricLabelSamples]
		}
		label.ValuesTruncated = len(label.Values) < label.Cardinality
		result = append(result, label)
	}
	return result
}

func collectMetricSeries(rows []map[string]string, stats *MetricSeriesMetadata) error {
	seen := make(map[string]bool)
	labels := make(map[string]map[string]bool)
	for _, series := range rows {
		if len(series) == 0 {
			return errUpstream
		}
		encoded, err := json.Marshal(series) // map keys are sorted: duplicates count once.
		if err != nil {
			return errUpstream
		}
		if seen[string(encoded)] {
			continue
		}
		seen[string(encoded)] = true
		if stats.Count >= maxMetricSeries {
			stats.Truncated = true
			break
		}
		stats.Count++
		collectMetricLabels(series, labels, stats)
	}
	stats.Labels = metricLabelsMetadata(labels)
	return nil
}
