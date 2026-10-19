// Package api provides the Paprika API server handlers and middleware.
package apiserver

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/benebsworth/paprika/internal/metrics"
)

// MetricsHandler returns an HTTP handler for Prometheus metrics.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

type metricsMiddleware struct {
	next http.Handler
}

// MetricsMiddleware wraps an HTTP handler with metrics collection.
func MetricsMiddleware(next http.Handler) http.Handler {
	return &metricsMiddleware{next: next}
}

func (m *metricsMiddleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
	m.next.ServeHTTP(rw, r)
	duration := time.Since(start).Seconds()
	path := normalizePath(r.URL.Path)
	metrics.APIRequestDuration.WithLabelValues(r.Method, path, strconv.Itoa(rw.statusCode)).Observe(duration)
	metrics.APIRequestTotal.WithLabelValues(r.Method, path, strconv.Itoa(rw.statusCode)).Inc()
}

// responseWriter records the status code so the metric can label by it.
//
// It must keep the wrapped writer's optional interfaces reachable. A streaming
// RPC — the satellite link, StreamResourceLogs — flushes as it goes, and a
// wrapper that hides Flush turns a working stream into
// "*apiserver.responseWriter does not implement http.Flusher". Unwrap is what
// http.ResponseController walks to find Flush/Hijack/SetReadDeadline, so the
// wrapper stays transparent to anything the handler underneath expects.
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Flush forwards to the wrapped writer so streamed frames reach the client.
func (rw *responseWriter) Flush() {
	if flusher, ok := rw.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (rw *responseWriter) Unwrap() http.ResponseWriter {
	return rw.ResponseWriter
}

func normalizePath(path string) string {
	if len(path) > 64 {
		return path[:64]
	}
	return path
}
