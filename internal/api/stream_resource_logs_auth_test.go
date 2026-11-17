package apiserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	streamAuthNamespace = "paprika-e2e"
	streamAuthApp       = "demo-app"
	streamAuthPod       = "demo-pod"
	// streamAuthStrayPod exists in the cluster but is not in the application's
	// resource tree. A follow of it must end NotFound without reading its logs.
	streamAuthStrayPod = "stray-pod"
	streamAuthProject  = "team-a"
	streamAuthSecret   = "stream-auth-test-secret-0123456789abcdef" //nolint:gosec // G101 false positive: test fixture, not a credential.
	streamAuthAppUID   = types.UID("app-uid-1")
)

// streamAuthKube serves a pod and its logs. The log endpoint writes lines and
// then either closes the response or, when silent, keeps it open with no more
// output until the client disconnects. A silent pod is the case where only a
// timer can end the stream.
type streamAuthKube struct {
	lines  []string
	silent bool
	// logReads, when set, counts every log read the kube server receives.
	logReads *atomic.Int32
}

func (k streamAuthKube) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if k.logReads != nil && strings.HasSuffix(r.URL.Path, "/log") {
		k.logReads.Add(1)
	}
	switch r.URL.Path {
	case fmt.Sprintf("/api/v1/namespaces/%s/pods/%s", streamAuthNamespace, streamAuthStrayPod):
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"metadata":{"name":%q,"namespace":%q},"spec":{"containers":[{"name":"app"}]}}`,
			streamAuthStrayPod, streamAuthNamespace)
	case fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/log", streamAuthNamespace, streamAuthStrayPod):
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintln(w, "stray line")
	case fmt.Sprintf("/api/v1/namespaces/%s/pods/%s", streamAuthNamespace, streamAuthPod):
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"metadata":{"name":%q,"namespace":%q},"spec":{"containers":[{"name":"app"}]}}`,
			streamAuthPod, streamAuthNamespace)
	case fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/log", streamAuthNamespace, streamAuthPod):
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for _, line := range k.lines {
			_, _ = fmt.Fprintln(w, line)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if k.silent {
			<-r.Context().Done()
		}
	default:
		http.NotFound(w, r)
	}
}

// streamAuthHarness is a PaprikaServer behind the real auth interceptor and the
// generated Connect handler, with a Connect client on top.
type streamAuthHarness struct {
	server  *PaprikaServer
	handler *httptest.Server
}

// newStreamAuthHarness builds the harness. With authEnabled, the interceptor
// authenticates with self-signed tokens, and the handler authorizes against the
// AppProject in the fake client. extra options are applied last.
func newStreamAuthHarness(t *testing.T, authEnabled bool, kube streamAuthKube, extra ...ServerOption) (*streamAuthHarness, client.Client) {
	t.Helper()
	scheme := streamingTestScheme(t)
	require.NoError(t, corev1alpha1.AddToScheme(scheme))

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: streamAuthApp, Namespace: streamAuthNamespace, UID: streamAuthAppUID},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: streamAuthProject,
			Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod"}},
		},
		// The pod is in the application's resource tree, so a follow may read it.
		Status: pipelinesv1alpha1.ApplicationStatus{
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Pod", Name: streamAuthPod, Namespace: streamAuthNamespace, Status: "Synced"},
			},
		},
	}
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: streamAuthProject, Namespace: streamAuthNamespace},
		Spec: corev1alpha1.AppProjectSpec{
			Roles: []corev1alpha1.AppProjectRole{{
				Name:     "operators",
				Subjects: []string{"alice"},
				Actions:  []string{"write"},
			}},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(app, project).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()

	kubeServer := httptest.NewServer(kube)
	t.Cleanup(kubeServer.Close)
	kubeClient, err := kubernetes.NewForConfig(&rest.Config{Host: kubeServer.URL})
	require.NoError(t, err)

	opts := []ServerOption{WithK8sClient(kubeClient)}
	cfg := auth.Config{Enabled: false}
	if authEnabled {
		cfg = auth.Config{Enabled: true, TokenSecret: []byte(streamAuthSecret)}
		opts = append(opts, WithAuthorizer(auth.NewProjectAuthorizer(c)))
	}
	opts = append(opts, extra...)
	server := NewPaprikaServer(c, nil, opts...)
	// Re-checks run often so tests finish quickly. Production uses the default.
	server.followRecheckInterval = 50 * time.Millisecond

	interceptor, err := auth.Interceptor(t.Context(), cfg, c)
	require.NoError(t, err)
	_, handler := v1connect.NewPaprikaServiceHandler(server, connect.WithInterceptors(interceptor))
	httpServer := httptest.NewServer(handler)
	t.Cleanup(httpServer.Close)
	return &streamAuthHarness{server: server, handler: httpServer}, c
}

func streamAuthToken(t *testing.T, subject string, ttl time.Duration) string {
	t.Helper()
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  subject,
		Audience: auth.ConsoleAPIAudience,
		TTL:      ttl,
		Secret:   []byte(streamAuthSecret),
	})
	require.NoError(t, err)
	return token
}

type streamAuthBearer struct {
	token string
}

func (b streamAuthBearer) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if b.token != "" {
		req.Header.Set("Authorization", "Bearer "+b.token)
	}
	return http.DefaultTransport.RoundTrip(req)
}

func streamAuthClient(h *streamAuthHarness, token string) v1connect.PaprikaServiceClient {
	return v1connect.NewPaprikaServiceClient(&http.Client{Transport: streamAuthBearer{token: token}}, h.handler.URL)
}

func followRequest() *connect.Request[paprikav1.StreamResourceLogsRequest] {
	return connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
		ApplicationNamespace: streamAuthNamespace,
		ApplicationName:      streamAuthApp,
		ResourceKind:         "Pod",
		ResourceName:         streamAuthPod,
		Follow:               true,
	})
}

// drainStream collects the lines a stream delivers and returns the error that
// ended it, or nil for a clean end.
func drainStream(stream *connect.ServerStreamForClient[paprikav1.LogChunk]) ([]string, error) {
	var lines []string
	for stream.Receive() {
		lines = append(lines, stream.Msg().GetLine())
	}
	return lines, stream.Err()
}

func TestStreamResourceLogs_AuthEnabledFollowStreamsLines(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first", "second"}})
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	lines, err := drainStream(stream)
	require.NoError(t, err, "an authorized follow must not fail with 'no principal in context'")
	require.Equal(t, []string{"first", "second"}, lines)
}

func TestStreamResourceLogs_PrincipalWithoutAccessIsPermissionDenied(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}})
	connectClient := streamAuthClient(h, streamAuthToken(t, "bob", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	lines, err := drainStream(stream)
	require.Empty(t, lines)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "got %v", err)
	require.Contains(t, err.Error(), `"bob"`, "the denial must come from the project check for this principal")
}

// The token expires mid-follow. The pod is silent, so only the re-check can end
// the stream.
func TestStreamResourceLogs_FollowEndsWhenAuthenticationFailsWhileSilent(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	token := streamAuthToken(t, "alice", 2*time.Second)
	connectClient := streamAuthClient(h, token)

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	started := time.Now()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	lines, err := drainStream(stream)
	elapsed := time.Since(started)

	require.Equal(t, []string{"first"}, lines)
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "got %v after %s", err, elapsed)
	require.Less(t, elapsed, 5*time.Second, "the stream must end soon after the token expires")
}

// The project role is removed mid-follow. The pod is silent, so only the
// re-check can end the stream.
func TestStreamResourceLogs_FollowEndsWhenAuthorizationIsRevokedWhileSilent(t *testing.T) {
	t.Parallel()
	h, c := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	require.True(t, stream.Receive(), "the first line should arrive: %v", stream.Err())
	require.Equal(t, "first", stream.Msg().GetLine())

	var project corev1alpha1.AppProject
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: streamAuthNamespace, Name: streamAuthProject}, &project))
	project.Spec.Roles = nil
	require.NoError(t, c.Update(ctx, &project))

	started := time.Now()
	for stream.Receive() {
	}
	elapsed := time.Since(started)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(stream.Err()), "got %v after %s", stream.Err(), elapsed)
	require.Less(t, elapsed, 5*time.Second, "the stream must end within a re-check interval")
}

// A follow of a pod the application's tree does not show is NotFound when it
// opens, and the cluster is never asked for its logs. A pod that does not exist
// gets the same answer, with only the pod name differing, so the caller cannot
// tell the two apart.
func TestStreamResourceLogs_PodOutsideTreeIsNotFoundAndReadsNoLogs(t *testing.T) {
	t.Parallel()
	var logReads atomic.Int32
	h, _ := newStreamAuthHarness(t, false, streamAuthKube{lines: []string{"x"}, logReads: &logReads})
	connectClient := streamAuthClient(h, "")

	pods := []string{streamAuthStrayPod, "missing-pod"}
	messages := make([]string, 0, len(pods))
	for _, pod := range pods {
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		req := followRequest()
		req.Msg.ResourceName = pod
		stream, err := connectClient.StreamResourceLogs(ctx, req)
		require.NoError(t, err)
		lines, err := drainStream(stream)
		cancel()
		require.Empty(t, lines)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "%s: got %v", pod, err)
		messages = append(messages, strings.ReplaceAll(err.Error(), pod, "<pod>"))
	}
	require.Equal(t, messages[0], messages[1], "a stray pod and a missing pod must get the same message")
	require.Zero(t, logReads.Load(), "a pod outside the tree must not have its logs read")
}

// A NotFound at open gives the call's slot back. With a limit of one, two
// outside-the-tree follows must both be NotFound, not ResourceExhausted, and an
// in-tree follow after them must open.
func TestStreamResourceLogs_OutsideTreeFollowFreesItsSlot(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}}, WithLogStreamLimit(1))
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	for range 2 {
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		req := followRequest()
		req.Msg.ResourceName = streamAuthStrayPod
		stream, err := connectClient.StreamResourceLogs(ctx, req)
		require.NoError(t, err)
		lines, err := drainStream(stream)
		cancel()
		require.Empty(t, lines)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "got %v", err)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	require.True(t, stream.Receive(), "an in-tree follow must open once the outside-tree calls have freed the slot: %v", stream.Err())
	require.Equal(t, "first", stream.Msg().GetLine())
}

func TestStreamResourceLogs_AuthDisabledFollowStreams(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, false, streamAuthKube{lines: []string{"first", "second"}})
	connectClient := streamAuthClient(h, "")

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	lines, err := drainStream(stream)
	require.NoError(t, err)
	require.Equal(t, []string{"first", "second"}, lines)
}

// setStreamAuthRoles replaces the roles of the test AppProject.
func setStreamAuthRoles(t *testing.T, c client.Client, roles ...corev1alpha1.AppProjectRole) {
	t.Helper()
	var project corev1alpha1.AppProject
	require.NoError(t, c.Get(t.Context(), client.ObjectKey{Namespace: streamAuthNamespace, Name: streamAuthProject}, &project))
	project.Spec.Roles = roles
	require.NoError(t, c.Update(t.Context(), &project))
}

// A read-only role follows the logs. The handler checks read, as unary
// GetResourceLogs does, so the role is not refused.
func TestStreamResourceLogs_ReadOnlyRoleFollows(t *testing.T) {
	t.Parallel()
	h, c := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}})
	setStreamAuthRoles(t, c, corev1alpha1.AppProjectRole{
		Name: "viewers", Subjects: []string{"carol"}, Actions: []string{"read"},
	})
	connectClient := streamAuthClient(h, streamAuthToken(t, "carol", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	lines, err := drainStream(stream)
	require.NoError(t, err, "a read-only role must be able to follow the logs")
	require.Equal(t, []string{"first"}, lines)
}

// The namespace is checked before the application is looked up, so a caller
// who cannot read the namespace gets the same answer for a real app and for a
// missing one. Otherwise the codes reveal which app names exist.
func TestStreamResourceLogs_NamespaceIsCheckedBeforeLookup(t *testing.T) {
	t.Parallel()
	rbac := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects: []string{"alice"}, Actions: []string{"*"}, Resources: []string{"*"}, Namespaces: []string{"other-ns"},
	}})
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}}, WithAuthorizer(rbac))
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	for _, name := range []string{streamAuthApp, "no-such-app"} {
		req := connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
			ApplicationNamespace: streamAuthNamespace, ApplicationName: name, ResourceKind: "Pod", ResourceName: streamAuthPod,
		})
		stream, err := connectClient.StreamResourceLogs(t.Context(), req)
		require.NoError(t, err)
		_, err = drainStream(stream)
		require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "app %q: got %v", name, err)
	}
}

// The application moves to an AppProject the caller cannot use. The pod is
// silent, so only the re-check can end the stream, and it must read the
// application again to see the move.
func TestStreamResourceLogs_AppMovedToAnotherProjectEndsFollowWhileSilent(t *testing.T) {
	t.Parallel()
	h, c := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	require.NoError(t, c.Create(t.Context(), &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "team-b", Namespace: streamAuthNamespace},
	}))
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	require.True(t, stream.Receive(), "the first line should arrive: %v", stream.Err())

	var app pipelinesv1alpha1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: streamAuthNamespace, Name: streamAuthApp}, &app))
	app.Spec.Project = "team-b"
	require.NoError(t, c.Update(ctx, &app))

	started := time.Now()
	for stream.Receive() {
	}
	elapsed := time.Since(started)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(stream.Err()), "got %v after %s", stream.Err(), elapsed)
	require.Less(t, elapsed, 5*time.Second, "the stream must end within a re-check interval")
}

// The application is deleted, then recreated under the same name with a new
// UID, while the pod is silent. The follow must end, because the caller
// followed the old application.
func TestStreamResourceLogs_AppReplacedEndsFollowWhileSilent(t *testing.T) {
	t.Parallel()
	h, c := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	require.True(t, stream.Receive(), "the first line should arrive: %v", stream.Err())

	var app pipelinesv1alpha1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: streamAuthNamespace, Name: streamAuthApp}, &app))
	require.NoError(t, c.Delete(ctx, &app))
	require.NoError(t, c.Create(ctx, &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: streamAuthApp, Namespace: streamAuthNamespace, UID: "app-uid-2"},
		Spec:       pipelinesv1alpha1.ApplicationSpec{Project: streamAuthProject},
	}))

	started := time.Now()
	for stream.Receive() {
	}
	elapsed := time.Since(started)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(stream.Err()), "got %v after %s", stream.Err(), elapsed)
	require.Less(t, elapsed, 5*time.Second, "the stream must end within a re-check interval")
}

// A missing application ends the call with NotFound. The namespace check passes
// for this caller, so the lookup is what fails.
func TestStreamResourceLogs_MissingApplicationIsNotFound(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}})
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	req := connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
		ApplicationNamespace: streamAuthNamespace, ApplicationName: "no-such-app", ResourceKind: "Pod", ResourceName: streamAuthPod,
	})
	stream, err := connectClient.StreamResourceLogs(t.Context(), req)
	require.NoError(t, err)
	_, err = drainStream(stream)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "got %v", err)
}

// outageAuthorizer fails every authorization read while down is set, as an API
// server outage would. Other calls pass to the real authorizer.
type outageAuthorizer struct {
	auth.Authorizer
	down *atomic.Bool
}

func (a outageAuthorizer) Authorize(ctx context.Context, p *auth.Principal, action auth.Action, resource auth.Resource, namespace, project string) error {
	if a.down.Load() {
		return errors.New("appproject read: the API server is unavailable")
	}
	return a.Authorizer.Authorize(ctx, p, action, resource, namespace, project)
}

// outageClient fails application reads while down is set.
type outageClient struct {
	client.Client
	down *atomic.Bool
}

func (c outageClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, isApp := obj.(*pipelinesv1alpha1.Application); isApp && c.down.Load() {
		return errors.New("application read: the API server is unavailable")
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

// A read that fails with anything other than NotFound or a denial during a
// re-check is an outage, not a revocation. The follow ends Unavailable, so the
// UI retries it instead of treating access as removed. The pod is silent, so
// only the re-check can end the stream.
func TestStreamResourceLogs_ReadFailureDuringRecheckIsUnavailable(t *testing.T) {
	t.Parallel()
	for _, read := range []string{"AppProject", "Application"} {
		t.Run(read, func(t *testing.T) {
			t.Parallel()
			h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
			var down atomic.Bool
			if read == "AppProject" {
				h.server.authorizer = outageAuthorizer{Authorizer: h.server.authorizer, down: &down}
			} else {
				h.server.client = outageClient{Client: h.server.client, down: &down}
			}
			connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
			require.NoError(t, err)
			require.True(t, stream.Receive(), "the first line should arrive: %v", stream.Err())

			down.Store(true)
			started := time.Now()
			for stream.Receive() {
			}
			elapsed := time.Since(started)
			require.Equal(t, connect.CodeUnavailable, connect.CodeOf(stream.Err()), "got %v after %s", stream.Err(), elapsed)
			require.Less(t, elapsed, 5*time.Second, "the stream must end within a re-check interval")
		})
	}
}

// principalOnlyInterceptor sets a principal and no re-authenticator, which is
// the state a handler is in when the streaming interceptor is not in the chain.
type principalOnlyInterceptor struct {
	subject string
}

func (p principalOnlyInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc { return next }

func (p principalOnlyInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (p principalOnlyInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		return next(auth.WithPrincipal(ctx, &auth.Principal{Subject: p.subject}), conn)
	}
}

// With an authorizer configured, a follow whose context has no re-authenticator
// cannot be re-checked, so it is refused before it opens a log stream. The
// pod is silent and would otherwise hold the follow open with no line.
func TestStreamResourceLogs_FollowWithoutReauthenticatorEndsUnauthenticated(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	_, handler := v1connect.NewPaprikaServiceHandler(h.server, connect.WithInterceptors(principalOnlyInterceptor{subject: "alice"}))
	h.handler = httptest.NewServer(handler)
	t.Cleanup(h.handler.Close)
	connectClient := streamAuthClient(h, "")

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	started := time.Now()
	lines, err := drainStream(stream)
	elapsed := time.Since(started)
	require.Empty(t, lines, "no log line may be sent to a follow that cannot be re-checked")
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "got %v after %s", err, elapsed)
	require.Less(t, elapsed, 5*time.Second)
}

// recheckFollow repeats the fail-closed check for a context that lost its
// re-authenticator after the follow opened. The open-time check normally
// refuses such a follow first, so this covers the second guard directly.
func TestRecheckFollow_WithoutReauthenticatorIsUnauthenticated(t *testing.T) {
	t.Parallel()
	// The client holds the application, so a regression that skips the guard
	// reaches the authorization step and fails the code assertion, not a nil client.
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: streamAuthApp, Namespace: streamAuthNamespace, UID: streamAuthAppUID},
		Spec:       pipelinesv1alpha1.ApplicationSpec{Project: streamAuthProject},
	}
	c := fake.NewClientBuilder().WithScheme(streamingTestScheme(t)).WithObjects(app).Build()
	s := &PaprikaServer{client: c, authorizer: auth.NewRBACAuthorizer(nil)}
	err := s.recheckFollow(t.Context(), auth.ActionRead, client.ObjectKey{Namespace: streamAuthNamespace, Name: streamAuthApp}, streamAuthAppUID)
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "got %v", err)
}

// An AppProject deleted during a silent follow ends the follow with
// PermissionDenied, because the caller can no longer read the application's
// project. The pod is silent, so only the re-check can end the stream.
func TestStreamResourceLogs_AppProjectDeletedEndsFollowWhileSilent(t *testing.T) {
	t.Parallel()
	h, c := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	stream, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	require.True(t, stream.Receive(), "the first line should arrive: %v", stream.Err())

	var project corev1alpha1.AppProject
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: streamAuthNamespace, Name: streamAuthProject}, &project))
	require.NoError(t, c.Delete(ctx, &project))

	started := time.Now()
	for stream.Receive() {
	}
	elapsed := time.Since(started)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(stream.Err()), "got %v after %s", stream.Err(), elapsed)
	require.Less(t, elapsed, 5*time.Second, "the stream must end within a re-check interval")
}

// A read of the application that fails with anything but NotFound at open is an
// outage, so the call ends Unavailable and the UI retries it, as a re-check does.
func TestStreamResourceLogs_ApplicationReadFailureAtOpenIsUnavailable(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}})
	var down atomic.Bool
	down.Store(true)
	h.server.client = outageClient{Client: h.server.client, down: &down}
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	stream, err := connectClient.StreamResourceLogs(t.Context(), followRequest())
	require.NoError(t, err)
	_, err = drainStream(stream)
	require.Equal(t, connect.CodeUnavailable, connect.CodeOf(err), "got %v", err)
}

// Each caller subject may hold defaultLogStreamLimit follows open. The next
// call ends with ResourceExhausted, a different subject is not counted against
// it, and ending one open follow frees its slot.
func TestStreamResourceLogs_PerSubjectLimitEndsExtraFollowsAndFreesSlots(t *testing.T) {
	t.Parallel()
	h, c := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true})
	setStreamAuthRoles(t, c,
		corev1alpha1.AppProjectRole{Name: "operators", Subjects: []string{"alice"}, Actions: []string{"write"}},
		corev1alpha1.AppProjectRole{Name: "viewers", Subjects: []string{"bob"}, Actions: []string{"read"}},
	)
	aliceClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	cancels := make([]context.CancelFunc, 0, defaultLogStreamLimit)
	for i := range defaultLogStreamLimit {
		ctx, cancel := context.WithCancel(t.Context())
		t.Cleanup(cancel)
		cancels = append(cancels, cancel)
		stream, err := aliceClient.StreamResourceLogs(ctx, followRequest())
		require.NoError(t, err)
		require.True(t, stream.Receive(), "follow %d should open: %v", i+1, stream.Err())
	}

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream, err := aliceClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	_, err = drainStream(stream)
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err), "follow %d: got %v", defaultLogStreamLimit+1, err)

	bobCtx, bobCancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer bobCancel()
	bobStream, err := streamAuthClient(h, streamAuthToken(t, "bob", 0)).StreamResourceLogs(bobCtx, followRequest())
	require.NoError(t, err)
	require.True(t, bobStream.Receive(), "another subject's follow must not share alice's limit: %v", bobStream.Err())
	bobCancel()

	cancels[0]()
	require.Eventually(t, func() bool {
		probeCtx, probeCancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer probeCancel()
		probe, err := aliceClient.StreamResourceLogs(probeCtx, followRequest())
		if err != nil {
			return false
		}
		return probe.Receive()
	}, 10*time.Second, 50*time.Millisecond, "a slot must free when one of alice's follows ends")
}

// WithLogStreamLimit replaces the default cap.
func TestStreamResourceLogs_LogStreamLimitOptionSetsTheCap(t *testing.T) {
	t.Parallel()
	h, _ := newStreamAuthHarness(t, true, streamAuthKube{lines: []string{"first"}, silent: true}, WithLogStreamLimit(1))
	connectClient := streamAuthClient(h, streamAuthToken(t, "alice", 0))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	first, err := connectClient.StreamResourceLogs(ctx, followRequest())
	require.NoError(t, err)
	require.True(t, first.Receive(), "the first follow should open: %v", first.Err())

	secondCtx, secondCancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer secondCancel()
	second, err := connectClient.StreamResourceLogs(secondCtx, followRequest())
	require.NoError(t, err)
	_, err = drainStream(second)
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err), "got %v", err)
}

// A second release of the same slot must not free a slot that another call holds.
func TestLogStreamSlots_ReleaseIsIdempotent(t *testing.T) {
	t.Parallel()
	var slots logStreamSlots
	release, ok := slots.acquire("alice", 1)
	require.True(t, ok)
	_, ok = slots.acquire("alice", 1)
	require.False(t, ok, "the only slot is held")

	release()
	release()
	_, ok = slots.acquire("alice", 1)
	require.True(t, ok, "the released slot is free")
	_, ok = slots.acquire("alice", 1)
	require.False(t, ok, "a second release must not have freed an extra slot")
}
