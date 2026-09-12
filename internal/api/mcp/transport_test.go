package mcp

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// stubService implements just enough of the handler surface to exercise
// success and error paths through the transport.
type stubService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	err error
}

func (s *stubService) GetSystemStatus(
	ctx context.Context, req *connect.Request[v1.GetSystemStatusRequest],
) (*connect.Response[v1.GetSystemStatusResponse], error) {
	if s.err != nil {
		return nil, s.err
	}
	return connect.NewResponse(&v1.GetSystemStatusResponse{}), nil
}

func newTestClient(t *testing.T, svc v1connect.PaprikaServiceHandler) v1connect.PaprikaServiceClient {
	t.Helper()
	_, handler := v1connect.NewPaprikaServiceHandler(svc)
	return v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)},
		"http://in-process",
	)
}

func TestInProcessTransportRoundTripsSuccess(t *testing.T) {
	client := newTestClient(t, &stubService{})
	resp, err := client.GetSystemStatus(context.Background(),
		connect.NewRequest(&v1.GetSystemStatusRequest{}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)
}

func TestInProcessTransportPreservesConnectErrorCodes(t *testing.T) {
	for _, code := range []connect.Code{
		connect.CodePermissionDenied,
		connect.CodeUnauthenticated,
		connect.CodeNotFound,
		connect.CodeInvalidArgument,
	} {
		t.Run(code.String(), func(t *testing.T) {
			client := newTestClient(t, &stubService{
				err: connect.NewError(code, errors.New("boom")),
			})
			_, err := client.GetSystemStatus(context.Background(),
				connect.NewRequest(&v1.GetSystemStatusRequest{}))
			require.Error(t, err)
			assert.Equal(t, code, connect.CodeOf(err),
				"transport must not flatten Connect codes")
		})
	}
}

func TestInProcessTransportPropagatesHeaders(t *testing.T) {
	var got string
	svc := &stubService{}
	_, handler := v1connect.NewPaprikaServiceHandler(svc,
		connect.WithInterceptors(connect.UnaryInterceptorFunc(
			func(next connect.UnaryFunc) connect.UnaryFunc {
				return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
					got = req.Header().Get("Authorization")
					return next(ctx, req)
				}
			})))
	client := v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")

	req := connect.NewRequest(&v1.GetSystemStatusRequest{})
	req.Header().Set("Authorization", "Bearer token-abc")
	_, err := client.GetSystemStatus(context.Background(), req)
	require.NoError(t, err)
	assert.Equal(t, "Bearer token-abc", got,
		"Authorization must reach the interceptor chain")
}

// TestInProcessTransportReturnsPromptlyOnContextCancellation proves RoundTrip
// races the handler against req.Context() rather than blocking until the
// handler returns. The handler used here blocks forever on an unbuffered
// channel that only the test's cleanup ever closes, simulating a
// long-running RPC (e.g. a resource-tree walk) whose caller disconnects or
// hits its deadline. RoundTrip must return promptly with the context's
// error; it is not expected to, and cannot, stop the handler goroutine
// itself.
func TestInProcessTransportReturnsPromptlyOnContextCancellation(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })

	handler := http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		<-block
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://in-process/", nil)
	require.NoError(t, err)

	transport := NewInProcessTransport(handler)

	type result struct {
		resp *http.Response
		err  error
	}
	done := make(chan result, 1)
	go func() {
		resp, rtErr := transport.RoundTrip(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		done <- result{resp: resp, err: rtErr}
	}()

	cancel()

	select {
	case r := <-done:
		require.Error(t, r.err)
		assert.ErrorIs(t, r.err, context.Canceled)
	case <-time.After(2 * time.Second):
		t.Fatal("RoundTrip did not return promptly after context cancellation; " +
			"it appears to block until the handler returns")
	}
}
