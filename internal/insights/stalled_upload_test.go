package insights

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
// of a body, then the body never finishes. They hold document-read slots, so one
// fewer than the read pool runs first: the check slots and the read pool both stay
// free, and a normal dry run and a checked save must still succeed.
func TestStalledUploadsHoldNoCheckSlot(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := dashboard("demo", "Clean")
	const stalled = maxActiveDashboardChecks
	require.Less(t, stalled, cap(s.documentReads))
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
	// Every stalled request reaches its body read and is still waiting there: none
	// has returned, so none can have failed fast, and none holds a check slot.
	for i, signal := range started {
		select {
		case <-signal:
		case <-finished[i]:
			t.Fatalf("stalled upload %d returned before its body finished", i)
		case <-time.After(5 * time.Second):
			t.Fatalf("stalled upload %d never reached its body read", i)
		}
	}
	for i := range finished {
		select {
		case <-finished[i]:
			t.Fatalf("stalled upload %d returned before the probe", i)
		default:
		}
	}
	require.Zero(t, len(s.checkSlots), "stalled uploads hold no check slot")

	dry := request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil)
	require.Equal(t, 200, dry.Code, "a normal dry run is not refused behind stalled uploads: %s", dry.Body)
	saved := request(t, h, "PUT", "/api/dashboards/demo?checks=true", document, map[string]string{"If-None-Match": "*"})
	require.Equal(t, 200, saved.Code, "a checked save is not refused behind stalled uploads: %s", saved.Body)
	require.Contains(t, saved.Body.String(), `"checks"`)
}

// A max-size dry run whose variables object holds tiny members is refused while the
// slots are full, and refusing it costs about its own bytes. The body is read before
// a slot is taken and the envelope is decoded only once one is held, so the refusal
// never builds the map, which at this size is several times the body.
func TestRefusedMaxSizeVariablesAllocateAboutTheirSize(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	for range cap(s.checkSlots) {
		s.checkSlots <- struct{}{}
	}
	var b strings.Builder
	b.WriteString(`{"document":`)
	b.Write(dashboard("demo", "Clean"))
	b.WriteString(`,"variables":{`)
	for i := 0; ; i++ {
		member := fmt.Sprintf(`"k%06d":""`, i)
		if b.Len()+len(member)+2 > maxCheckRequestBytes {
			break
		}
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(member)
	}
	b.WriteString(`}}`)
	body := []byte(b.String())
	require.LessOrEqual(t, len(body), maxCheckRequestBytes, "the body is within the request limit")
	require.Greater(t, len(body), maxCheckRequestBytes-32, "and fills it")

	w, allocated := measured(t, func() *httptest.ResponseRecorder {
		return request(t, h, "POST", "/api/dashboards/validate", body, nil)
	})
	require.Equal(t, http.StatusTooManyRequests, w.Code, "a full pool refuses it: %.200s", w.Body)
	if !raceEnabled {
		// Reading the body with io.ReadAll takes a few times its size in buffer growth.
		// Decoding its 40k members as a map takes about 6 MB on top of that.
		require.Less(t, allocated, uint64(4*len(body)), "a refused dry run allocated %d bytes for a %d byte body", allocated, len(body))
	}
	for range cap(s.checkSlots) {
		<-s.checkSlots
	}
}
