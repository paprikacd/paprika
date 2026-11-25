package insights

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A direct provider's failure is classified by its status and bounded errorType.
// The provider's text never reaches the classification, the response or a receipt.
func TestDirectProviderFailuresClassifyByStatusAndErrorType(t *testing.T) {
	const secret = "PRIVATE-PROVIDER-DETAIL"
	cases := []struct {
		name      string
		status    int
		body      string
		code      string
		transient bool
	}{
		{"400 bad_data is invalid_query", http.StatusBadRequest, `{"status":"error","errorType":"bad_data","error":"` + secret + `"}`, "invalid_query", false},
		{"422 execution is invalid_query", http.StatusUnprocessableEntity, `{"status":"error","errorType":"execution","error":"` + secret + `"}`, "invalid_query", false},
		{"503 errorType timeout is timeout", http.StatusServiceUnavailable, `{"status":"error","errorType":"timeout","error":"` + secret + `"}`, "timeout", false},
		{"500 is a provider_error finding, not transient", http.StatusInternalServerError, secret, "provider_error", false},
		{"502 HTML is provider_error and transient", http.StatusBadGateway, "<html>" + secret + "</html>", "provider_error", true},
		{"401 is forbidden", http.StatusUnauthorized, secret, "forbidden", false},
		{"403 is forbidden", http.StatusForbidden, secret, "forbidden", false},
		{"429 is rate_limited", http.StatusTooManyRequests, secret, "rate_limited", false},
		{"504 is timeout", http.StatusGatewayTimeout, secret, "timeout", false},
		{"200 status:error bad_data is invalid_query", http.StatusOK, `{"status":"error","errorType":"bad_data","error":"` + secret + `"}`, "invalid_query", false},
		{"200 status:error with an unlisted errorType is provider_error", http.StatusOK, `{"status":"error","errorType":"` + secret + `"}`, "provider_error", false},
		{"200 garbage is provider_error", http.StatusOK, "garbage " + secret, "provider_error", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer upstream.Close()
			p := promProvider(t, upstream.URL)
			_, err := p.query(context.Background(), &Query{ProviderID: "metrics", Query: "up", Kind: "metrics", Start: 1000, End: 2000, Step: 60})
			if err == nil {
				t.Fatal("query succeeded, want a failure")
			}
			failure := classifyQueryFailure(err)
			if failure.Code != tc.code || failure.transient != tc.transient {
				t.Fatalf("classified %q transient %v, want %q transient %v", failure.Code, failure.transient, tc.code, tc.transient)
			}
			if strings.Contains(failure.Message, secret) || strings.Contains(err.Error(), secret) {
				t.Fatalf("provider detail appeared in the failure: %q / %q", failure.Message, err.Error())
			}
		})
	}
}

// Tempo rejects its search limit, then rejects the normal bound too: a rejected query.
func TestTempoRejectedTwiceIsInvalidQuery(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "limit rejected PRIVATE-PROVIDER-DETAIL", http.StatusBadRequest)
	}))
	defer upstream.Close()
	p, err := newProvider(&ProviderConfig{ID: "traces", Name: "Traces", Type: "tempo", URL: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.query(context.Background(), &Query{ProviderID: "traces", Query: "{}", Kind: "traces", Start: 1000, End: 2000})
	if got := classifyQueryFailure(err).Code; got != "invalid_query" {
		t.Fatalf("code = %q, want invalid_query", got)
	}
}

// A provider that does not answer within the client's budget is a timeout, not a
// generic provider error.
func TestDirectProviderTransportTimeoutIsTimeout(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case <-release:
		case <-time.After(5 * time.Second):
		}
	}))
	defer upstream.Close()
	defer close(release)
	p := promProvider(t, upstream.URL)
	p.client.Timeout = 50 * time.Millisecond
	_, err := p.query(context.Background(), &Query{ProviderID: "metrics", Query: "up", Kind: "metrics", Start: 1000, End: 2000, Step: 60})
	if got := classifyQueryFailure(err).Code; got != "timeout" {
		t.Fatalf("code = %q (err %v), want timeout", got, err)
	}
	if !errors.Is(err, errUpstream) {
		t.Fatalf("timeout must still unwrap to the shared upstream failure: %v", err)
	}
}

func TestUnreachableDirectProviderIsProviderError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := upstream.URL
	upstream.Close()
	p := promProvider(t, url)
	_, err := p.query(context.Background(), &Query{ProviderID: "metrics", Query: "up", Kind: "metrics", Start: 1000, End: 2000, Step: 60})
	if got := classifyQueryFailure(err).Code; got != "provider_error" {
		t.Fatalf("code = %q (err %v), want provider_error", got, err)
	}
}

// Every failed query writes a code, with and without a receipt; the status and
// text are unchanged.
func TestWriteQueryFailureAlwaysWritesCode(t *testing.T) {
	err := &providerHTTPError{status: http.StatusBadRequest}
	for _, diagnostics := range []*QueryDiagnostics{nil, {}} {
		recorder := httptest.NewRecorder()
		writeQueryFailure(recorder, err, diagnostics)
		body := recorder.Body.String()
		if recorder.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", recorder.Code)
		}
		if !strings.Contains(body, `"code":"invalid_query"`) {
			t.Fatalf("diagnostics %v: body %s lacks the invalid_query code", diagnostics != nil, body)
		}
	}
}

// The private body of a failed provider never reaches /api/query, with or
// without the receipt header. The code is the only class a caller receives.
func TestQueryFailureBodyNeverEchoesProviderDetail(t *testing.T) {
	const secret = "PRIVATE-PROVIDER-DETAIL"
	cases := []struct {
		name   string
		status int
		body   string
		code   string
	}{
		{"a rejected query", http.StatusBadRequest, `{"status":"error","errorType":"bad_data","error":"` + secret + `"}`, "invalid_query"},
		{"a timed-out provider", http.StatusServiceUnavailable, `{"status":"error","errorType":"timeout","error":"` + secret + `"}`, "timeout"},
		{"a plain provider failure", http.StatusInternalServerError, secret, "provider_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer upstream.Close()
			s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
			for _, headers := range []map[string]string{nil, receiptHeaders()} {
				recorder := request(t, s.Handler(), http.MethodPost, "/api/query", []byte(receiptMetricsRequest), headers)
				body := recorder.Body.String()
				if !strings.Contains(body, `"code":"`+tc.code+`"`) {
					t.Fatalf("receipt header %v: body %s lacks code %s", headers != nil, body, tc.code)
				}
				if strings.Contains(body, secret) {
					t.Fatalf("receipt header %v: provider detail reached the response: %s", headers != nil, body)
				}
			}
		})
	}
}

// The shared path answers a provider that is not configured, or that cannot
// serve the request, with a 503. Both are a named unavailable source, not a
// generic provider error, so they keep their specific failure class.
func TestSharedNotConfiguredAndNotAvailableAreProviderNotFound(t *testing.T) {
	for _, state := range []string{"NotConfigured", "NotAvailable"} {
		_, err := decodeObserveData([]byte(`{"state":"`+state+`"}`), false, maxResponseBytes)
		if err == nil {
			t.Fatalf("%s decoded as success", state)
		}
		failure := classifyQueryFailure(err)
		if failure.Code != "provider_not_found" {
			t.Fatalf("%s classified %q, want provider_not_found", state, failure.Code)
		}
	}
}

// Forbidden is one class for both refusals, so its text names both causes.
func TestForbiddenFailureNamesCallerAndProviderCredentials(t *testing.T) {
	for _, err := range []error{&observeError{http.StatusForbidden, "shared observability provider access denied", 0, ""}, &providerHTTPError{status: http.StatusForbidden}} {
		failure := classifyQueryFailure(err)
		if failure.Code != "forbidden" {
			t.Fatalf("classified %q, want forbidden", failure.Code)
		}
		if !strings.Contains(failure.Message, "caller's permissions") || !strings.Contains(failure.Message, "provider credentials") {
			t.Fatalf("forbidden message %q must name both the caller and the provider credentials", failure.Message)
		}
	}
}

func promProvider(t *testing.T, url string) *providerClient {
	t.Helper()
	p, err := newProvider(&ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: url})
	if err != nil {
		t.Fatalf("newProvider: %v", err)
	}
	return p
}

// The shared path answers a caller's cancellation with 408 and a deadline with
// 504. Only the deadline is a provider timeout; the cancellation keeps its own
// class, which the receipt maps to a cancelled outcome.
func TestObserveDomainCancellationAndDeadlineClassifyApart(t *testing.T) {
	cases := []struct {
		name string
		code string
		want string
	}{
		{"a cancelled shared request is canceled", "canceled", "canceled"},
		{"a deadline-exceeded shared request is timeout", "deadline_exceeded", "timeout"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := observeMCPDomainError(tc.code)
			if got := classifyQueryFailure(err).Code; got != tc.want {
				t.Fatalf("code %q classified %q, want %q", tc.code, got, tc.want)
			}
		})
	}
	if got := classifyObserveStatus(http.StatusRequestTimeout); got == nil || got.Code != "canceled" {
		t.Fatalf("408 classified %+v, want canceled", got)
	}
	if got := classifyObserveStatus(http.StatusGatewayTimeout); got == nil || got.Code != "timeout" {
		t.Fatalf("504 classified %+v, want timeout", got)
	}
}
