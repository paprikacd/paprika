package insights

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestTempoDetailBatchShapeParity(t *testing.T) {
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{}`, false}, {`{"batches":null,"resourceSpans":[]}`, false},
		{`{"batches":[]}`, true}, {`{"resourceSpans":[{}]}`, true},
		{`{"batches":{}}`, false}, {`not json`, false},
	} {
		result, err := decodeTempoDetail([]byte(tc.body), "00112233445566778899aabbccddeeff")
		if (err == nil) != tc.valid {
			t.Fatalf("body %s: err=%v", tc.body, err)
		}
		if tc.valid && result.Spans == nil {
			t.Fatalf("empty accepted response must retain nonnil spans: %s", tc.body)
		}
	}
}

func TestTempoDetailBatchOrderingAndUppercaseRequest(t *testing.T) {
	const id = "00112233445566778899aabbccddeeff"
	body := fmt.Sprintf(`{"batches":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"first"}},{"key":"service.name","value":{"stringValue":"ignored"}}]},"scopeSpans":[{"spans":[{"traceId":%q,"spanId":"0102030405060708","startTimeUnixNano":"100","endTimeUnixNano":"100","status":{"code":1}}]}]}],"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":%q,"spanId":"0102030405060709","startTimeUnixNano":"101","endTimeUnixNano":"102","status":{"code":2}}]}]}]}`, id, id)
	result, err := decodeTempoDetail([]byte(body), strings.ToUpper(id))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Spans) != 2 || result.Spans[0].Service != "first" || result.Spans[0].Status != "ok" || result.Spans[1].Status != "error" || result.Spans[1].Service != "" {
		t.Fatalf("order/service/status changed: %+v", result.Spans)
	}
	duplicate := strings.ReplaceAll(body, "0102030405060709", "0102030405060708")
	if _, err := decodeTempoDetail([]byte(duplicate), id); err == nil {
		t.Fatal("cross-batch duplicate accepted")
	}
}

func TestTempoDetailValidatesBeyondTruncation(t *testing.T) {
	const id = "00112233445566778899aabbccddeeff"
	spans := make([]tempoSpan, maxTraceSpans+1)
	for i := range spans {
		spans[i] = tempoSpan{TraceID: id, SpanID: fmt.Sprintf("%016x", i+1), Start: "100", End: "101"}
	}
	encode := func() []byte {
		t.Helper()
		body, err := json.Marshal(map[string]any{"batches": []any{map[string]any{"scopeSpans": []any{map[string]any{"spans": spans}}}}})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	result, err := decodeTempoDetail(encode(), id)
	if err != nil || !result.Truncated || len(result.Spans) != maxTraceSpans {
		t.Fatalf("truncation changed: len=%d flag=%v err=%v", len(result.Spans), result.Truncated, err)
	}
	spans[maxTraceSpans].SpanID = spans[0].SpanID
	if _, err := decodeTempoDetail(encode(), id); err == nil {
		t.Fatal("duplicate after cap accepted")
	}
	spans[maxTraceSpans].SpanID = fmt.Sprintf("%016x", maxTraceSpans+1)
	spans[maxTraceSpans].End = "99"
	if _, err := decodeTempoDetail(encode(), id); err == nil {
		t.Fatal("invalid timing after cap accepted")
	}
}

func TestTempoAttributeNormalizationParity(t *testing.T) {
	var input []tempoAttribute
	if err := json.Unmarshal([]byte(`[
 {"key":"http.method","value":{"stringValue":"get"}},
 {"key":"http.method","value":{"stringValue":"GET"}},
 {"key":"http.status_code","value":{"stringValue":"200","intValue":"599"}},
 {"key":"http.response.status_code","value":{"intValue":"099"}},
 {"key":"http.response.status_code","value":{"intValue":100}},
 {"key":"rpc.grpc.status_code","value":{"intValue":"-1"}},
 {"key":"rpc.grpc.status_code","value":{"intValue":"016"}},
 {"key":"authorization","value":{"stringValue":"secret"}}
 ]`), &input); err != nil {
		t.Fatal(err)
	}
	got, omitted := safeSpanAttributes(input)
	if omitted != 4 || len(got) != 4 {
		t.Fatalf("unexpected bounds: %+v omitted=%d", got, omitted)
	}
	for i, want := range []string{"GET", "599", "100", "16"} {
		if got[i].Value != want {
			t.Fatalf("value%d=%q want%q", i, got[i].Value, want)
		}
	}
}
