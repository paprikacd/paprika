package insights

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
)

// bufferedResponse records a handler's status, headers and body. A handler that
// holds the mutation lock or a check slot builds its response into one of these,
// and the response is written with replay only after the lock and slot are released.
// A client that reads slowly, or not at all, then holds neither.
type bufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *bufferedResponse) Header() http.Header {
	if b.header == nil {
		b.header = make(http.Header)
	}
	return b.header
}

func (b *bufferedResponse) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *bufferedResponse) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	n, err := b.body.Write(p)
	if err != nil {
		return n, fmt.Errorf("buffer insights response: %w", err)
	}
	return n, nil
}

// replay writes the recorded status, headers and body to w. The caller must have
// released every lock and slot the response was built under.
func (b *bufferedResponse) replay(w http.ResponseWriter) {
	for key, values := range b.header {
		w.Header()[key] = values
	}
	status := b.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if b.body.Len() == 0 {
		return
	}
	if _, err := w.Write(b.body.Bytes()); err != nil {
		slog.Debug("could not write insights response")
	}
}
