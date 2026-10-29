package source

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/cgi" // #nosec G504 -- serves git http-backend in tests only, on Go far past CVE-2016-5386
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// cliTestServer is a smart-HTTP git server: git http-backend behind
// net/http/cgi, serving protocol v2 with partial clone enabled, as GitHub
// does. It counts what clients ask for and can hold a fetch.
type cliTestServer struct {
	t       *testing.T
	backend string
	root    string
	srv     *httptest.Server

	// user and pass, when set, are required as basic auth.
	user, pass string
	// lsRefsDelay holds each ls-refs this long, so concurrent clients overlap.
	lsRefsDelay time.Duration
	// hold, when set, blocks each fetch until it is closed or the client
	// goes away.
	hold chan struct{}
	// v0 serves only protocol v0, as servers that predate v2 do.
	v0 bool

	mu          sync.Mutex
	lsRefs      int
	commitFetch int
	blobFetch   int
	blobWants   int
	sent        int64
	held        chan struct{}
}

// newCLITestServer serves the bare repositories under root at
// <url>/<name>.git.
func newCLITestServer(t *testing.T, root string) *cliTestServer {
	t.Helper()
	execPath := strings.TrimSpace(gitOutput(t, root, "--exec-path"))
	backend := filepath.Join(execPath, "git-http-backend")
	if _, err := os.Stat(backend); err != nil {
		t.Skipf("git-http-backend not available: %v", err)
	}
	s := &cliTestServer{t: t, backend: backend, root: root, held: make(chan struct{}, 64)}
	s.srv = httptest.NewServer(s)
	t.Cleanup(s.srv.Close)
	return s
}

func (s *cliTestServer) repoURL(name string) string { return s.srv.URL + "/" + name }

func (s *cliTestServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.user != "" {
		if u, p, ok := r.BasicAuth(); !ok || u != s.user || p != s.pass {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
	}
	if s.v0 {
		r.Header.Del("Git-Protocol")
	}
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/git-upload-pack") {
		if !s.inspect(w, r) {
			return
		}
	}
	cw := &countingWriter{ResponseWriter: w}
	h := &cgi.Handler{
		Path: s.backend,
		Root: "/",
		Env: []string{
			"GIT_PROJECT_ROOT=" + s.root,
			"GIT_HTTP_EXPORT_ALL=1",
			"GIT_CONFIG_NOSYSTEM=1",
			"GIT_CONFIG_GLOBAL=" + os.DevNull,
		},
	}
	h.ServeHTTP(cw, r)
	s.mu.Lock()
	s.sent += cw.n
	s.mu.Unlock()
}

// inspect classifies an upload-pack request and applies the server's delays.
// It reports whether the request should still be served.
func (s *cliTestServer) inspect(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	r.Body, r.ContentLength = io.NopCloser(bytes.NewReader(body)), int64(len(body))
	r.TransferEncoding = nil
	plain := body
	if r.Header.Get("Content-Encoding") == "gzip" {
		if zr, zErr := gzip.NewReader(bytes.NewReader(body)); zErr == nil {
			plain, _ = io.ReadAll(zr)
		}
	}
	switch {
	case bytes.Contains(plain, []byte("command=ls-refs")):
		s.mu.Lock()
		s.lsRefs++
		s.mu.Unlock()
		time.Sleep(s.lsRefsDelay)
	case bytes.Contains(plain, []byte("command=fetch")):
		s.mu.Lock()
		if bytes.Contains(plain, []byte("deepen ")) {
			s.commitFetch++
		} else {
			s.blobFetch++
			s.blobWants += bytes.Count(plain, []byte("want "))
		}
		hold := s.hold
		s.mu.Unlock()
		if hold != nil {
			s.held <- struct{}{}
			select {
			case <-hold:
			case <-r.Context().Done():
				return false
			}
		}
	}
	return true
}

// counts is a snapshot of what the server was asked for.
type counts struct {
	lsRefs, commitFetch, blobFetch, blobWants int
	sent                                      int64
}

func (s *cliTestServer) counts() counts {
	s.mu.Lock()
	defer s.mu.Unlock()
	return counts{s.lsRefs, s.commitFetch, s.blobFetch, s.blobWants, s.sent}
}

type countingWriter struct {
	http.ResponseWriter
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.ResponseWriter.Write(p)
	c.n += int64(n)
	return n, err
}

// newServedOrigin creates a bare origin served by srv as <name>, and a work
// clone that pushes to it. The origin allows filters, as GitHub does.
func newServedOrigin(t *testing.T, srvRoot, name string) (origin, work string) {
	t.Helper()
	origin = filepath.Join(srvRoot, name)
	work = filepath.Join(t.TempDir(), "work-"+strings.TrimSuffix(name, ".git"))
	runGit(t, srvRoot, "init", "--bare", "--quiet", "--initial-branch=main", origin)
	runGit(t, origin, "config", "uploadpack.allowFilter", "true")
	runGit(t, origin, "config", "uploadpack.allowAnySHA1InWant", "true")
	runGit(t, srvRoot, "init", "--quiet", "--initial-branch=main", work)
	runGit(t, work, "config", "user.email", "synthetic@example.test")
	runGit(t, work, "config", "user.name", "Synthetic Test")
	runGit(t, work, "config", "commit.gpgsign", "false")
	runGit(t, work, "remote", "add", "origin", origin)
	return origin, work
}

// pushAll commits everything in work and pushes it to main.
func pushAll(t *testing.T, work, msg string) string {
	t.Helper()
	sha := commitAll(t, work, msg)
	runGit(t, work, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main")
	return sha
}

// randomFile writes n random bytes to rel under work.
func randomFile(t *testing.T, work, rel string, n int) {
	t.Helper()
	b := make([]byte, n)
	f, err := os.Open("/dev/urandom")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := io.ReadFull(f, b); err != nil {
		t.Fatal(err)
	}
	writeRepoFile(t, work, rel, string(b))
}

// cliSource is a CLI-backend source of url under its own work dir.
func cliSource(url, revision, path, workDir string) *GitSource {
	return &GitSource{RepoURL: url, Revision: revision, Path: path, WorkDir: workDir, Shallow: true, Backend: GitBackendCLI}
}

func mustResolve(t *testing.T, src *GitSource) *ResolveResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	res, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("resolve %s@%s:%s: %v", src.RepoURL, src.Revision, src.Path, err)
	}
	return res
}

// requireGitCLI skips a test when the machine's git cannot run the backend.
func requireGitCLI(t *testing.T) {
	t.Helper()
	if _, err := gitCLI(); err != nil {
		t.Skip(err)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip(err)
	}
}

// missingObjects lists the objects reachable from rev that the mirror lacks.
func missingObjects(t *testing.T, mirror, rev string) []string {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), "git", "rev-list", "--objects", "--missing=print", rev) // #nosec G204 -- test helper
	cmd.Dir = mirror
	cmd.Env = append(os.Environ(), "GIT_NO_LAZY_FETCH=1")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-list in %s: %v", mirror, err)
	}
	var missing []string
	for _, line := range strings.Split(string(out), "\n") {
		if oid, ok := strings.CutPrefix(line, "?"); ok {
			missing = append(missing, oid)
		}
	}
	return missing
}

// cliMirrorDir is the CLI backend's mirror of src.
func cliMirrorDir(src *GitSource) string {
	return filepath.Join(src.WorkDir, gitCacheDirName, "mirrors", RepoCacheKey(src.RepoURL, src.credentialID())+".git")
}
