package kube

import (
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"syscall"
	"time"

	"k8s.io/client-go/rest"
)

// retryTransportMaxAttempts bounds the whole call, including the first try.
const retryTransportMaxAttempts = 3

// WithRetryTransport returns a copy of cfg whose clients retry idempotent
// requests (GET/HEAD/OPTIONS) on transport-level failures — connection
// resets, broken pipes, mid-response EOF.
//
// The motivation is L7 ingress load balancers and API server frontends that
// sever HTTP/2 streams mid-request ("connection reset by peer" killing large
// LIST responses). Retrying a read is always safe; mutations are never
// retried because a reset after the server committed would double-apply.
//
// The wrapper chains after any existing WrapTransport so callers keep their
// own instrumentation on the inner side.
func WithRetryTransport(cfg *rest.Config) *rest.Config {
	if cfg == nil {
		return nil
	}
	out := rest.CopyConfig(cfg)
	inner := out.WrapTransport
	out.WrapTransport = func(rt http.RoundTripper) http.RoundTripper {
		if inner != nil {
			rt = inner(rt)
		}
		return &retryTransport{base: rt}
	}
	return out
}

type retryTransport struct {
	base http.RoundTripper
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !isIdempotentMethod(req.Method) {
		resp, err := t.base.RoundTrip(req)
		if err != nil {
			return nil, fmt.Errorf("round trip: %w", err)
		}
		return resp, nil
	}
	var lastErr error
	for attempt := 0; attempt < retryTransportMaxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-req.Context().Done():
				return nil, fmt.Errorf("round trip: %w", req.Context().Err())
			case <-time.After(retryTransportBackoff(attempt)):
			}
			// Fresh request per attempt: net/http may have poisoned the
			// original's transfer state after a failed RoundTrip.
			req = req.Clone(req.Context())
		}
		resp, err := t.base.RoundTrip(req)
		if err == nil {
			return resp, nil
		}
		lastErr = fmt.Errorf("round trip: %w", err)
		if !isTransportFailure(err) {
			return nil, lastErr
		}
	}
	return nil, lastErr
}

func isIdempotentMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// isTransportFailure recognizes errors that mean "the request never reached
// the API server's handler" — retrying is unambiguous. Handler errors (4xx,
// 5xx) come back as Responses, not errors, so they never reach here.
func isTransportFailure(err error) bool {
	switch {
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return true
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.ECONNABORTED),
		errors.Is(err, syscall.EPIPE):
		return true
	}
	return false
}

func retryTransportBackoff(attempt int) time.Duration {
	// 100ms, 200ms, … with ±25% jitter — short because the control plane
	// heals these within a round trip; the point is bridging a dead conn.
	base := time.Duration(attempt) * 100 * time.Millisecond
	jitter := time.Duration(rand.Int63n(int64(base / 4))) //nolint:gosec // not crypto
	return base + jitter
}
