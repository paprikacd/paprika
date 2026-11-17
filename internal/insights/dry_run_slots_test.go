package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A dry run with execute holds a check slot only while it decodes the document and
// builds its report. While its queries wait on a slow provider it holds a dry-run
// query slot instead, so checked saves are not refused by provider latency.
func TestExecuteDryRunHoldsNoCheckSlotWhileQuerying(t *testing.T) {
	released := make(chan struct{})
	var calls atomic.Int32
	provider := newBlockingProvider(t, released, &calls)
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	h := s.Handler()
	document := documentOf("demo", dataWidgetJSON("a", "timeseries", "one", "req/s", 0, ""))
	body, err := json.Marshal(map[string]any{"document": json.RawMessage(document), "execute": true})
	require.NoError(t, err)

	done := make(chan int)
	go func() {
		done <- request(t, h, "POST", "/api/dashboards/validate", body, nil).Code
	}()
	require.Eventually(t, func() bool { return calls.Load() == 1 }, 5*time.Second, 5*time.Millisecond, "the query never reached the provider")

	require.Zero(t, len(s.checkSlots), "a dry run waiting on its query holds no check slot")
	require.Equal(t, 1, len(s.dryRunSlots), "the executing dry run holds one query slot")
	save := request(t, h, "PUT", "/api/dashboards/demo?checks=true", []byte(document), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, save.Code, "a checked save is not refused while a dry run queries: %s", save.Body)

	close(released)
	require.Equal(t, http.StatusOK, <-done)
	require.Zero(t, len(s.dryRunSlots), "the query slot is released with the response")
}

// Execute dry runs have their own pool. A full pool refuses them with the same 429
// and retry hint as the check pool, and it leaves the other dry runs and saves alone.
func TestExecuteDryRunsAreRefusedWhenTheirPoolIsFull(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	for range cap(s.dryRunSlots) {
		s.dryRunSlots <- struct{}{}
	}
	document := string(dashboard("demo", "Clean"))
	execute, err := json.Marshal(map[string]any{"document": json.RawMessage(document), "execute": true})
	require.NoError(t, err)

	refused := request(t, h, "POST", "/api/dashboards/validate", execute, nil)
	require.Equal(t, http.StatusTooManyRequests, refused.Code, "execute dry run body %s", refused.Body)
	require.Equal(t, "1", refused.Header().Get("Retry-After"))
	require.Contains(t, refused.Body.String(), "retry shortly")

	require.Equal(t, http.StatusOK, request(t, h, "POST", "/api/dashboards/validate", checkBody(dashboard("demo", "Clean")), nil).Code, "a dry run without execute is not refused")
	require.Equal(t, http.StatusOK, request(t, h, "PUT", "/api/dashboards/demo?checks=true", []byte(document), map[string]string{"If-None-Match": "*"}).Code, "a checked save is not refused")

	for range cap(s.dryRunSlots) {
		<-s.dryRunSlots
	}
	require.Equal(t, http.StatusOK, request(t, h, "POST", "/api/dashboards/validate", execute, nil).Code, "the pool admits again once it is free")
}

// newBlockingProvider answers every query only after released is closed or the
// caller goes away, and counts the queries it receives.
func newBlockingProvider(t *testing.T, released chan struct{}, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-r.Context().Done():
		case <-released:
		}
	}))
	t.Cleanup(server.Close)
	return server
}
