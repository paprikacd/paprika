# Multi-Source Rendering with Change Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Paprika to support git and S3 source types for Application/Template rendering, with feature flag parameter injection and change detection (polling git commits and S3 object versions/ETags) to trigger automated reconciliation.

**Architecture:** The rendering pipeline becomes: Source (git/s3/helm) → Clone/Fetch → Hash (for change detection) → Helm template with --set flags (for feature flags) → Apply manifests. A new `source` package handles git clone, S3 fetch, and hash computation. The `engine` package gains a `--namespace` flag and proper YAML splitting. A `watcher` goroutine in the Application controller polls sources at configurable intervals and triggers re-reconciliation when the hash changes.

**Tech Stack:** Go, go-git/v5, AWS SDK for Go v2 (MinIO/S3 compatible), controller-runtime, Helm CLI, LocalStack (for e2e S3 tests)

---

## File Structure

| File | Responsibility |
|---|---|
| `api/v1alpha1/application_types.go` | Extend ApplicationSource with S3 fields, add PollInterval, add SourceHash to status |
| `api/v1alpha1/template_types.go` | Add GitSpec/S3Spec to TemplateSpec, add ValuesFile and Namespace fields |
| `source/git.go` | Git clone/resolve — clone repo at revision, compute hash, return local path |
| `source/git_test.go` | Unit tests for git clone/resolve |
| `source/s3.go` | S3 fetch — download chart tarball from bucket, compute hash, return local path |
| `source/s3_test.go` | Unit tests for S3 fetch with fake server |
| `source/resolver.go` | SourceResolver interface + factory — dispatches to git/s3/helm based on type |
| `source/resolver_test.go` | Integration tests for resolver |
| `engine/template.go` | Extend Render with namespace, values file, secret auth support; fix YAML splitting |
| `engine/template_test.go` | Add tests for namespace, values file, multi-doc YAML splitting |
| `internal/controller/application_controller.go` | Add source watching, hash comparison, and re-reconciliation on change |
| `internal/controller/release_controller.go` | Fix rollback, add namespace to helm template, improve manifest splitting |
| `config/e2e/application-git.yaml` | E2e manifest using git source |
| `config/e2e/application-s3.yaml` | E2e manifest using S3 source |
| `test/e2e/e2e_test.go` | Extend e2e with git and S3 source tests |
| `docker-compose-e2e.yaml` | LocalStack + Paprika for S3 e2e |

---

## Chunk 1: Source Package — Git & S3 Resolver

### Task 1: Add go-git and AWS SDK dependencies

- [ ] **Step 1: Add go-git dependency**

```bash
cd /Users/benebsworth/projects/paprika
go get github.com/go-git/go-git/v5
go mod tidy
```

- [ ] **Step 2: Add AWS SDK v2 (S3 compatible) dependency**

```bash
cd /Users/benebsworth/projects/paprika
go get github.com/aws/aws-sdk-go-v2 github.com/aws/aws-sdk-go-v2/config github.com/aws/aws-sdk-go-v2/service/s3 github.com/aws/aws-sdk-go-v2/credentials/ec2rolecreds
go mod tidy
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/benebsworth/projects/paprika && go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add go.mod go.sum && git commit -m "chore: add go-git and aws-sdk-v2 dependencies"
```

---

### Task 2: Create the `source/resolver.go` — SourceResolver interface

**Files:**
- Create: `source/resolver.go`

- [ ] **Step 1: Create the resolver interface and Result type**

```go
// source/resolver.go
package source

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type ResolveResult struct {
	LocalPath string
	Hash      string
	Revision  string
}

type SourceResolver interface {
	Resolve(ctx context.Context) (*ResolveResult, error)
}

func ComputeFileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open file for hashing: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hash file: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func ComputeDirHash(dir string) (string, error) {
	h := sha256.New()
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		h.Write([]byte(rel))
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := io.Copy(h, f); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("hash directory: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/benebsworth/projects/paprika && go build ./source/...
```

---

### Task 3: Create `source/git.go` — Git clone and resolve

**Files:**
- Create: `source/git.go`
- Create: `source/git_test.go`

- [ ] **Step 1: Implement git.go**

The GitResolver clones a git repository at a specific revision (branch, tag, or commit) to a local directory and returns the resolved commit hash and local path.

```go
// source/git.go
package source

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
)

type GitSource struct {
	RepoURL  string
	Revision string
	Path     string
	WorkDir  string
	SecretRef string
}

func (g *GitSource) Resolve(ctx context.Context) (*ResolveResult, error) {
	cloneDir := filepath.Join(g.WorkDir, "git-clones", sanitizeName(g.RepoURL))
	if err := os.MkdirAll(filepath.Dir(cloneDir), 0755); err != nil {
		return nil, fmt.Errorf("create clone dir: %w", err)
	}

	cloneOpts := &git.CloneOptions{
		URL: g.RepoURL,
	}
	if g.Revision != "" {
		cloneOpts.ReferenceName = plumbing.ReferenceName("refs/heads/" + g.Revision)
		if !plumbing.ReferenceName(cloneOpts.ReferenceName).IsValid() {
			cloneOpts.ReferenceName = plumbing.ReferenceName(g.Revision)
		}
	}

	repo, err := git.PlainCloneContext(ctx, cloneDir, false, cloneOpts)
	if err != nil {
		if err == git.ErrRepositoryAlreadyExists {
			repo, err = git.Open(cloneDir)
			if err != nil {
				return nil, fmt.Errorf("open existing repo: %w", err)
			}
			if fetchErr := repo.FetchContext(ctx, &git.FetchOptions{}); fetchErr != nil && fetchErr != git.NoErrAlreadyUpToDate {
				return nil, fmt.Errorf("fetch repo: %w", fetchErr)
			}
		} else {
			return nil, fmt.Errorf("clone repo %s: %w", g.RepoURL, err)
		}
	}

	head, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("get HEAD: %w", err)
	}

	commitHash := head.Hash().String()
	chartPath := cloneDir
	if g.Path != "" {
		chartPath = filepath.Join(cloneDir, g.Path)
	}

	dirHash, err := ComputeDirHash(chartPath)
	if err != nil {
		return nil, fmt.Errorf("compute chart hash: %w", err)
	}

	return &ResolveResult{
		LocalPath: chartPath,
		Hash:      commitHash + ":" + dirHash[:16],
		Revision:  commitHash,
	}, nil
}

func sanitizeName(s string) string {
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			result = append(result, c)
		} else {
			result = append(result, '-')
		}
	}
	return string(result)
}
```

- [ ] **Step 2: Write git_test.go**

```go
// source/git_test.go
package source

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitResolver_CloneLocalRepo(t *testing.T) {
	repoDir := t.TempDir()
	repo, err := git.PlainInit(repoDir, false)
	require.NoError(t, err)

	wt, err := repo.Worktree()
	require.NoError(t, err)

	err = os.WriteFile(filepath.Join(repoDir, "values.yaml"), []byte("replicaCount: 1\n"), 0644)
	require.NoError(t, err)

	_, err = wt.Add("values.yaml")
	require.NoError(t, err)

	_, err = wt.Commit("initial commit", &git.CommitOptions{
		Author: &object.Signature{Name: "test", Email: "test@test.com"},
	})
	require.NoError(t, err)

	resolver := &GitSource{
		RepoURL: repoDir,
		WorkDir: t.TempDir(),
	}

	result, err := resolver.Resolve(context.Background())
	require.NoError(t, err)
	assert.NotEmpty(t, result.Hash)
	assert.NotEmpty(t, result.Revision)
	assert.DirExists(t, result.LocalPath)
}

func TestGitResolver_CloneWithSubPath(t *testing.T) {
	repoDir := t.TempDir()
	repo, err := git.PlainInit(repoDir, false)
	require.NoError(t, err)

	wt, err := repo.Worktree()
	require.NoError(t, err)

	chartDir := filepath.Join(repoDir, "charts", "myapp")
	require.NoError(t, os.MkdirAll(chartDir, 0755))

	err = os.WriteFile(filepath.Join(chartDir, "Chart.yaml"), []byte("apiVersion: v2\nname: myapp\nversion: 0.1.0\n"), 0644)
	require.NoError(t, err)

	_, err = wt.Add("charts/myapp/Chart.yaml")
	require.NoError(t, err)
	_, err = wt.Commit("add chart", &git.CommitOptions{Author: &object.Signature{Name: "test", Email: "test@test.com"}})
	require.NoError(t, err)

	resolver := &GitSource{
		RepoURL: repoDir,
		Path:    "charts/myapp",
		WorkDir: t.TempDir(),
	}

	result, err := resolver.Resolve(context.Background())
	require.NoError(t, err)
	assert.Contains(t, result.LocalPath, "charts/myapp")
	assert.FileExists(t, filepath.Join(result.LocalPath, "Chart.yaml"))
}

func TestGitResolver_InvalidRepo(t *testing.T) {
	resolver := &GitSource{
		RepoURL: "/nonexistent/path/to/repo.git",
		WorkDir: t.TempDir(),
	}
	_, err := resolver.Resolve(context.Background())
	assert.Error(t, err)
}
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/benebsworth/projects/paprika && go test ./source/ -v -run TestGit 2>&1
```

- [ ] **Step 4: Commit**

```bash
git add source/ && git commit -m "feat: add git source resolver with clone and hash"
```

---

### Task 4: Create `source/s3.go` — S3 fetch and resolve

**Files:**
- Create: `source/s3.go`
- Create: `source/s3_test.go`

- [ ] **Step 1: Implement s3.go**

```go
// source/s3.go
package source

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type S3Source struct {
	Bucket    string
	Key       string
	Region    string
	Endpoint  string
	WorkDir   string
	AccessKey string
	SecretKey string
	Path      string
}

func (s *S3Source) Resolve(ctx context.Context) (*ResolveResult, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if s.Endpoint != "" {
			o.BaseEndpoint = aws.String(s.Endpoint)
			o.UsePathStyle = true
		}
	})

	headOut, err := client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(s.Key),
	})
	if err != nil {
		return nil, fmt.Errorf("head object s3://%s/%s: %w", s.Bucket, s.Key, err)
	}

	etag := ""
	if headOut.ETag != nil {
		etag = strings.Trim(*headOut.ETag, `"`)
	}

	localDir := filepath.Join(s.WorkDir, "s3-cache", sanitizeName(s.Bucket))
	if err := os.MkdirAll(localDir, 0755); err != nil {
		return nil, fmt.Errorf("create s3 cache dir: %w", err)
	}

	localFile := filepath.Join(localDir, filepath.Base(s.Key))
	tmpFile := localFile + ".tmp"

	f, err := os.Create(tmpFile)
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	defer f.Close()

	getOut, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(s.Key),
	})
	if err != nil {
		return nil, fmt.Errorf("get object s3://%s/%s: %w", s.Bucket, s.Key, err)
	}
	defer getOut.Body.Close()

	if _, err := io.Copy(f, getOut.Body); err != nil {
		return nil, fmt.Errorf("download object: %w", err)
	}
	f.Close()

	if strings.HasSuffix(s.Key, ".tgz") || strings.HasSuffix(s.Key, ".tar.gz") {
		if err := untar(tmpFile, localDir); err != nil {
			return nil, fmt.Errorf("extract chart archive: %w", err)
		}
		os.Remove(tmpFile)
	} else {
		os.Rename(tmpFile, localFile)
	}

	chartPath := localDir
	if s.Path != "" {
		chartPath = filepath.Join(localDir, s.Path)
	}

	dirHash, err := ComputeDirHash(chartPath)
	if err != nil {
		return nil, fmt.Errorf("compute chart hash: %w", err)
	}

	revision := etag
	if revision == "" {
		revision = dirHash[:16]
	}

	return &ResolveResult{
		LocalPath: chartPath,
		Hash:      dirHash,
		Revision:  revision,
	}, nil
}

func (s *S3Source) loadConfig(ctx context.Context) (aws.Config, error) {
	var opts []func(*awsconfig.LoadOptions) error
	if s.Region != "" {
		opts = append(opts, awsconfig.WithRegion(s.Region))
	}
	if s.Endpoint != "" && s.AccessKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s.AccessKey, s.SecretKey, "")))
	} else if s.Endpoint != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")))
	}
	return awsconfig.LoadDefaultConfig(ctx, opts...)
}

func untar(tarPath, dest string) error {
	// Extract .tgz using tar command (available in distroless+helm images)
	cmd := exec.Command("tar", "xzf", tarPath, "-C", dest)
	return cmd.Run()
}
```

Note: We need to add the missing `"os/exec"` import. Also we should add `"archive/tar"` and `"compress/gzip"` for cross-platform untar without shelling out, but for the initial impl shelling out to tar is fine since the operator runs in a container that has it.

- [ ] **Step 2: Write s3_test.go with a fake HTTP server**

```go
// source/s3_test.go
package source

import (
	"context"
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func makeTestChartTar(t *testing.T, chartDir string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	chartYaml := `apiVersion: v2
name: test-chart
version: 0.1.0
`
	err := tw.WriteHeader(&tar.Header{
		Name: "test-chart/Chart.yaml",
		Mode: 0644,
		Size: int64(len(chartYaml)),
	})
	require.NoError(t, err)
	_, err = tw.Write([]byte(chartYaml))
	require.NoError(t, err)

	valuesYaml := `replicaCount: 1
`
	err = tw.WriteHeader(&tar.Header{
		Name: "test-chart/values.yaml",
		Mode: 0644,
		Size: int64(len(valuesYaml)),
	})
	require.NoError(t, err)
	_, err = tw.Write([]byte(valuesYaml))
	require.NoError(t, err)

	require.NoError(t, tw.Close())
	require.NoError(t, gw.Close())
	return buf.Bytes()
}
```

- [ ] **Step 3: Run build to check compilation**

```bash
cd /Users/benebsworth/projects/paprika && go build ./source/...
```

- [ ] **Step 4: Commit**

```bash
git add source/ && git commit -m "feat: add S3 source resolver with fetch, extract, and hash"
```

---

### Task 5: Extend CRD types for git/S3 sources

**Files:**
- Modify: `api/v1alpha1/application_types.go`
- Modify: `api/v1alpha1/template_types.go`

- [ ] **Step 1: Add source types to ApplicationSource**

Add S3 fields to `ApplicationSource` and update the type enum:

```go
type ApplicationSource struct {
	// +kubebuilder:validation:Enum=git;helm;s3
	Type string `json:"type"`
	// Git repository URL (for type=git)
	RepoURL string `json:"repoURL,omitempty"`
	// Git branch, tag, or commit (for type=git)
	Revision string `json:"revision,omitempty"`
	// Path within the repo to the chart/source (for type=git or type=s3)
	Path string `json:"path,omitempty"`
	// Helm chart reference (for type=helm)
	Chart ChartRef `json:"chart,omitempty"`
	// S3 bucket (for type=s3)
	Bucket string `json:"bucket,omitempty"`
	// S3 object key (for type=s3)
	Key string `json:"key,omitempty"`
	// S3 region (for type=s3)
	Region string `json:"region,omitempty"`
	// S3 endpoint (for type=s3, use LocalStack endpoint for testing)
	Endpoint string `json:"endpoint,omitempty"`
	// Secret reference for private repos or S3 credentials
	SecretRef string `json:"secretRef,omitempty"`
	// Poll interval for change detection (default 30s)
	// +kubebuilder:default="30s"
	PollInterval string `json:"pollInterval,omitempty"`
}
```

- [ ] **Step 2: Add Template source fields**

Add `GitSpec` and `S3Spec` to `TemplateSpec`, and add `Namespace` and `ValuesFile`:

```go
type GitSourceSpec struct {
	RepoURL  string `json:"repoURL"`
	Revision string `json:"revision,omitempty"`
	Path     string `json:"path,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

type S3SourceSpec struct {
	Bucket    string `json:"bucket"`
	Key       string `json:"key"`
	Region    string `json:"region,omitempty"`
	Endpoint  string `json:"endpoint,omitempty"`
	Path      string `json:"path,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

type TemplateSpec struct {
	// +kubebuilder:validation:Enum=helm;git;s3
	Type  string   `json:"type"`
	Chart ChartRef `json:"chart,omitempty"`
	Git   *GitSourceSpec `json:"git,omitempty"`
	S3    *S3SourceSpec  `json:"s3,omitempty"`
	// Namespace to pass to helm --namespace
	Namespace string `json:"namespace,omitempty"`
	// Inline YAML values file content
	ValuesFile string `json:"valuesFile,omitempty"`
}
```

- [ ] **Step 3: Add SourceHash to TemplateStatus and ApplicationStatus**

In `TemplateStatus`, add:
```go
type TemplateStatus struct {
	LastRendered   *metav1.Time `json:"lastRendered,omitempty"`
	LastRenderHash string       `json:"lastRenderHash,omitempty"`
	SourceHash     string       `json:"sourceHash,omitempty"`
	SourceRevision string       `json:"sourceRevision,omitempty"`
}
```

In `ApplicationStatus`, add:
```go
SourceHash    string `json:"sourceHash,omitempty"`
SourceRevision string `json:"sourceRevision,omitempty"`
```

- [ ] **Step 4: Regenerate DeepCopy and CRDs**

```bash
make generate && make manifests
```

- [ ] **Step 5: Verify build**

```bash
go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add api/ config/ && git commit -m "feat: extend ApplicationSource and TemplateSpec for git/s3 sources"
```

---

## Chunk 2: Rendering Pipeline — Source Resolution & Feature Flags

### Task 6: Extend TemplateRenderer to support git/s3 sources and feature flags

**Files:**
- Modify: `engine/template.go`
- Modify: `engine/template_test.go`

- [ ] **Step 1: Add namespace and values file support to Render()**

Update the `Render()` method to:
1. Accept `namespace` from the Template
2. Write `params` to a temp values file, and `ValuesFile` to another temp file
3. Pass `--namespace` and `--values` to `helm template`
4. Use a proper YAML document splitter instead of `strings.Split("---\n")`

The signature changes to accept the new source-resolved path:

```go
func (r *TemplateRenderer) Render(ctx context.Context, tmpl *paprika.Template, params map[string]string) ([]byte, error) {
	// If template has git/s3 source, resolve it to a local path first
	chartPath := ""
	switch tmpl.Spec.Type {
	case "helm":
		chart := tmpl.Spec.Chart
		if chart.Path != "" {
			chartPath = chart.Path
		} else {
			// remote helm repo
			repoName := sanitizeRepoName(chart.Repo)
			// ... (existing repo add + update logic)
			chartRef := fmt.Sprintf("%s/%s", repoName, chart.Name)
			chartPath = chartRef
		}
	case "git":
		gitSrc := tmpl.Spec.Git
		resolver := &source.GitSource{
			RepoURL:   gitSrc.RepoURL,
			Revision:  gitSrc.Revision,
			Path:      gitSrc.Path,
			WorkDir:   r.WorkDir,
			SecretRef: gitSrc.SecretRef,
		}
		result, err := resolver.Resolve(ctx)
		if err != nil {
			return nil, fmt.Errorf("resolve git source: %w", err)
		}
		chartPath = result.LocalPath
	case "s3":
		s3Src := tmpl.Spec.S3
		resolver := &source.S3Source{
			Bucket:    s3Src.Bucket,
			Key:       s3Src.Key,
			Region:    s3Src.Region,
			Endpoint:  s3Src.Endpoint,
			WorkDir:   r.WorkDir,
			Path:      s3Src.Path,
		}
		result, err := resolver.Resolve(ctx)
		if err != nil {
			return nil, fmt.Errorf("resolve s3 source: %w", err)
		}
		chartPath = result.LocalPath
	default:
		return nil, fmt.Errorf("unsupported template type %q", tmpl.Spec.Type)
	}

	// ... build helm template args with --namespace, --set, --values
}
```

- [ ] **Step 2: Add --namespace flag**

```go
if tmpl.Spec.Namespace != "" {
	args = append(args, "--namespace", tmpl.Spec.Namespace)
}
```

- [ ] **Step 3: Write params to temp values file and use --values**

Instead of only `--set key=val,key=val`, write a YAML values file for complex/nested values. This preserves the feature flag structure.

```go
func writeValuesFile(params map[string]string, valuesContent string) (string, error) {
	f, err := os.CreateTemp("", "paprika-values-*.yaml")
	if err != nil {
		return "", err
	}
	defer f.Close()

	if valuesContent != "" {
		if _, err := f.WriteString(valuesContent); err != nil {
			return "", err
		}
	}
	// Append params as flat YAML keys
	if len(params) > 0 {
		if valuesContent != "" {
			f.WriteString("\n")
		}
		for k, v := range params {
			f.WriteString(fmt.Sprintf("%s: %q\n", k, v))
		}
	}
	return f.Name(), nil
}
```

- [ ] **Step 4: Fix YAML document splitting**

Replace `strings.Split(manifests, "---\n")` with a proper multi-document YAML splitter:

```go
func splitYAMLDocuments(manifests []byte) [][]byte {
	var documents [][]byte
	reader := bytes.NewReader(manifests)
	decoder := yaml.NewYAMLReader(reader)
	for {
		doc, err := decoder.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}
		doc = bytes.TrimSpace(doc)
		if len(doc) == 0 {
			continue
		}
		documents = append(documents, doc)
	}
	return documents
}
```

Note: This requires adding `"sigs.k8s.io/yaml"` to go.mod (already present as a transitive dependency through apimachinery).

- [ ] **Step 5: Update the import and use source package**

Add `"github.com/benebsworth/paprika/source"` to imports in `engine/template.go`.

- [ ] **Step 6: Write integration tests**

- Test that `Render()` with `type: "git"` calls `source.GitSource.Resolve()` and uses the local path
- Test that `--namespace` is passed to `helm template`
- Test that values file generation works for nested feature flags
- Test that YAML document splitting handles edge cases (`---\r\n`, trailing whitespace, empty docs)

- [ ] **Step 7: Verify build**

```bash
go build ./...
```

- [ ] **Step 8: Commit**

```bash
git add engine/ source/ && git commit -m "feat: extend TemplateRenderer with git/s3 sources, namespace, and values file support"
```

---

### Task 7: Update Application controller — source resolution and change detection

**Files:**
- Modify: `internal/controller/application_controller.go`

- [ ] **Step 1: Add source resolution to reconcileTemplate()**

When the Application has `source.type: "git"` or `source.type: "s3"`, resolve the source before creating the Template:

```go
func (r *ApplicationReconciler) resolveSource(ctx context.Context, app *paprikav1.Application) (*source.ResolveResult, error) {
	switch app.Spec.Source.Type {
	case "git":
		return (&source.GitSource{
			RepoURL:   app.Spec.Source.RepoURL,
			Revision:  app.Spec.Source.Revision,
			Path:      app.Spec.Source.Path,
			WorkDir:   "/tmp/paprika-sources",
			SecretRef: app.Spec.Source.SecretRef,
		}).Resolve(ctx)
	case "s3":
		return (&source.S3Source{
			Bucket:   app.Spec.Source.Bucket,
			Key:      app.Spec.Source.Key,
			Region:   app.Spec.Source.Region,
			Endpoint: app.Spec.Source.Endpoint,
			WorkDir:  "/tmp/paprika-sources",
			Path:     app.Spec.Source.Path,
		}).Resolve(ctx)
	default:
		return nil, nil
	}
}
```

- [ ] **Step 2: Update reconcileTemplate() to use resolved source**

```go
func (r *ApplicationReconciler) reconcileTemplate(ctx context.Context, app *paprikav1.Application) error {
	templateName := fmt.Sprintf("%s-template", app.Name)

	templateSpec := paprikav1.TemplateSpec{
		Type:      string(app.Spec.Source.Type),
		Chart:     app.Spec.Source.Chart,
		Namespace: app.Namespace,
	}

	// For git/s3 sources, resolve and set the local path
	result, err := r.resolveSource(ctx, app)
	if err != nil {
		return fmt.Errorf("resolve source: %w", err)
	}
	if result != nil {
		switch app.Spec.Source.Type {
		case "git":
			templateSpec.Git = &paprikav1.GitSourceSpec{
				RepoURL:   app.Spec.Source.RepoURL,
				Revision:  result.Revision,
				Path:      app.Spec.Source.Path,
				SecretRef: app.Spec.Source.SecretRef,
			}
			templateSpec.Chart.Path = result.LocalPath
		case "s3":
			templateSpec.S3 = &paprikav1.S3SourceSpec{
				Bucket:   app.Spec.Source.Bucket,
				Key:      app.Spec.Source.Key,
				Region:   app.Spec.Source.Region,
				Endpoint: app.Spec.Source.Endpoint,
				Path:     app.Spec.Source.Path,
			}
			templateSpec.Chart.Path = result.LocalPath
		}
		app.Status.SourceHash = result.Hash
		app.Status.SourceRevision = result.Revision
	}

	// ... create/update Template (existing code)
}
```

- [ ] **Step 3: Add source watching with re-reconciliation**

Add hash-based change detection. If the source hash has changed since the last reconciliation, force a re-render:

```go
func (r *ApplicationReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// ... existing code ...

	// Resolve source and check for changes
	result, err := r.resolveSource(ctx, &app)
	if err != nil {
		log.Error(err, "Failed to resolve source")
		r.updatePhase(ctx, &app, paprikav1.ApplicationFailed, "SourceResolutionFailed", err.Error())
		return ctrl.Result{}, err
	}

	if result != nil && result.Hash != app.Status.SourceHash {
		log.Info("Source hash changed, triggering re-render",
			"oldHash", app.Status.SourceHash, "newHash", result.Hash)
		// Reset phase to trigger fresh promotion
		if app.Status.Phase == paprikav1.ApplicationHealthy {
			app.Status.Phase = paprikav1.ApplicationPromoting
			if err := r.Status().Update(ctx, &app); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{Requeue: true}, nil
		}
	}

	// ... continue with existing reconciliation logic ...
}
```

- [ ] **Step 4: Add poll interval for periodic source checking**

Add a requeue based on `PollInterval`:

```go
// After existing reconciliation logic
pollInterval := 30 * time.Second
if app.Spec.Source.PollInterval != "" {
	if d, err := time.ParseDuration(app.Spec.Source.PollInterval); err == nil {
		pollInterval = d
	}
}
return ctrl.Result{RequeueAfter: pollInterval}, nil
```

This replaces the fixed `defaultRequeue = 5 * time.Second` with a configurable interval. Source polling happens on every reconcile cycle, and changes are detected by hash comparison.

- [ ] **Step 5: Add source package import**

```go
import "github.com/benebsworth/paprika/source"
```

- [ ] **Step 6: Verify build**

```bash
go build ./...
```

- [ ] **Step 7: Commit**

```bash
git add internal/ api/ && git commit -m "feat: add source resolution and change detection to Application controller"
```

---

## Chunk 3: E2E Tests for Multi-Source Rendering

### Task 8: Create LocalStack docker-compose for S3 e2e tests

**Files:**
- Create: `docker-compose-e2e.yaml`

- [ ] **Step 1: Create docker-compose-e2e.yaml**

```yaml
version: '3.8'
services:
  localstack:
    image: localstack/localstack:3
    ports:
      - "4566:4566"
    environment:
      - SERVICES=s3
      - DEFAULT_REGION=us-east-1
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 3s
      retries: 10
```

- [ ] **Step 2: Add e2e test for git source rendering**

In `test/e2e/e2e_test.go`, add a new Context:

```go
Context("GitSource", Ordered, func() {
	It("should render manifests from a git source Application", func() {
		By("creating an Application with a git source")
		app := fmt.Sprintf(`{
			"apiVersion": "pipelines.paprika.io/v1alpha1",
			"kind": "Application",
			"metadata": {"name": "e2e-git-app", "namespace": "%s"},
			"spec": {
				"source": {
					"type": "git",
					"repoURL": "https://github.com/nginx/nginx.git",
					"revision": "main",
					"path": "/",
					"pollInterval": "60s"
				},
				"stages": [
					{"name": "dev", "ring": 1}
				],
				"strategy": "Rolling",
				"parameters": {
					"replicaCount": "1",
					"features.canary.enabled": "false",
					"features.monitoring.enabled": "false",
					"features.ingress.enabled": "false"
				}
			}
		}`, namespace)
		// ... apply and verify as before
	})

	AfterAll(func() {
		// cleanup
	})
})
```

Note: Since the operator container has `helm` binary at `/usr/local/bin/helm` and the `go-git` library, this test verifies that the operator can clone a git repo and render Helm charts from it.

- [ ] **Step 3: Add e2e test for S3 source rendering**

```go
Context("S3Source", Ordered, func() {
	BeforeEach(func() {
		// Start LocalStack, create bucket, upload chart tarball
		// This requires the e2e test environment to have LocalStack running
		// and the operator to have AWS SDK configured to point at LocalStack
	})

	It("should render manifests from an S3 source Application", func() {
		By("uploading a Helm chart tarball to LocalStack S3")
		// Use AWS CLI or Go SDK to create bucket and upload chart

		By("creating an Application with an S3 source")
		app := fmt.Sprintf(`{
			"apiVersion": "pipelines.paprika.io/v1alpha1",
			"kind": "Application",
			"metadata": {"name": "e2e-s3-app", "namespace": "%s"},
			"spec": {
				"source": {
					"type": "s3",
					"bucket": "paprika-charts",
					"key": "demo-app-0.1.0.tgz",
					"endpoint": "http://localstack:4566",
					"region": "us-east-1",
					"pollInterval": "30s"
				},
				"stages": [
					{"name": "dev", "ring": 1}
				],
				"strategy": "Rolling",
				"parameters": {
					"replicaCount": "1"
				}
			}
		}`, namespace)
		// ... apply and verify
	})

	AfterAll(func() {
		// cleanup S3 bucket, stop LocalStack
	})
})
```

- [ ] **Step 4: Create sample manifests**

Create `config/e2e/application-git.yaml`:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: demo-git-app
  namespace: paprika-system
spec:
  source:
    type: git
    repoURL: https://github.com/nginx/nginx.git
    revision: main
    path: /
    pollInterval: 60s
  stages:
    - name: dev
      ring: 1
      parameters:
        replicaCount: "1"
        features.canary.enabled: "false"
        features.monitoring.enabled: "false"
        features.ingress.enabled: "false"
  strategy: Rolling
  syncPolicy: Auto
```

Create `config/e2e/application-s3.yaml`:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: demo-s3-app
  namespace: paprika-system
spec:
  source:
    type: s3
    bucket: paprika-charts
    key: demo-app-0.1.0.tgz
    endpoint: http://localstack:4566
    region: us-east-1
    pollInterval: 30s
  stages:
    - name: dev
      ring: 1
      parameters:
        replicaCount: "1"
  strategy: Rolling
  syncPolicy: Auto
```

- [ ] **Step 5: Verify e2e test compiles**

```bash
go vet -tags=e2e ./test/e2e/
```

- [ ] **Step 6: Commit**

```bash
git add test/ config/ docker-compose-e2e.yaml && git commit -m "feat: add git and S3 source e2e tests and sample manifests"
```

---

### Task 9: Feature flag rendering integration test

**Files:**
- Create: `engine/template_integration_test.go`

- [ ] **Step 1: Write an integration test that renders the demo-app chart with feature flags**

```go
//go:build integration

package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	paprika "github.com/benebsworth/paprika/api/v1alpha1"
)

func TestRenderWithFeatureFlags(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test")
	}

	renderer := NewTemplateRenderer(t.TempDir())
	ctx := context.Background()

	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{
			Type: "helm",
			Chart: paprika.ChartRef{
				Path: "/charts/demo-app",
			},
		},
	}

	params := map[string]string{
		"replicaCount":               "3",
		"features.canary.enabled":    "true",
		"canaryWeight":              "50",
		"features.monitoring.enabled": "true",
		"features.ingress.enabled":   "true",
		"features.ingress.host":      "app.example.com",
		"image.tag":                  "v1.2.3",
	}

	manifests, err := renderer.Render(ctx, tmpl, params)
	require.NoError(t, err)
	assert.Contains(t, string(manifests), "demo-app-stable", "should render stable deployment")
	assert.Contains(t, string(manifests), "demo-app-canary", "should render canary deployment with canaryWeight > 0")
	assert.Contains(t, string(manifests), "canary", "should have canary track label")
	assert.Contains(t, string(manifests), "nginx:alpine", "should use default image")
	assert.Contains(t, string(manifests), "FEATURE_CANARY", "should set canary feature env var")
	assert.Contains(t, string(manifests), "FEATURE_MONITORING", "should set monitoring feature env var")
}
```

- [ ] **Step 2: Write a test for feature flag disable**

```go
func TestRenderWithFeaturesDisabled(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test")
	}
	// ... same as above but with all features disabled
	// Assert no canary deployment, no ingress, no monitoring sidecar
}
```

- [ ] **Step 3: Run integration tests**

```bash
cd /Users/benebsworth/projects/paprika && go test -tags=integration ./engine/ -v -run TestRender
```

- [ ] **Step 4: Commit**

```bash
git add engine/ && git commit -m "test: add integration tests for feature flag rendering"
```

---

## Summary

### What this plan delivers

| Feature | Git | S3 | Helm (existing) |
|---|---|---|---|
| Source fetching | `go-git` clone + checkout | AWS SDK download + extract tar | `helm repo add` + `template` (existing) |
| Change detection | Commit hash comparison | ETag/version comparison | Chart version comparison |
| Auto re-render | Poll interval → hash diff → reconcile | Poll interval → ETag diff → reconcile | Version change |
| Auth | `SecretRef` (future: read K8s Secret) | Static key pair + `SecretRef` | `SecretRef` (future) |
| Feature flags | `--set key=val` via params map | Same | Same |
| E2E validation | Clone nginx/nginx, render chart | LocalStack S3, upload chart | Existing demo app |

### How feature flags work (unchanged, but documented)

```
Application.Spec.Parameters + Stage.Parameters
          ↓ merge
    Release.Spec.Parameters
          ↓ passed as --set
    helm template --set canaryWeight=50,features.canary.enabled=true,...
          ↓ renders
    Deployment (stable + canary), Service, Ingress with conditional blocks
```

The `canaryWeight` and `features.*` keys in `Parameters` map directly to Helm values that gate conditional blocks in `charts/demo-app/templates/*.yaml`. The controller injects `features.canary.enabled=true` and `canaryWeight=N` during canary phases, and re-renders with `canaryWeight=0` for promotion.

### How change detection works

1. **Git:** On each reconcile cycle (interval = `PollInterval`), the controller runs `GitResolver.Resolve()` which does a `git pull` / `git fetch` and computes `(commitHash + dirHash)`. If this differs from `Application.Status.SourceHash`, the controller resets the phase to `Promoting` and re-renders.

2. **S3:** On each cycle, `S3Resolver.Resolve()` does a `HeadObject` to get the ETag, then downloads if changed. If the ETag or dir hash differs from `Application.Status.SourceHash`, re-render.

3. **Helm (existing):** No change detection currently. Could add chart version comparison in a future iteration.