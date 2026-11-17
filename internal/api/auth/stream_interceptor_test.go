package auth

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/httpx"
)

var streamTestSecret = []byte("stream-interceptor-test-secret-0123456789")

// streamTestService is a PaprikaService whose only implemented method is the
// server stream. It records the principal the handler saw.
type streamTestService struct {
	v1connect.UnimplementedPaprikaServiceHandler

	mu        sync.Mutex
	principal *Principal
	entered   bool
}

func (s *streamTestService) StreamResourceLogs(
	ctx context.Context,
	_ *connect.Request[paprikav1.StreamResourceLogsRequest],
	stream *connect.ServerStream[paprikav1.LogChunk],
) error {
	s.mu.Lock()
	s.entered = true
	s.principal = PrincipalFromContext(ctx)
	s.mu.Unlock()
	return stream.Send(&paprikav1.LogChunk{Line: "line-1"})
}

func (s *streamTestService) handlerEntered() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entered
}

func (s *streamTestService) seenPrincipal() *Principal {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.principal
}

// streamTestAuthConfig enables auth with a self-signed token secret. Unary
// RBAC allows everything, so these tests isolate the authentication path.
func streamTestAuthConfig() Config {
	return Config{
		Enabled:     true,
		TokenSecret: streamTestSecret,
		RBACRules: []RBACRule{{
			Subjects: []string{"*"}, Actions: []string{"*"}, Resources: []string{"*"}, Namespaces: []string{"*"},
		}},
	}
}

func streamTestToken(t *testing.T, subject string, ttl time.Duration) string {
	t.Helper()
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject:  subject,
		Audience: ConsoleAPIAudience,
		TTL:      ttl,
		Secret:   streamTestSecret,
	})
	require.NoError(t, err)
	return token
}

// newStreamTestServer serves the stream test service through the real
// interceptor returned by Interceptor and the generated handler.
func newStreamTestServer(t *testing.T, cfg Config) (*httptest.Server, *streamTestService) {
	t.Helper()
	interceptor, err := Interceptor(t.Context(), cfg, nil)
	require.NoError(t, err)
	svc := &streamTestService{}
	_, handler := v1connect.NewPaprikaServiceHandler(svc, connect.WithInterceptors(interceptor))
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, svc
}

// bearerRoundTripper adds an Authorization header to every request, so the
// generated client can send a token on streaming calls.
type bearerRoundTripper struct {
	base  http.RoundTripper
	token string
}

func (b bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+b.token)
	return b.base.RoundTrip(req)
}

func bearerClient(token string) *http.Client {
	return &http.Client{Transport: bearerRoundTripper{base: http.DefaultTransport, token: token}}
}

func TestStreamAuth_ValidPrincipalStreamsAndHandlerSeesPrincipal(t *testing.T) {
	t.Parallel()
	server, svc := newStreamTestServer(t, streamTestAuthConfig())
	client := v1connect.NewPaprikaServiceClient(bearerClient(streamTestToken(t, "alice", 0)), server.URL)

	stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
		ApplicationName: "app", ApplicationNamespace: "ns", Follow: true,
	}))
	require.NoError(t, err)
	require.True(t, stream.Receive(), "stream should deliver a line: %v", stream.Err())
	require.Equal(t, "line-1", stream.Msg().GetLine())
	require.False(t, stream.Receive())
	require.NoError(t, stream.Err())

	principal := svc.seenPrincipal()
	require.NotNil(t, principal, "the handler must see the authenticated principal")
	require.Equal(t, "alice", principal.Subject)
}

// An unauthenticated stream must be rejected before the handler runs and before
// connect decodes the request message. The body here is complete, so the reply
// is not held up by connect draining an unread body.
func TestStreamAuth_RejectsBeforeHandlerRuns(t *testing.T) {
	t.Parallel()
	cases := map[string]string{ //nolint:gosec // G101 false positive: test fixture, not a credential.
		"no token":  "",
		"bad token": "Bearer not-a-real-token",
	}
	for name, authorization := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server, svc := newStreamTestServer(t, streamTestAuthConfig())

			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
				server.URL+v1connect.PaprikaServiceStreamResourceLogsProcedure,
				bytes.NewReader([]byte{0, 0, 0, 0, 0})) // one empty envelope
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/connect+proto")
			req.Header.Set("Connect-Protocol-Version", "1")
			if authorization != "" {
				req.Header.Set("Authorization", authorization)
			}
			resp, err := server.Client().Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			reply, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			require.Contains(t, string(reply), `"code":"unauthenticated"`)
			require.False(t, svc.handlerEntered(), "the handler must not run for an unauthenticated stream")
		})
	}
}

// fakeStreamConn is the streaming connection the interceptor sees. Only the
// request side matters here: headers, the procedure, and whether the handler
// read a message.
type fakeStreamConn struct {
	spec     connect.Spec
	header   http.Header
	received bool
}

func (c *fakeStreamConn) Spec() connect.Spec { return c.spec }

func (c *fakeStreamConn) Peer() connect.Peer {
	return connect.Peer{Protocol: connect.ProtocolConnect}
}

func (c *fakeStreamConn) Receive(any) error {
	c.received = true
	return io.EOF
}

func (c *fakeStreamConn) RequestHeader() http.Header { return c.header }

func (c *fakeStreamConn) Send(any) error { return nil }

func (c *fakeStreamConn) ResponseHeader() http.Header { return http.Header{} }

func (c *fakeStreamConn) ResponseTrailer() http.Header { return http.Header{} }

// TestStreamingProceduresAreListedOrDenied enumerates every streaming method in
// the paprika.v1 package from the global protobuf registry. A procedure outside
// handlerAuthorizedStreams must be denied through the real interceptor, after
// authentication and before any message is read. A procedure in the list must
// reach its handler.
func TestStreamingProceduresAreListedOrDenied(t *testing.T) {
	t.Parallel()
	interceptor, err := Interceptor(t.Context(), streamTestAuthConfig(), nil)
	require.NoError(t, err)
	token := streamTestToken(t, "alice", 0)

	// Every generated file in the package registers itself in the global
	// registry, so a new streaming method is found without a hand-kept list.
	var procedures []string
	protoregistry.GlobalFiles.RangeFilesByPackage(protoreflect.FullName("paprika.v1"), func(fd protoreflect.FileDescriptor) bool {
		for si := range fd.Services().Len() {
			svc := fd.Services().Get(si)
			for mi := range svc.Methods().Len() {
				method := svc.Methods().Get(mi)
				if method.IsStreamingServer() || method.IsStreamingClient() {
					procedures = append(procedures, "/"+string(svc.FullName())+"/"+string(method.Name()))
				}
			}
		}
		return true
	})
	require.NotEmpty(t, procedures, "the registry must list the streaming procedures")

	for _, procedure := range procedures {
		t.Run(procedure, func(t *testing.T) {
			t.Parallel()
			reached := false
			next := func(context.Context, connect.StreamingHandlerConn) error {
				reached = true
				return nil
			}
			conn := &fakeStreamConn{
				spec:   connect.Spec{Procedure: procedure},
				header: http.Header{"Authorization": {"Bearer " + token}},
			}
			err := interceptor.WrapStreamingHandler(next)(t.Context(), conn)

			if handlerAuthorizedStreams[procedure] {
				require.NoError(t, err)
				require.True(t, reached, "a listed stream must reach its handler")
				return
			}
			require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "got %v", err)
			require.False(t, reached, "an unlisted stream must not reach its handler")
			require.False(t, conn.received, "an unlisted stream must not read its request")

			// Without a credential the denial is Unauthenticated, not a hint about the method.
			anon := &fakeStreamConn{spec: connect.Spec{Procedure: procedure}}
			err = interceptor.WrapStreamingHandler(next)(t.Context(), anon)
			require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "got %v", err)
		})
	}

	for procedure := range handlerAuthorizedStreams {
		require.Contains(t, procedures, procedure,
			"handler-authorized procedure %s is not a streaming method in the generated descriptors", procedure)
	}
	require.True(t, handlerAuthorizedStreams[v1connect.PaprikaServiceStreamResourceLogsProcedure])
}

// authRoundTripper sets an Authorization header only when one is given, so a
// case can send no credential at all.
type authRoundTripper struct {
	base          http.RoundTripper
	authorization string
}

func (a authRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if a.authorization != "" {
		req = req.Clone(req.Context())
		req.Header.Set("Authorization", a.authorization)
	}
	return a.base.RoundTrip(req)
}

// TestStreamAuth_UnlistedBidiStreamIsDeniedOverH2C runs the fail-closed rule
// through a real h2c server with a real bidirectional procedure. SatelliteLink.Connect
// is not in handlerAuthorizedStreams, so with a valid token the caller must get
// permission_denied, and without one unauthenticated. The base handler answers
// unimplemented, so a request that reached it would fail the test.
func TestStreamAuth_UnlistedBidiStreamIsDeniedOverH2C(t *testing.T) {
	t.Parallel()
	interceptor, err := Interceptor(t.Context(), streamTestAuthConfig(), nil)
	require.NoError(t, err)
	_, handler := v1connect.NewSatelliteLinkHandler(
		v1connect.UnimplementedSatelliteLinkHandler{},
		connect.WithInterceptors(interceptor),
	)
	server := httptest.NewUnstartedServer(handler)
	httpx.WithH2C(server.Config)
	server.Start()
	t.Cleanup(server.Close)

	cases := map[string]struct {
		authorization string
		want          connect.Code
	}{
		"valid token": {authorization: "Bearer " + streamTestToken(t, "alice", 0), want: connect.CodePermissionDenied},
		"no token":    {want: connect.CodeUnauthenticated},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			transport := &http.Transport{}
			transport.Protocols = new(http.Protocols)
			transport.Protocols.SetUnencryptedHTTP2(true)
			t.Cleanup(transport.CloseIdleConnections)

			client := v1connect.NewSatelliteLinkClient(
				&http.Client{Transport: authRoundTripper{base: transport, authorization: tc.authorization}},
				server.URL,
			)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			stream := client.Connect(ctx)
			require.NoError(t, stream.CloseRequest())
			_, err := stream.Receive()
			require.Equal(t, tc.want, connect.CodeOf(err), "got %v", err)
		})
	}
}

// The same rejection over h2c, which is what production serves (httpx.WithH2C) and
// what Envoy uses toward the api-server. net/http does not wait for an unread
// body on HTTP/2, so the reply must arrive while the body is still held back.
// Over HTTP/1.1 net/http can wait for the body; this test does not cover that.
func TestStreamAuth_UnauthenticatedReplyDoesNotWaitForBodyOverH2C(t *testing.T) {
	t.Parallel()
	cases := map[string]string{ //nolint:gosec // G101 false positive: test fixture, not a credential.
		"no token":  "",
		"bad token": "Bearer not-a-real-token",
	}
	for name, authorization := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			interceptor, err := Interceptor(t.Context(), streamTestAuthConfig(), nil)
			require.NoError(t, err)
			svc := &streamTestService{}
			_, handler := v1connect.NewPaprikaServiceHandler(svc, connect.WithInterceptors(interceptor))
			server := httptest.NewUnstartedServer(handler)
			httpx.WithH2C(server.Config)
			server.Start()
			t.Cleanup(server.Close)

			transport := &http.Transport{}
			transport.Protocols = new(http.Protocols)
			transport.Protocols.SetUnencryptedHTTP2(true)
			t.Cleanup(transport.CloseIdleConnections)

			// The body is never written and never closed until the test ends.
			body, bodyWriter := io.Pipe()
			t.Cleanup(func() { _ = bodyWriter.Close() })
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost,
				server.URL+v1connect.PaprikaServiceStreamResourceLogsProcedure, body)
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/connect+proto")
			req.Header.Set("Connect-Protocol-Version", "1")
			if authorization != "" {
				req.Header.Set("Authorization", authorization)
			}

			resp, err := (&http.Client{Transport: transport}).Do(req)
			require.NoError(t, err, "no reply within 2s while the request body is held back")
			defer resp.Body.Close()
			require.Equal(t, 2, resp.ProtoMajor)
			reply, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			require.Contains(t, string(reply), `"code":"unauthenticated"`)
			require.False(t, svc.handlerEntered(), "the handler must not run for an unauthenticated stream")
		})
	}
}

// The handler's own check must match the action the classifier gives the
// procedure. A follow returns the same lines as unary GetResourceLogs, so the
// action is read.
func TestStreamResourceLogsActionIsRead(t *testing.T) {
	t.Parallel()
	action, resource := ActionFor(v1connect.PaprikaServiceStreamResourceLogsProcedure)
	require.Equal(t, ActionRead, action)
	require.Equal(t, ResourceApplications, resource)
}

func TestStreamAuth_AuthDisabledStreamsWork(t *testing.T) {
	t.Parallel()
	server, svc := newStreamTestServer(t, Config{Enabled: false})
	client := v1connect.NewPaprikaServiceClient(server.Client(), server.URL)

	stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{}))
	require.NoError(t, err)
	require.True(t, stream.Receive(), "stream should deliver a line: %v", stream.Err())
	require.False(t, stream.Receive())
	require.NoError(t, stream.Err())
	require.Nil(t, svc.seenPrincipal())
}
