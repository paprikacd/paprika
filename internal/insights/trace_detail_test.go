package insights

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const traceFixture = `{"batches":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout"}}]},"scopeSpans":[{"spans":[{"traceId":"ABEiM0RVZneImaq7zN3u/w==","spanId":"AQIDBAUGBwg=","name":"GET /checkout","startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000100000000","status":{"code":"STATUS_CODE_OK"}},{"traceId":"ABEiM0RVZneImaq7zN3u/w==","spanId":"AQIDBAUGBwk=","parentSpanId":"AQIDBAUGBwg=","name":"db query","startTimeUnixNano":"1700000000010000000","endTimeUnixNano":"1700000000050000000","status":{"code":"STATUS_CODE_ERROR"}}]}]}]}`

func TestTempoTraceDetailThroughQuery(t *testing.T) {
	const traceID = "00112233445566778899aabbccddeeff"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/traces/"+traceID {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.URL.RawQuery != "" {
			t.Errorf("trace lookup must not narrow results to dashboard time bounds: %s", r.URL.RawQuery)
		}
		_, _ = io.WriteString(w, traceFixture)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Traces", Type: "tempo", URL: upstream.URL})
	w := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"tempo","kind":"traces","query":"{}","traceId":"`+traceID+`","start":1700000000.25,"end":1700000600.75}`), nil)
	if w.Code != 200 {
		t.Fatalf("query %d: %s", w.Code, w.Body)
	}
	var result QueryResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Spans) != 2 || result.Spans[0].SpanID != "0102030405060708" || result.Spans[1].ParentSpanID != result.Spans[0].SpanID || result.Spans[1].DurationMs != 40 || result.Spans[1].Status != "error" {
		t.Fatalf("unexpected spans: %+v", result.Spans)
	}
	bad := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"tempo","kind":"traces","query":"{}","traceId":"../../secret","start":1700000000,"end":1700000600}`), nil)
	if bad.Code != 400 {
		t.Fatalf("unsafe trace id: %d", bad.Code)
	}
}

func TestTempoSpanAttributesAreBoundedAndSensitiveFieldsAreWithheld(t *testing.T) {
	var attributes []tempoAttribute
	data := `[
		{"key":"http.request.method","value":{"stringValue":"GET"}},
		{"key":"http.response.status_code","value":{"intValue":"200"}},
		{"key":"db.system.name","value":{"stringValue":"postgresql"}},
		{"key":"db.operation.name","value":{"stringValue":"SELECT"}},
		{"key":"http.request.header.authorization","value":{"stringValue":"Bearer confidential"}},
		{"key":"db.query.text","value":{"stringValue":"SELECT secret"}},
		{"key":"http.method","value":{"stringValue":"secret-token"}},
		{"key":"http.status_code","value":{"intValue":"700"}},
		{"key":"rpc.system","value":{"stringValue":"grpc"}},
		{"key":"network.transport","value":{"stringValue":"tcp"}},
		{"key":"network.protocol.name","value":{"stringValue":"http"}},
		{"key":"messaging.system","value":{"stringValue":"kafka"}},
		{"key":"messaging.operation.type","value":{"stringValue":"send"}}
	]`
	if err := json.Unmarshal([]byte(data), &attributes); err != nil {
		t.Fatal(err)
	}
	got, omitted := safeSpanAttributes(attributes)
	if len(got) != 8 || omitted != 5 {
		t.Fatalf("got %d attributes and %d omitted: %+v", len(got), omitted, got)
	}
	if got[1].Key != "http.response.status_code" || got[1].Value != "200" {
		t.Fatalf("status code not decoded: %+v", got)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"confidential", "secret", "authorization", "db.query.text"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("sensitive content leaked: %s", encoded)
		}
	}
}

func TestTempoDetailNormalizesRecordedAttributes(t *testing.T) {
	body := strings.Replace(traceFixture, `"name":"GET /checkout",`, `"name":"GET /checkout","attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.response.status_code","value":{"intValue":"200"}},{"key":"http.request.header.authorization","value":{"stringValue":"Bearer confidential"}}],`, 1)
	result, err := decodeTempoDetail([]byte(body), "00112233445566778899aabbccddeeff")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Spans) != 2 || len(result.Spans[0].Attributes) != 2 || result.Spans[0].AttributesOmitted != 1 {
		t.Fatalf("unexpected normalized attributes: %+v", result.Spans)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "confidential") || strings.Contains(string(encoded), "authorization") {
		t.Fatal("sensitive raw span attribute escaped normalization")
	}
}

func TestTempoSpanProtocolDimensionsAcceptOnlyBoundedValues(t *testing.T) {
	var attributes []tempoAttribute
	data := `[
		{"key":"rpc.grpc.status_code","value":{"intValue":"0"}},
		{"key":"http.flavor","value":{"stringValue":"1.1"}},
		{"key":"network.protocol.version","value":{"stringValue":"2"}},
		{"key":"rpc.grpc.status_code","value":{"intValue":"17"}},
		{"key":"network.protocol.version","value":{"stringValue":"secret-token"}},
		{"key":"http.url","value":{"stringValue":"https://example.invalid/?token=secret"}}
	]`
	if err := json.Unmarshal([]byte(data), &attributes); err != nil {
		t.Fatal(err)
	}
	got, omitted := safeSpanAttributes(attributes)
	if len(got) != 3 || omitted != 3 {
		t.Fatalf("unexpected allowed/omitted attributes: %+v, %d", got, omitted)
	}
	if got[0].Key != "rpc.grpc.status_code" || got[0].Value != "0" || got[1].Value != "1.1" || got[2].Value != "2" {
		t.Fatalf("unexpected safe protocol dimensions: %+v", got)
	}
	// Invalid status must be rejected even when it appears before a valid one.
	if err := json.Unmarshal([]byte(`[{"key":"rpc.grpc.status_code","value":{"intValue":"17"}},{"key":"rpc.grpc.status_code","value":{"intValue":"16"}}]`), &attributes); err != nil {
		t.Fatal(err)
	}
	got, omitted = safeSpanAttributes(attributes)
	if len(got) != 1 || got[0].Value != "16" || omitted != 1 {
		t.Fatalf("invalid gRPC status was not withheld: %+v, %d", got, omitted)
	}
	if err := json.Unmarshal([]byte(`[{"key":"network.protocol.version","value":{"stringValue":"secret-token"}},{"key":"network.protocol.version","value":{"stringValue":"3"}}]`), &attributes); err != nil {
		t.Fatal(err)
	}
	got, omitted = safeSpanAttributes(attributes)
	if len(got) != 1 || got[0].Value != "3" || omitted != 1 {
		t.Fatalf("unrecognized version was not withheld: %+v, %d", got, omitted)
	}
}

func TestTempoDetailRejectsWrongTraceAndInvalidTimings(t *testing.T) {
	if _, err := decodeTempoDetail([]byte(traceFixture), "ffffffffffffffffffffffffffffffff"); err == nil {
		t.Fatal("wrong trace accepted")
	}
	if _, err := decodeTempoDetail([]byte(`{"batches":[{"scopeSpans":[{"spans":[{"traceId":"00112233445566778899aabbccddeeff","spanId":"0102030405060708","startTimeUnixNano":"100","endTimeUnixNano":"99"}]}]}]}`), "00112233445566778899aabbccddeeff"); err == nil {
		t.Fatal("negative duration accepted")
	}
}

func TestTraceDetailUsesDelegatedProviderAuthorization(t *testing.T) {
	const traceID = "00112233445566778899aabbccddeeff"
	var calls int
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			providers := []observeCatalogProvider{}
			if r.Header.Get("Authorization") == "Bearer alice" {
				providers = append(providers, observeCatalogProvider{Name: "prod/tempo", Namespace: "prod", Type: "tempo"})
			}
			writeJSON(w, 200, map[string]any{"providers": providers})
		case "/query_traces":
			calls++
			if r.Header.Get("Authorization") != "Bearer alice" {
				t.Fatal("caller token not forwarded")
			}
			var args map[string]any
			if json.NewDecoder(r.Body).Decode(&args) != nil || args["trace_id"] != traceID {
				t.Fatalf("trace ID not forwarded: %+v", args)
			}
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(traceFixture)})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	query := savedQueryJSON(t, Query{ProviderID: observeProviderID("prod/tempo"), Kind: "traces", Query: "{}", TraceID: traceID, Start: 1700000000, End: 1700000600})
	if w := request(t, s.Handler(), http.MethodPost, "/api/query", query, observeHeaders("alice")); w.Code != 200 {
		t.Fatalf("allowed: %d %s", w.Code, w.Body)
	}
	if w := request(t, s.Handler(), http.MethodPost, "/api/query", query, observeHeaders("bob")); w.Code != 404 {
		t.Fatalf("denied: %d %s", w.Code, w.Body)
	}
	if calls != 1 {
		t.Fatalf("unauthorized trace query reached provider: %d", calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := &providerClient{public: Provider{Type: "tempo", Capabilities: []string{"traces"}}}
	if _, started, err := s.runProviderQuery(ctx, p, &Query{}); err == nil || started {
		t.Fatal("canceled query began provider I/O")
	}
}
