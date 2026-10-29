package engine

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/httpx"
	"github.com/benebsworth/paprika/internal/reposerverclient"
	"github.com/benebsworth/paprika/internal/source"
)

type stubRenderer struct {
	renderCalled        bool
	renderAllCalled     bool
	resolveSourceCalled bool
	renderResult        []byte
	resolveResult       *source.ResolveResult
	err                 error
}

func (s *stubRenderer) Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error) {
	s.renderCalled = true
	return s.renderResult, s.err
}

func (s *stubRenderer) RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error) {
	s.renderAllCalled = true
	return s.renderResult, s.err
}

func (s *stubRenderer) ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error) {
	s.resolveSourceCalled = true
	return s.resolveResult, s.err
}

func (s *stubRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	return s.renderResult, s.err
}

type stubRepoServerClient struct {
	enabled       bool
	renderCalls   []string
	resolveResult *source.ResolveResult
	err           error
}

func (s *stubRepoServerClient) Enabled() bool {
	return s.enabled
}

func (s *stubRepoServerClient) ResolveSource(context.Context, *paprikav1.Template) (*source.ResolveResult, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.resolveResult, nil
}

func (s *stubRepoServerClient) Render(_ context.Context, tmpl *paprikav1.Template, _ map[string]string) ([]byte, error) {
	s.renderCalls = append(s.renderCalls, tmpl.Name)
	if s.err != nil {
		return nil, s.err
	}
	return []byte(tmpl.Name + "\n"), nil
}

func TestRepoServerRenderer(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		renderResult  []byte
		resolveResult *source.ResolveResult
		method        string
		want          interface{}
	}{
		{
			name:         "falls back to local render",
			renderResult: []byte("manifests"),
			method:       "Render",
			want:         []byte("manifests"),
		},
		{
			name:          "falls back to local resolve source",
			resolveResult: &source.ResolveResult{Hash: "abc"},
			method:        "ResolveSource",
			want:          "abc",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			local := &stubRenderer{
				renderResult:  tc.renderResult,
				resolveResult: tc.resolveResult,
			}
			r := NewRepoServerRenderer(nil, local)
			tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "test"}}

			switch tc.method {
			case "Render":
				out, err := r.Render(context.Background(), tmpl, nil)
				require.NoError(t, err)
				assert.Equal(t, tc.want, out)
				assert.True(t, local.renderCalled)
			case "ResolveSource":
				res, err := r.ResolveSource(context.Background(), tmpl)
				require.NoError(t, err)
				assert.Equal(t, tc.want, res.Hash)
				assert.True(t, local.resolveSourceCalled)
			}
		})
	}
}

func TestRepoServerRenderer_RenderAllUsesRepoServer(t *testing.T) {
	t.Parallel()

	repoServer := &stubRepoServerClient{enabled: true}
	local := &stubRenderer{renderResult: []byte("local")}
	r := NewRepoServerRenderer(repoServer, local)

	templates := []paprikav1.Template{
		{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "default"}},
		{ObjectMeta: metav1.ObjectMeta{Name: "worker", Namespace: "default"}},
	}
	out, err := r.RenderAll(context.Background(), templates, nil)
	require.NoError(t, err)

	assert.Equal(t, []byte("api\nworker\n"), out)
	assert.Equal(t, []string{"api", "worker"}, repoServer.renderCalls)
	assert.False(t, local.renderCalled)
	assert.False(t, local.renderAllCalled)
}

func TestRepoServerRenderer_RenderAllFallsBackPerTemplate(t *testing.T) {
	t.Parallel()

	repoServer := &stubRepoServerClient{enabled: true, err: errors.New("repo server unavailable")}
	local := &stubRenderer{renderResult: []byte("local\n")}
	r := NewRepoServerRenderer(repoServer, local)

	templates := []paprikav1.Template{{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "default"}}}
	out, err := r.RenderAll(context.Background(), templates, nil)
	require.NoError(t, err)

	assert.Equal(t, []byte("local\n"), out)
	assert.Equal(t, []string{"api"}, repoServer.renderCalls)
	assert.True(t, local.renderCalled)
	assert.False(t, local.renderAllCalled)
}

// repoServerSafetyTimeout ends a blocked fake repo-server call that its
// context did not end, so a missing call timeout fails the test in seconds
// rather than at Go's 10-minute test timeout.
const repoServerSafetyTimeout = 3 * time.Second

// blockingRepoServerClient answers only when its context ends, like a repo
// server waiting on a repository lock held by a detached cold-clone fetch. A
// call its context never ends returns Unavailable after the safety timeout,
// which the renderer would fall back on.
type blockingRepoServerClient struct {
	resolveCalls, renderCalls int
	deadlines                 []time.Duration
}

func (*blockingRepoServerClient) Enabled() bool { return true }

func (c *blockingRepoServerClient) block(ctx context.Context) error {
	if deadline, ok := ctx.Deadline(); ok {
		c.deadlines = append(c.deadlines, time.Until(deadline))
	}
	select {
	case <-ctx.Done():
		return connect.NewError(connect.CodeDeadlineExceeded, ctx.Err())
	case <-time.After(repoServerSafetyTimeout):
		return connect.NewError(connect.CodeUnavailable, errors.New("call was not bounded by its context"))
	}
}

func (c *blockingRepoServerClient) ResolveSource(ctx context.Context, _ *paprikav1.Template) (*source.ResolveResult, error) {
	c.resolveCalls++
	return nil, c.block(ctx)
}

func (c *blockingRepoServerClient) Render(ctx context.Context, _ *paprikav1.Template, _ map[string]string) ([]byte, error) {
	c.renderCalls++
	return nil, c.block(ctx)
}

func TestRepoServerRenderer_TimeoutDoesNotFallBackLocally(t *testing.T) {
	t.Parallel()

	repoServer := &blockingRepoServerClient{}
	local := &stubRenderer{renderResult: []byte("local"), resolveResult: &source.ResolveResult{Hash: "local"}}
	r := NewRepoServerRenderer(repoServer, local,
		WithRepoServerCallTimeout(20*time.Millisecond), WithoutLocalFallbackOnTimeout())
	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "brandbrain-api-template", Namespace: "brandbrain"}}

	start := time.Now()
	_, err := r.ResolveSource(context.Background(), tmpl)
	require.ErrorIs(t, err, ErrRepoServerTimeout)
	_, err = r.Render(context.Background(), tmpl, nil)
	require.ErrorIs(t, err, ErrRepoServerTimeout)

	assert.Less(t, time.Since(start), repoServerSafetyTimeout, "each call must end at the call timeout, not the client's 5 minutes")
	require.Len(t, repoServer.deadlines, 2, "each call carries a deadline")
	for _, remaining := range repoServer.deadlines {
		assert.LessOrEqual(t, remaining, 20*time.Millisecond, "the deadline is the call timeout")
	}
	assert.Equal(t, 1, repoServer.resolveCalls)
	assert.Equal(t, 1, repoServer.renderCalls)
	assert.False(t, local.resolveSourceCalled, "a timed-out resolve must not start a second clone locally")
	assert.False(t, local.renderCalled, "a timed-out render must not start a second clone locally")
}

func TestRepoServerRenderer_ClientTimeoutDoesNotFallBackLocally(t *testing.T) {
	t.Parallel()

	// The repo-server client's own http.Client timeout surfaces as a connect
	// deadline_exceeded error, as in the omega-ha controller log.
	clientTimeout := connect.NewError(connect.CodeDeadlineExceeded,
		errors.New(`Post "http://repo-server:8082/paprika.v1.PaprikaService/ResolveSource": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`))
	repoServer := &stubRepoServerClient{enabled: true, err: fmt.Errorf("repo server ResolveSource: %w", clientTimeout)}
	local := &stubRenderer{resolveResult: &source.ResolveResult{Hash: "local"}}
	r := NewRepoServerRenderer(repoServer, local, WithoutLocalFallbackOnTimeout())

	_, err := r.ResolveSource(context.Background(), &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "app-template"}})
	require.ErrorIs(t, err, ErrRepoServerTimeout)
	assert.False(t, local.resolveSourceCalled)
}

func TestRepoServerRenderer_UnreachableStillFallsBackWithoutTimeoutFallback(t *testing.T) {
	t.Parallel()

	unreachable := connect.NewError(connect.CodeUnavailable, errors.New("dial tcp 10.0.0.1:8082: connect: connection refused"))
	repoServer := &stubRepoServerClient{enabled: true, err: unreachable}
	local := &stubRenderer{renderResult: []byte("local"), resolveResult: &source.ResolveResult{Hash: "local"}}
	r := NewRepoServerRenderer(repoServer, local, WithoutLocalFallbackOnTimeout())
	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "app-template"}}

	res, err := r.ResolveSource(context.Background(), tmpl)
	require.NoError(t, err)
	assert.Equal(t, "local", res.Hash)
	out, err := r.Render(context.Background(), tmpl, nil)
	require.NoError(t, err)
	assert.Equal(t, []byte("local"), out)
}

func TestRepoServerRenderer_DefaultStillFallsBackOnTimeout(t *testing.T) {
	t.Parallel()

	// Release rendering keeps the old behaviour: a release whose render fails
	// is marked Failed, so it still prefers a slow local render to an error.
	repoServer := &stubRepoServerClient{enabled: true, err: connect.NewError(connect.CodeDeadlineExceeded, context.DeadlineExceeded)}
	local := &stubRenderer{renderResult: []byte("local")}
	r := NewRepoServerRenderer(repoServer, local)

	out, err := r.Render(context.Background(), &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "app-template"}}, nil)
	require.NoError(t, err)
	assert.Equal(t, []byte("local"), out)
	assert.True(t, local.renderCalled)
}

// TestRepoServerRenderer_CallTimeoutBoundsTheRealClient runs the real
// repo-server client, with its 5-minute client timeout, against a repo server
// that holds every request, as one waiting on a cold clone's repository lock
// does. Each call must end at the renderer's call timeout, cancel the request
// on the server, and not fall back to a local clone. The server gives up after
// repoServerSafetyTimeout, so a missing bound fails the test in seconds.
func TestRepoServerRenderer_CallTimeoutBoundsTheRealClient(t *testing.T) {
	t.Parallel()

	const callTimeout = 150 * time.Millisecond
	var cancelled, unbounded atomic.Int32
	handled := make(chan struct{}, 2)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() { handled <- struct{}{} }()
		select {
		case <-r.Context().Done():
			cancelled.Add(1)
		case <-time.After(repoServerSafetyTimeout):
			unbounded.Add(1)
			http.Error(w, "held past the safety timeout", http.StatusServiceUnavailable)
		}
	}))
	httpx.WithH2C(srv.Config) // the client speaks prior-knowledge h2c to http:// repo servers
	srv.Start()
	t.Cleanup(srv.Close)

	local := &stubRenderer{renderResult: []byte("local"), resolveResult: &source.ResolveResult{Hash: "local"}}
	r := NewRepoServerRenderer(reposerverclient.NewWithTimeout(srv.URL, 5*time.Minute), local,
		WithRepoServerCallTimeout(callTimeout), WithoutLocalFallbackOnTimeout())
	tmpl := &paprikav1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "brandbrain-api-template", Namespace: "brandbrain"},
		Spec:       paprikav1.TemplateSpec{Type: "git", Git: &paprikav1.GitSourceSpec{RepoURL: "https://example.com/repo.git", Revision: "main"}},
	}

	calls := map[string]func() error{
		"resolve": func() error { _, err := r.ResolveSource(context.Background(), tmpl); return err },
		"render":  func() error { _, err := r.Render(context.Background(), tmpl, map[string]string{"k": "v"}); return err },
	}
	for name, call := range calls {
		start := time.Now()
		err := call()
		elapsed := time.Since(start)
		require.ErrorIs(t, err, ErrRepoServerTimeout, "%s", name)
		assert.GreaterOrEqual(t, elapsed, callTimeout, "%s returned before its timeout", name)
		assert.Less(t, elapsed, repoServerSafetyTimeout/2, "%s was not bounded by the call timeout", name)
		select {
		case <-handled:
		case <-time.After(repoServerSafetyTimeout + time.Second):
			t.Fatalf("%s: the repo server never saw the request end", name)
		}
	}
	assert.EqualValues(t, 2, cancelled.Load(), "each timed-out call cancels its request on the repo server")
	assert.Zero(t, unbounded.Load())
	assert.False(t, local.resolveSourceCalled, "a timed-out resolve must not start a local clone")
	assert.False(t, local.renderCalled, "a timed-out render must not start a local clone")
}
