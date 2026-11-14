package insights

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// blockingWriter is a client that has stopped reading. Its first Write blocks until
// unblock is closed, and started is closed when that Write begins.
type blockingWriter struct {
	header  http.Header
	status  int
	started chan struct{}
	once    sync.Once
	unblock chan struct{}
}

func newBlockingWriter() *blockingWriter {
	return &blockingWriter{header: make(http.Header), started: make(chan struct{}), unblock: make(chan struct{})}
}

func (b *blockingWriter) Header() http.Header { return b.header }

func (b *blockingWriter) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *blockingWriter) Write(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	<-b.unblock
	return len(p), nil
}

// A save whose client stops reading must hold neither the mutation lock nor a check
// slot while its response is blocked. A concurrent save to another dashboard must
// complete in that time, and the slot must already be free.
func TestSlowReaderHoldsNeitherLockNorSlot(t *testing.T) {
	for name, path := range map[string]string{
		"unchecked save": "/api/dashboards/demo",
		"checked save":   "/api/dashboards/demo?checks=true",
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := testService(t)
			h := s.Handler()
			require.Equal(t, 200, request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Clean"), map[string]string{"If-None-Match": "*"}).Code)

			slow := newBlockingWriter()
			r := httptest.NewRequestWithContext(t.Context(), "PUT", path, bytes.NewReader(dashboard("demo", "Renamed")))
			r.SetPathValue("id", "demo")
			r.Header.Set("If-Match", "*")
			r.Header.Set("Content-Type", "application/json")
			saved := make(chan struct{})
			go func() {
				defer close(saved)
				s.putDashboard(slow, r)
			}()
			select {
			case <-slow.started:
			case <-time.After(5 * time.Second):
				t.Fatal("the save never wrote its response")
			}
			require.Zero(t, len(s.checkSlots), "a save blocked on a slow reader still holds a check slot")

			concurrent := make(chan int, 1)
			go func() {
				w := httptest.NewRecorder()
				other := httptest.NewRequestWithContext(t.Context(), "PUT", "/api/dashboards/other", bytes.NewReader(dashboard("other", "Clean")))
				other.Header.Set("Authorization", "Bearer "+testToken)
				other.Header.Set("If-None-Match", "*")
				h.ServeHTTP(w, other)
				concurrent <- w.Code
			}()
			select {
			case code := <-concurrent:
				require.Equal(t, 200, code, "a concurrent save was not completed while a slow reader was blocked")
			case <-time.After(5 * time.Second):
				t.Fatal("a concurrent save waited on a slow reader's response")
			}

			close(slow.unblock)
			select {
			case <-saved:
			case <-time.After(5 * time.Second):
				t.Fatal("the blocked save did not finish after its reader resumed")
			}
			require.Equal(t, 200, slow.status)
		})
	}
}

// replay writes exactly what the handler recorded: status, headers and body.
func TestBufferedResponseReplaysStatusHeadersAndBody(t *testing.T) {
	out := &bufferedResponse{}
	out.Header().Set("ETag", `"abc"`)
	out.WriteHeader(http.StatusCreated)
	_, err := out.Write([]byte(`{"ok":true}`))
	require.NoError(t, err)

	w := httptest.NewRecorder()
	out.replay(w)
	require.Equal(t, http.StatusCreated, w.Code)
	require.Equal(t, `"abc"`, w.Header().Get("ETag"))
	require.Equal(t, `{"ok":true}`, w.Body.String())
}

// A save frees its body bytes before its response is written. A client that stops
// reading must not hold the bytes of the document it sent, so while the response write
// is blocked the budget reads zero.
func TestSaveFreesItsBodyBytesBeforeTheResponseWrite(t *testing.T) {
	for name, path := range map[string]string{
		"unchecked save": "/api/dashboards/demo",
		"checked save":   "/api/dashboards/demo?checks=true",
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := testService(t)
			require.Equal(t, 200, request(t, s.Handler(), "PUT", "/api/dashboards/demo", dashboard("demo", "Clean"), map[string]string{"If-None-Match": "*"}).Code)

			slow := newBlockingWriter()
			r := httptest.NewRequestWithContext(t.Context(), "PUT", path, bytes.NewReader(dashboard("demo", "Renamed")))
			r.SetPathValue("id", "demo")
			r.Header.Set("If-Match", "*")
			r.Header.Set("Content-Type", "application/json")
			saved := make(chan struct{})
			go func() {
				defer close(saved)
				s.putDashboard(slow, r)
			}()
			select {
			case <-slow.started:
			case <-time.After(5 * time.Second):
				t.Fatal("the save never wrote its response")
			}
			require.Zero(t, s.documentBytes.inUse(), "a save blocked on its response write still holds its body bytes")
			close(slow.unblock)
			select {
			case <-saved:
			case <-time.After(5 * time.Second):
				t.Fatal("the blocked save did not finish after its reader resumed")
			}
			require.Equal(t, 200, slow.status)
		})
	}
}

// A dry run holds its body bytes only while it reads its body. Its response, whether
// the report or a refusal, is written after the bytes are freed, so a client that stops
// reading holds none.
func TestDryRunHoldsBodyBytesOnlyWhileReading(t *testing.T) {
	document := checkBody(dashboard("demo", "Clean"))
	run := func(t *testing.T, s *Server, slow *blockingWriter) {
		r := httptest.NewRequestWithContext(t.Context(), "POST", "/api/dashboards/validate", bytes.NewReader(document))
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set("Content-Type", "application/json")
		go s.Handler().ServeHTTP(slow, r)
		select {
		case <-slow.started:
		case <-time.After(5 * time.Second):
			t.Fatal("the dry run never wrote its response")
		}
		require.Zero(t, s.documentBytes.inUse(), "a dry run blocked on its response write still holds its body bytes")
	}
	t.Run("report", func(t *testing.T) {
		s, _ := testService(t)
		slow := newBlockingWriter()
		defer close(slow.unblock)
		run(t, s, slow)
	})
	t.Run("refusal", func(t *testing.T) {
		s, _ := testService(t)
		for range cap(s.checkSlots) {
			s.checkSlots <- struct{}{}
		}
		slow := newBlockingWriter()
		defer close(slow.unblock)
		run(t, s, slow)
		require.Equal(t, http.StatusTooManyRequests, slow.status)
	})
}

// headerBlockingWriter is a client that has stopped reading a response with no body.
// Its WriteHeader blocks until unblock is closed, and started is closed when it begins.
type headerBlockingWriter struct {
	header  http.Header
	status  int
	started chan struct{}
	once    sync.Once
	unblock chan struct{}
}

func (b *headerBlockingWriter) Header() http.Header { return b.header }

func (b *headerBlockingWriter) WriteHeader(status int) {
	b.once.Do(func() { close(b.started) })
	<-b.unblock
	b.status = status
}

func (b *headerBlockingWriter) Write(p []byte) (int, error) { return len(p), nil }

// Deleting a dashboard writes its response after the mutation lock is released, so a
// client that stops reading holds nothing that a concurrent write needs. A 204 has no
// body, so the blocked write is the header.
func TestDeleteDashboardWritesAfterUnlocking(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	require.Equal(t, 200, request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Clean"), map[string]string{"If-None-Match": "*"}).Code)

	slow := &headerBlockingWriter{header: make(http.Header), started: make(chan struct{}), unblock: make(chan struct{})}
	r := httptest.NewRequestWithContext(t.Context(), "DELETE", "/api/dashboards/demo", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("If-Match", "*")
	deleted := make(chan struct{})
	go func() {
		defer close(deleted)
		h.ServeHTTP(slow, r)
	}()
	select {
	case <-slow.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the delete never wrote its response")
	}
	require.True(t, s.mutations.TryLock(), "a delete blocked on its response write still holds the mutation lock")
	s.mutations.Unlock()
	close(slow.unblock)
	select {
	case <-deleted:
	case <-time.After(5 * time.Second):
		t.Fatal("the delete did not finish after its client resumed")
	}
	require.Equal(t, http.StatusNoContent, slow.status)
}

// A save that is refused, whether its body is invalid or its check slot is taken,
// writes its 400 or 429 holding no body bytes. The refusal is small, but a client that
// stops reading it must not hold the bytes it sent.
func TestRefusedSaveHoldsNoBodyBytesWhileItsResponseIsWritten(t *testing.T) {
	cases := map[string]struct {
		path   string
		body   []byte
		fill   func(*Server)
		status int
	}{
		"invalid body": {
			path:   "/api/dashboards/demo?checks=true",
			body:   []byte(`{"not":`),
			fill:   func(*Server) {},
			status: http.StatusBadRequest,
		},
		"check slots taken": {
			path: "/api/dashboards/demo?checks=true",
			body: dashboard("demo", "Clean"),
			fill: func(s *Server) {
				for range cap(s.checkSlots) {
					s.checkSlots <- struct{}{}
				}
			},
			status: http.StatusTooManyRequests,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s, _ := testService(t)
			tc.fill(s)
			slow := newBlockingWriter()
			r := httptest.NewRequestWithContext(t.Context(), "PUT", tc.path, bytes.NewReader(tc.body))
			r.SetPathValue("id", "demo")
			r.Header.Set("Content-Type", "application/json")
			done := make(chan struct{})
			go func() {
				defer close(done)
				s.putDashboard(slow, r)
			}()
			select {
			case <-slow.started:
			case <-time.After(5 * time.Second):
				t.Fatal("the refused save never wrote its response")
			}
			require.Zero(t, s.documentBytes.inUse(), "a refused save blocked on its response write still holds its body bytes")
			close(slow.unblock)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("the refused save did not finish after its reader resumed")
			}
			require.Equal(t, tc.status, slow.status)
		})
	}
}
