package insights

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
)

const maxTraceSpans = 500

type tempoAttribute struct {
	Key   string `json:"key"`
	Value struct {
		String string          `json:"stringValue"`
		Int    json.RawMessage `json:"intValue"`
	} `json:"value"`
}
type tempoSpan struct {
	TraceID    string           `json:"traceId"`
	SpanID     string           `json:"spanId"`
	Parent     string           `json:"parentSpanId"`
	Name       string           `json:"name"`
	Attributes []tempoAttribute `json:"attributes"`
	Start      string           `json:"startTimeUnixNano"`
	End        string           `json:"endTimeUnixNano"`
	Status     struct {
		Code json.RawMessage `json:"code"`
	} `json:"status"`
}
type tempoBatch struct {
	Resource struct {
		Attributes []tempoAttribute `json:"attributes"`
	} `json:"resource"`
	Scopes []struct {
		Spans []tempoSpan `json:"spans"`
	} `json:"scopeSpans"`
}

// Only low-cardinality semantic dimensions are forwarded. Traces can contain
// authorization headers, SQL literals, user identifiers and other secrets;
// neither arbitrary keys nor unbounded values belong in the dashboard API.
var safeSpanDimensions = map[string]bool{
	"http.request.method": true, "http.method": true,
	"http.response.status_code": true, "http.status_code": true,
	"http.flavor": true, "network.protocol.version": true,
	"rpc.grpc.status_code": true,
	"db.system":            true, "db.system.name": true, "db.operation.name": true,
	"rpc.system":       true,
	"messaging.system": true, "messaging.operation.type": true,
	"network.protocol.name": true, "network.transport": true,
}

func safeDimensionText(key, value string) bool {
	// Restrict values as well as keys: an instrumentation bug can put a token
	// into a normally safe key. Unknown values are omitted rather than guessed.
	var allowed []string
	switch key {
	case "http.request.method", "http.method":
		allowed = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "_OTHER"}
	case "db.system", "db.system.name":
		allowed = []string{"postgresql", "mysql", "mariadb", "redis", "mongodb", "mssql", "sqlite", "cassandra", "elasticsearch", "dynamodb", "oracle", "other_sql"}
	case "db.operation.name":
		allowed = []string{"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "GET", "SET", "MGET", "MSET"}
	case "rpc.system":
		allowed = []string{"grpc", "connect_rpc", "java_rmi", "dotnet_wcf", "apache_dubbo"}
	case "messaging.system":
		allowed = []string{"kafka", "rabbitmq", "pulsar", "nats", "aws_sqs", "gcp_pubsub", "activemq"}
	case "messaging.operation.type":
		allowed = []string{"create", "send", "receive", "process", "settle"}
	case "network.protocol.name":
		allowed = []string{"http", "grpc", "tcp", "udp", "dns", "amqp", "mqtt"}
	case "http.flavor", "network.protocol.version":
		allowed = []string{"1.0", "1.1", "2", "2.0", "3", "3.0"}
	case "network.transport":
		allowed = []string{"tcp", "udp", "pipe", "unix", "quic"}
	}
	return slices.Contains(allowed, value)
}

func safeSpanAttributeValue(attribute *tempoAttribute) (string, bool) {
	value := attribute.Value.String
	switch attribute.Key {
	case "http.response.status_code", "http.status_code", "rpc.grpc.status_code":
		if len(attribute.Value.Int) > 0 {
			value = strings.Trim(string(attribute.Value.Int), `"`)
		}
		code, err := strconv.Atoi(value)
		valid := code >= 100 && code <= 599
		if attribute.Key == "rpc.grpc.status_code" {
			valid = code >= 0 && code <= 16
		}
		return strconv.Itoa(code), err == nil && valid
	default:
		return value, safeDimensionText(attribute.Key, value)
	}
}

func safeSpanAttributes(input []tempoAttribute) (output []TraceAttribute, omitted int) {
	const maxAttributes = 8
	seen := make(map[string]bool)
	for _, attribute := range input {
		if !safeSpanDimensions[attribute.Key] || seen[attribute.Key] || len(output) == maxAttributes {
			omitted++
			continue
		}
		value, valid := safeSpanAttributeValue(&attribute)
		if !valid {
			omitted++
			continue
		}
		seen[attribute.Key] = true
		output = append(output, TraceAttribute{Key: attribute.Key, Value: value})
	}
	return output, omitted
}

func tempoID(value string, size int) (string, bool) {
	if raw, err := hex.DecodeString(value); err == nil && len(raw) == size {
		return strings.ToLower(value), true
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(raw) != size {
		return "", false
	}
	return hex.EncodeToString(raw), true
}

func traceText(value string) string {
	runes := []rune(value)
	if len(runes) > 160 {
		return string(runes[:160])
	}
	return value
}

func tempoService(batch *tempoBatch) string {
	for _, attribute := range batch.Resource.Attributes {
		if attribute.Key == "service.name" {
			return traceText(attribute.Value.String)
		}
	}
	return ""
}

func tempoSpanStatus(code json.RawMessage) string {
	switch string(code) {
	case `"STATUS_CODE_OK"`, `1`:
		return "ok"
	case `"STATUS_CODE_ERROR"`, `2`:
		return "error"
	default:
		return "unknown"
	}
}

func normalizeTempoSpan(span *tempoSpan, requested string) (TraceSpan, error) {
	traceID, valid := tempoID(span.TraceID, 16)
	id, idValid := tempoID(span.SpanID, 8)
	parent, parentValid := "", true
	if span.Parent != "" {
		parent, parentValid = tempoID(span.Parent, 8)
	}
	start, startErr := strconv.ParseUint(span.Start, 10, 64)
	end, endErr := strconv.ParseUint(span.End, 10, 64)
	if !valid || !strings.EqualFold(traceID, requested) || !idValid || !parentValid {
		return TraceSpan{}, errUpstream
	}
	if startErr != nil || endErr != nil || end < start {
		return TraceSpan{}, errUpstream
	}
	return TraceSpan{SpanID: id, ParentSpanID: parent, StartTime: float64(start) / 1e6, DurationMs: float64(end-start) / 1e6}, nil
}

func appendTempoBatch(result *QueryResult, batch *tempoBatch, requested string, seen map[string]bool) error {
	service := tempoService(batch)
	for i := range batch.Scopes {
		scope := &batch.Scopes[i]
		for j := range scope.Spans {
			raw := &scope.Spans[j]
			span, err := normalizeTempoSpan(raw, requested)
			if err != nil || seen[span.SpanID] {
				return errUpstream
			}
			seen[span.SpanID] = true
			if len(result.Spans) >= maxTraceSpans {
				result.Truncated = true
				continue
			}
			span.Service = service
			span.Operation = traceText(raw.Name)
			span.Status = tempoSpanStatus(raw.Status.Code)
			span.Attributes, span.AttributesOmitted = safeSpanAttributes(raw.Attributes)
			result.Spans = append(result.Spans, span)
		}
	}
	return nil
}

func decodeTempoDetail(body []byte, requested string) (QueryResult, error) {
	var response struct {
		Batches   []tempoBatch `json:"batches"`
		Resources []tempoBatch `json:"resourceSpans"`
	}
	if json.Unmarshal(body, &response) != nil {
		return QueryResult{}, errUpstream
	}
	response.Batches = append(response.Batches, response.Resources...)
	if response.Batches == nil {
		return QueryResult{}, errUpstream
	}
	result := QueryResult{Spans: make([]TraceSpan, 0)}
	seen := make(map[string]bool)
	for i := range response.Batches {
		if err := appendTempoBatch(&result, &response.Batches[i], requested, seen); err != nil {
			return QueryResult{}, err
		}
	}
	return result, nil
}
