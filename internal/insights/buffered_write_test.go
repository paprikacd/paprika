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
