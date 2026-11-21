package observabilitygateway

import (
	"cmp"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

type appTelemetryResult struct {
	State   string             `json:"state"`
	Metrics map[string]float64 `json:"metrics,omitempty"`
	Logs    []appLog           `json:"logs,omitempty"`
}

type appLog struct {
	Timestamp time.Time `json:"timestamp"`
	Line      string    `json:"line"`
	Truncated bool      `json:"truncated,omitempty"`
}

func appTrafficQuery(selector string) string {
	requests := "sum by (tenant,app) (increase(deephost_router_app_http_requests_total{" + selector + "}[24h]))"
	failed := "sum by (tenant,app) (increase(deephost_router_app_http_requests_total{" + selector + ",outcome=\"server_error\"}[24h])) or 0 * " + requests
	buckets := "sum by (tenant,app,le) (increase(deephost_router_app_http_request_duration_seconds_bucket{" + selector + "}[24h]))"
	latency := "histogram_quantile(0.95, " + buckets + ") and (" + requests + " > 0)"
	return fmt.Sprintf(
		`label_replace((%s),"metric","requests_24h","__name__",".*") or label_replace((%s),"metric","server_errors_24h","__name__",".*") or label_replace((%s),"metric","p95_seconds_24h","__name__",".*")`,
		requests, failed, latency,
	)
}

func appTrafficResult(raw json.RawMessage, grant *appTelemetryGrant) appTelemetryResult {
	var payload struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string `json:"metric"`
				Value  []json.RawMessage `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Status != "success" || payload.Data.ResultType != "vector" || len(payload.Data.Result) > 3 {
		return appTelemetryResult{State: "unavailable"}
	}
	values := make(map[string]float64, 3)
	for _, result := range payload.Data.Result {
		key := result.Metric["metric"]
		if !grant.matches(result.Metric) || !appTrafficMetric(key) {
			return appTelemetryResult{State: "unavailable"}
		}
		if _, duplicate := values[key]; duplicate {
			return appTelemetryResult{State: "unavailable"}
		}
		value, ok := appTrafficValue(result.Value)
		if ok {
			values[key] = value
		}
	}
	return appTelemetryResult{State: "ok", Metrics: values}
}

func appTrafficMetric(name string) bool {
	switch name {
	case "requests_24h", "server_errors_24h", "p95_seconds_24h":
		return true
	default:
		return false
	}
}

func appTrafficValue(raw []json.RawMessage) (float64, bool) {
	var sample string
	if len(raw) != 2 || json.Unmarshal(raw[1], &sample) != nil {
		return 0, false
	}
	value, err := strconv.ParseFloat(sample, 64)
	return value, err == nil && !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func appLogsResult(raw json.RawMessage, grant *appTelemetryGrant, window connector.TimeRange) appTelemetryResult {
	var payload struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Stream map[string]string   `json:"stream"`
				Values [][]json.RawMessage `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Status != "success" || payload.Data.ResultType != "streams" {
		return appTelemetryResult{State: "unavailable"}
	}
	entries := make([]appLog, 0, 50)
	returned := 0
	for _, result := range payload.Data.Result {
		if !grant.matches(result.Stream) {
			return appTelemetryResult{State: "unavailable"}
		}
		returned += len(result.Values)
		if returned > 50 {
			return appTelemetryResult{State: "unavailable"}
		}
		for _, value := range result.Values {
			entry, ok := appLogEntry(value, window)
			if ok {
				entries = append(entries, entry)
			}
		}
	}
	slices.SortStableFunc(entries, func(a, b appLog) int {
		return cmp.Compare(b.Timestamp.UnixNano(), a.Timestamp.UnixNano())
	})
	return appTelemetryResult{State: "ok", Logs: entries}
}

func appLogEntry(value []json.RawMessage, window connector.TimeRange) (appLog, bool) {
	var stamp, line string
	if len(value) < 2 || json.Unmarshal(value[0], &stamp) != nil || json.Unmarshal(value[1], &line) != nil {
		return appLog{}, false
	}
	ns, err := strconv.ParseInt(stamp, 10, 64)
	timestamp := time.Unix(0, ns).UTC()
	if err != nil || timestamp.Before(window.Start) || timestamp.After(window.End) {
		return appLog{}, false
	}
	const maxLineBytes = 2048
	if len(line) > maxLineBytes {
		return appLog{Timestamp: timestamp, Line: strings.ToValidUTF8(line[:maxLineBytes], ""), Truncated: true}, true
	}
	return appLog{Timestamp: timestamp, Line: line}, true
}
