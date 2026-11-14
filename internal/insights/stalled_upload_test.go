package insights

import (
	"errors"
	"io"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// signalReader reports the first read of its body, so a test knows the handler has
// reached its body read and is waiting on the rest of the upload.
type signalReader struct {
	r       io.Reader
	started chan struct{}
	once    sync.Once
}

func (s *signalReader) Read(p []byte) (int, error) {
	s.once.Do(func() { close(s.started) })
	return s.r.Read(p)
}

// Stalled uploads hold no check slot. Each request sends its headers and the start
// of a body, then the body never finishes. Twice the slot count of them run first,
// and a normal dry run and a checked save must still succeed.
func TestStalledUploadsHoldNoCheckSlot(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := dashboard("demo", "Clean")
	const stalled = 2 * maxActiveDashboardChecks
	var handlers sync.WaitGroup
	writers := make([]*io.PipeWriter, 0, stalled)
	t.Cleanup(func() {
		for _, pw := range writers {
			_ = pw.CloseWithError(errors.New("test over"))
		}
		handlers.Wait()
	})
	started := make([]chan struct{}, 0, stalled)
	finished := make([]chan struct{}, stalled)
	for i := range finished {
		finished[i] = make(chan struct{})
	}
	for i := range stalled {
		pr, pw := io.Pipe()
		writers = append(writers, pw)
		method, path := "POST", "/api/dashboards/validate"
		if i%2 == 1 {
			method, path = "PUT", "/api/dashboards/demo?checks=true"
		}
		signal := make(chan struct{})
		started = append(started, signal)
		r := httptest.NewRequestWithContext(t.Context(), method, path, &signalReader{r: pr, started: signal})
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set("Content-Type", "application/json")
		go func() { _, _ = pw.Write([]byte(`{"document":{"schemaVersion":1,`)) }()
		handlers.Add(1)
		go func() {
			defer handlers.Done()
			h.ServeHTTP(httptest.NewRecorder(), r)
			close(finished[i])
		}()
	}
	// Each stalled request either reaches its body read or returns on its own, for
	// example with a 429. Only the requests that are still waiting on the body stall.
	for i, signal := range started {
		select {
		case <-signal:
		case <-finished[i]:
		case <-time.After(5 * time.Second):
			t.Fatal("a stalled upload neither reached its body read nor returned")
		}
	}

	dry := request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil)
	require.Equal(t, 200, dry.Code, "a normal dry run is not refused behind stalled uploads: %s", dry.Body)
	saved := request(t, h, "PUT", "/api/dashboards/demo?checks=true", document, map[string]string{"If-None-Match": "*"})
	require.Equal(t, 200, saved.Code, "a checked save is not refused behind stalled uploads: %s", saved.Body)
	require.Contains(t, saved.Body.String(), `"checks"`)
}
