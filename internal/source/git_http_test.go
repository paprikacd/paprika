package source

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These tests exercise GitSource against a real smart-HTTP git server
// (castlemilk/git-http-backend) rather than local-path repos. The HTTP
// transport is what production repo-server resolves actually traverse —
// auth negotiation, ref advertisement, pack negotiation, and push.

const (
	gitHTTPImage    = "castlemilk/git-http-backend"
	gitHTTPUser     = "testuser"
	gitHTTPPassword = "testpass"
	gitHTTPRepo     = "test-repo"
)

type httpGitServer struct {
	url string
}

// startHTTPGitServer boots the git-http-backend container with its seeded
// repo (README.md on main) and waits until it answers the smart-HTTP
// protocol. The container is removed on test cleanup.
func startHTTPGitServer(t *testing.T) *httpGitServer {
	t.Helper()

	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("docker CLI not available")
	}
	if out, err := exec.Command(docker, "info", "--format", "{{.ServerVersion}}").CombinedOutput(); err != nil {
		t.Skipf("docker daemon not available: %v (%s)", err, out)
	}

	name := fmt.Sprintf("paprika-git-http-%d", time.Now().UnixNano())
	port := freeTCPPort(t)
	cmd := exec.Command(docker, "run", "-d", "--rm",
		"-p", fmt.Sprintf("127.0.0.1:%d:3000", port),
		"--name", name,
		gitHTTPImage)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("start git-http-backend: %v\n%s", err, out)
	}
	t.Cleanup(func() {
		_ = exec.Command(docker, "rm", "-f", name).Run()
	})

	srv := &httpGitServer{url: fmt.Sprintf("http://127.0.0.1:%d/%s.git", port, gitHTTPRepo)}

	// The seeded clone takes a moment before info/refs answers; auth failures
	// also prove the server is up.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, srv.url+"/info/refs?service=git-upload-pack", nil)
		req.SetBasicAuth(gitHTTPUser, gitHTTPPassword)
		resp, reqErr := http.DefaultClient.Do(req)
		if reqErr == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return srv
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("git-http-backend did not become ready in 60s")
	return nil
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("allocate port: %v", err)
	}
	defer lis.Close()
	return lis.Addr().(*net.TCPAddr).Port
}

func httpGitSource(t *testing.T, srv *httpGitServer, revision string) *GitSource {
	t.Helper()
	return &GitSource{
		RepoURL:  srv.url,
		Revision: revision,
		WorkDir:  t.TempDir(),
		Auth:     GitAuth{Username: gitHTTPUser, Password: gitHTTPPassword},
	}
}

func resolveHTTP(t *testing.T, src *GitSource) *ResolveResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("Resolve() error: %v", err)
	}
	return result
}

// gitHTTPClone fetches a working copy of the seeded repo so tests can push.
func gitHTTPClone(t *testing.T, srv *httpGitServer) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "work")
	credURL := strings.Replace(srv.url, "http://", "http://"+gitHTTPUser+":"+gitHTTPPassword+"@", 1)
	gitOutput(t, filepath.Dir(dir), "clone", credURL, dir)
	return dir
}

func gitHTTPPush(t *testing.T, workDir, ref string) {
	t.Helper()
	gitOutput(t, workDir, "push", "origin", ref)
}

func gitHTTPCommitFile(t *testing.T, workDir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(workDir, name)), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(workDir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	gitOutput(t, workDir, "add", name)
	gitOutput(t, workDir, "-c", "user.email=e2e@test", "-c", "user.name=e2e", "commit", "-m", "add "+name)
}

func TestGitSourceHTTP_AuthenticatedResolve(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	src := httpGitSource(t, srv, "")

	result := resolveHTTP(t, src)
	if result.LocalPath == "" {
		t.Fatal("expected LocalPath")
	}
	if _, err := os.Stat(filepath.Join(result.LocalPath, "README.md")); err != nil {
		t.Fatalf("expected seeded README.md in checkout: %v", err)
	}
	if result.Hash == "" {
		t.Fatal("expected Hash")
	}
	if result.Revision == "" {
		t.Fatal("expected resolved Revision")
	}
}

func TestGitSourceHTTP_WrongPasswordFails(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	src := httpGitSource(t, srv, "")
	src.Auth = GitAuth{Username: gitHTTPUser, Password: "wrong"}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := src.Resolve(ctx); err == nil {
		t.Fatal("expected auth failure, got success")
	}
}

func TestGitSourceHTTP_NoCredentialsFails(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	src := httpGitSource(t, srv, "")
	src.Auth = GitAuth{}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := src.Resolve(ctx); err == nil {
		t.Fatal("expected auth failure for anonymous access, got success")
	}
}

// A remote auth failure must not wipe or corrupt the local mirror cache —
// the next resolve with correct credentials should succeed from the same
// WorkDir.
func TestGitSourceHTTP_AuthFailurePreservesMirror(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	workDir := t.TempDir()

	good := &GitSource{RepoURL: srv.url, WorkDir: workDir,
		Auth: GitAuth{Username: gitHTTPUser, Password: gitHTTPPassword}}
	first := resolveHTTP(t, good)

	bad := &GitSource{RepoURL: srv.url, WorkDir: workDir,
		Auth: GitAuth{Username: gitHTTPUser, Password: "nope"}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := bad.Resolve(ctx); err == nil {
		t.Fatal("expected auth failure")
	}

	second := resolveHTTP(t, good)
	if second.Hash != first.Hash {
		t.Fatalf("cache state changed across auth failure: %q -> %q", first.Hash, second.Hash)
	}
	if _, err := os.Stat(filepath.Join(workDir, "git-mirrors", RepoCacheKey(srv.url, good.credentialID()))); err != nil {
		t.Fatalf("mirror cache lost: %v", err)
	}
}

func TestGitSourceHTTP_PushedCommitResolves(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	src := httpGitSource(t, srv, "")

	first := resolveHTTP(t, src)

	work := gitHTTPClone(t, srv)
	gitHTTPCommitFile(t, work, "marker.txt", "second commit")
	gitHTTPPush(t, work, "main")

	second := resolveHTTP(t, src)
	if second.Revision == first.Revision {
		t.Fatal("expected HEAD to advance after push")
	}
	if _, err := os.Stat(filepath.Join(second.LocalPath, "marker.txt")); err != nil {
		t.Fatalf("new commit not visible in checkout: %v", err)
	}
}

func TestGitSourceHTTP_PinnedCommitBelowLatest(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)

	// Record the seeded HEAD, then push a second commit so the pin sits
	// behind branch HEAD.
	work := gitHTTPClone(t, srv)
	pinned := gitOutput(t, work, "rev-parse", "HEAD")
	gitHTTPCommitFile(t, work, "marker.txt", "newer")
	gitHTTPPush(t, work, "main")

	src := httpGitSource(t, srv, pinned)
	result := resolveHTTP(t, src)
	if !strings.HasPrefix(result.Revision, pinned) {
		t.Fatalf("expected revision %s, got %s", pinned, result.Revision)
	}
	if _, err := os.Stat(filepath.Join(result.LocalPath, "marker.txt")); !os.IsNotExist(err) {
		t.Fatalf("pinned checkout should not contain the newer commit's file (err=%v)", err)
	}
}

func TestGitSourceHTTP_NonDefaultBranchResolves(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	work := gitHTTPClone(t, srv)
	gitOutput(t, work, "checkout", "-b", "release-1")
	gitHTTPCommitFile(t, work, "branch.txt", "on release-1")
	gitHTTPPush(t, work, "release-1")

	src := httpGitSource(t, srv, "release-1")
	result := resolveHTTP(t, src)
	if _, err := os.Stat(filepath.Join(result.LocalPath, "branch.txt")); err != nil {
		t.Fatalf("branch file missing from checkout: %v", err)
	}
}

func TestGitSourceHTTP_ShallowFetch(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	src := httpGitSource(t, srv, "")
	src.Shallow = true

	result := resolveHTTP(t, src)
	if result.LocalPath == "" {
		t.Fatal("expected LocalPath")
	}
	// Mirror must be a shallow boundary repo for branch refs when
	// Shallow is set.
	mirror := filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(srv.url, src.credentialID()))
	shallow := filepath.Join(mirror, "shallow")
	if _, err := os.Stat(shallow); err != nil {
		t.Fatalf("expected shallow marker in mirror: %v", err)
	}
}

func TestGitSourceHTTP_NestedPathResolves(t *testing.T) {
	t.Parallel()

	srv := startHTTPGitServer(t)
	work := gitHTTPClone(t, srv)
	gitHTTPCommitFile(t, work, "charts/demo/Chart.yaml", "apiVersion: v2\nname: demo\nversion: 0.0.1\n")
	gitHTTPPush(t, work, "main")

	src := httpGitSource(t, srv, "")
	src.Path = "charts/demo"
	result := resolveHTTP(t, src)
	if _, err := os.Stat(filepath.Join(result.LocalPath, "Chart.yaml")); err != nil {
		t.Fatalf("nested path did not yield chart dir: %v", err)
	}
}

func TestGitSourceHTTP_ServerUnreachableFails(t *testing.T) {
	t.Parallel()

	port := freeTCPPort(t)
	src := &GitSource{
		RepoURL: fmt.Sprintf("http://127.0.0.1:%d/missing.git", port),
		WorkDir: t.TempDir(),
		Auth:    GitAuth{Username: gitHTTPUser, Password: gitHTTPPassword},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := src.Resolve(ctx); err == nil {
		t.Fatal("expected connection failure")
	}
}
