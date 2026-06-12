package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/cli"
	helmg "helm.sh/helm/v3/pkg/getter"
	"helm.sh/helm/v3/pkg/repo"

	"sigs.k8s.io/yaml"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/source"
)

const (
	cacheDirPerm   = 0o750
	filePerm       = 0o640
	sourceTypeGit  = "git"
	sourceTypeS3   = "s3"
	sourceTypeHelm = "helm"
	sourceTypeOCI  = "oci"
)

var (
	helmSettings     = cli.New()
	helmSettingsOnce sync.Once
)

func initHelmSettings() {
	helmSettingsOnce.Do(func() {
		helmSettings.RegistryConfig = "/tmp/helm/registry.json"
		helmSettings.RepositoryConfig = "/tmp/helm/repositories.yaml"
		helmSettings.RepositoryCache = "/tmp/helm/cache"
	})
}

// HelmSDKRenderer renders Helm charts using the Helm v3 SDK.
// This replaces the legacy TemplateRendererImpl which shelled out to the helm binary.
type HelmSDKRenderer struct {
	WorkDir string
}

// NewHelmSDKRenderer creates a new HelmSDKRenderer with the given working directory.
func NewHelmSDKRenderer(workDir string) *HelmSDKRenderer {
	initHelmSettings()
	return &HelmSDKRenderer{WorkDir: workDir}
}

// ResolveSource resolves a template source (git, S3, etc.) and returns the local path.
func (r *HelmSDKRenderer) ResolveSource(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	switch tmpl.Spec.Type {
	case sourceTypeGit:
		return r.resolveGitSource(ctx, tmpl)
	case sourceTypeS3:
		return r.resolveS3Source(ctx, tmpl)
	case sourceTypeOCI:
		return r.resolveOCISource(ctx, tmpl)
	default:
		return nil, nil
	}
}

func (r *HelmSDKRenderer) resolveOCISource(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	ociSrc := tmpl.Spec.OCI
	if ociSrc == nil {
		return nil, errors.New("oci source spec is required for type=oci")
	}
	result, err := (&source.OCISource{
		URL:      ociSrc.URL,
		Tag:      ociSrc.Tag,
		Insecure: ociSrc.Insecure,
		WorkDir:  r.WorkDir,
	}).Resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve oci source: %w", err)
	}
	return result, nil
}

func (r *HelmSDKRenderer) resolveGitSource(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	gitSrc := tmpl.Spec.Git
	if gitSrc == nil {
		return nil, errors.New("git source spec is required for type=git")
	}
	result, err := (&source.GitSource{
		RepoURL:   gitSrc.RepoURL,
		Revision:  gitSrc.Revision,
		Path:      gitSrc.Path,
		WorkDir:   r.WorkDir,
		SecretRef: gitSrc.SecretRef,
	}).Resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve git source: %w", err)
	}
	return result, nil
}

func (r *HelmSDKRenderer) resolveS3Source(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	s3Src := tmpl.Spec.S3
	if s3Src == nil {
		return nil, errors.New("s3 source spec is required for type=s3")
	}
	result, err := (&source.S3Source{
		Bucket:   s3Src.Bucket,
		Key:      s3Src.Key,
		Region:   s3Src.Region,
		Endpoint: s3Src.Endpoint,
		WorkDir:  r.WorkDir,
		Path:     s3Src.Path,
	}).Resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve s3 source: %w", err)
	}
	return result, nil
}

// Render renders a single Helm template and returns the resulting YAML manifests.
func (r *HelmSDKRenderer) Render(ctx context.Context, tmpl *paprika.Template, params map[string]string) ([]byte, error) {
	chartPath, err := r.resolveChartPath(ctx, tmpl)
	if err != nil {
		return nil, fmt.Errorf("resolve chart path: %w", err)
	}

	c, err := loader.Load(chartPath)
	if err != nil {
		return nil, fmt.Errorf("load chart from %s: %w", chartPath, err)
	}

	if depErr := r.ensureChartDeps(c); depErr != nil {
		return nil, fmt.Errorf("ensure chart dependencies: %w", depErr)
	}

	vals, err := r.buildValues(params, tmpl.Spec.ValuesFile)
	if err != nil {
		return nil, fmt.Errorf("build values: %w", err)
	}

	client := action.NewInstall(&action.Configuration{})
	client.DryRun = true
	client.Replace = true
	client.ClientOnly = true
	client.IncludeCRDs = true
	releaseName := params["release-name"]
	if releaseName == "" {
		releaseName = "paprika-release"
	}
	client.ReleaseName = releaseName
	if tmpl.Spec.Namespace != "" {
		client.Namespace = tmpl.Spec.Namespace
	}

	rel, err := client.Run(c, vals)
	if err != nil {
		return nil, fmt.Errorf("helm template run failed: %w", err)
	}

	var buf bytes.Buffer
	for _, m := range rel.Manifest {
		if m != 0 {
			buf.WriteRune(m)
		}
	}

	return buf.Bytes(), nil
}

func (r *HelmSDKRenderer) resolveChartPath(ctx context.Context, tmpl *paprika.Template) (string, error) {
	if tmpl.Spec.Type == sourceTypeHelm {
		chart := tmpl.Spec.Chart
		if chart.Path != "" {
			return chart.Path, nil
		}
		return r.downloadChart(ctx, chart)
	}

	result, err := r.ResolveSource(ctx, tmpl)
	if err != nil {
		return "", fmt.Errorf("resolve source: %w", err)
	}
	if result == nil {
		return "", fmt.Errorf("source resolution returned nil for type=%s", tmpl.Spec.Type)
	}
	return result.LocalPath, nil
}

func (r *HelmSDKRenderer) downloadChart(ctx context.Context, chartRef paprika.ChartRef) (string, error) {
	if chartRef.Repo == "" || chartRef.Name == "" {
		return "", errors.New("chart repo and name are required for remote charts")
	}

	if source.IsOCIURL(chartRef.Repo) {
		return r.downloadOCIChart(ctx, chartRef)
	}

	if err := r.ensureRepo(ctx, chartRef.Repo); err != nil {
		return "", fmt.Errorf("ensure repo: %w", err)
	}
	return r.downloadHTTPChart(ctx, chartRef)
}

func (r *HelmSDKRenderer) downloadHTTPChart(ctx context.Context, chartRef paprika.ChartRef) (string, error) {
	chartURL, err := repo.FindChartInAuthRepoURL(
		chartRef.Repo, "", "",
		chartRef.Name, chartRef.Version,
		"", "", "",
		helmg.All(helmSettings),
	)
	if err != nil {
		return "", fmt.Errorf("find chart %s@%s: %w", chartRef.Name, chartRef.Version, err)
	}

	dl := helmg.All(helmSettings)
	g, err := dl.ByScheme("https")
	if err != nil {
		return "", fmt.Errorf("create https getter: %w", err)
	}

	chartCacheDir := filepath.Join(helmSettings.RepositoryCache, "charts")
	if mkErr := os.MkdirAll(chartCacheDir, cacheDirPerm); mkErr != nil {
		return "", fmt.Errorf("create chart cache dir: %w", mkErr)
	}

	tmpFile := filepath.Join(chartCacheDir, chartRef.Name+"-"+chartRef.Version+".tgz")
	if _, statErr := os.Stat(tmpFile); statErr == nil {
		return tmpFile, nil
	}

	data, err := g.Get(chartURL)
	if err != nil {
		return "", fmt.Errorf("download chart: %w", err)
	}
	if writeErr := os.WriteFile(tmpFile, data.Bytes(), filePerm); writeErr != nil {
		return "", fmt.Errorf("write chart file: %w", writeErr)
	}

	return tmpFile, nil
}

func (r *HelmSDKRenderer) downloadOCIChart(ctx context.Context, chartRef paprika.ChartRef) (string, error) {
	chartURL := chartRef.Repo
	if !strings.HasSuffix(chartURL, "/") {
		chartURL += "/"
	}
	chartURL += chartRef.Name
	tag := chartRef.Version

	result, err := (&source.OCISource{
		URL:     chartURL,
		Tag:     tag,
		WorkDir: r.WorkDir,
	}).Resolve(ctx)
	if err != nil {
		return "", fmt.Errorf("download OCI chart %s: %w", chartURL, err)
	}
	return result.LocalPath, nil
}

func (r *HelmSDKRenderer) ensureRepo(_ context.Context, repoURL string) error {
	repoFile := helmSettings.RepositoryConfig
	if err := os.MkdirAll(filepath.Dir(repoFile), cacheDirPerm); err != nil {
		return fmt.Errorf("create repo config dir: %w", err)
	}

	f, err := repo.LoadFile(repoFile)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("load repo file: %w", err)
	}
	if f == nil {
		f = &repo.File{}
	}

	for _, re := range f.Repositories {
		if re.URL == repoURL {
			return nil
		}
	}

	repoName := sanitizeRepoName(repoURL)
	entry := &repo.Entry{
		Name: repoName,
		URL:  repoURL,
	}

	chartRepo, err := repo.NewChartRepository(entry, helmg.All(helmSettings))
	if err != nil {
		return fmt.Errorf("create chart repo: %w", err)
	}

	if _, err := chartRepo.DownloadIndexFile(); err != nil {
		return fmt.Errorf("download repo index: %w", err)
	}

	f.Update(entry)
	if err := f.WriteFile(repoFile, filePerm); err != nil {
		return fmt.Errorf("write repo file: %w", err)
	}

	return nil
}

func (r *HelmSDKRenderer) ensureChartDeps(c *chart.Chart) error {
	if c.Metadata == nil || c.Metadata.Dependencies == nil {
		return nil
	}
	if len(c.Dependencies()) >= len(c.Metadata.Dependencies) {
		return nil
	}
	return errors.New("chart has unresolved dependencies; run helm dependency build")
}

func (r *HelmSDKRenderer) buildValues(params map[string]string, baseContent string) (map[string]interface{}, error) {
	merged := make(map[string]interface{})

	if baseContent != "" {
		var base map[string]interface{}
		if err := yaml.Unmarshal([]byte(baseContent), &base); err != nil {
			return nil, fmt.Errorf("parse base values: %w", err)
		}
		for k, v := range base {
			merged[k] = v
		}
	}

	for k, v := range params {
		merged[k] = v
	}

	return merged, nil
}

// RenderAll renders all templates and joins the resulting manifests.
func (r *HelmSDKRenderer) RenderAll(ctx context.Context, templates []paprika.Template, params map[string]string) ([]byte, error) {
	var allManifests [][]byte

	for i := range templates {
		rendered, err := r.Render(ctx, &templates[i], params)
		if err != nil {
			return nil, fmt.Errorf("template %d (%s) render failed: %w", i, templates[i].Name, err)
		}
		allManifests = append(allManifests, rendered)
	}

	return bytes.Join(allManifests, []byte("\n---\n")), nil
}

// RenderHelmChart renders a Helm chart from a repository and returns the resulting YAML.
func (r *HelmSDKRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{
			Type: sourceTypeHelm,
			Chart: paprika.ChartRef{
				Repo:    chartRepo,
				Name:    chartName,
				Version: chartVersion,
			},
		},
	}
	return r.Render(ctx, tmpl, values)
}

// SplitYAMLDocuments splits a multi-document YAML into individual documents.
func SplitYAMLDocuments(manifests []byte) [][]byte {
	var documents [][]byte
	for _, doc := range strings.Split(string(manifests), "\n---\n") {
		doc = strings.TrimSpace(doc)
		if doc == "" {
			continue
		}
		documents = append(documents, []byte(doc))
	}
	return documents
}

func sanitizeRepoName(repoURL string) string {
	replacer := strings.NewReplacer(
		"https://", "",
		"http://", "",
		"/", "-",
		".", "-",
		":", "-",
	)
	name := replacer.Replace(repoURL)
	return strings.TrimSuffix(name, "-")
}

// Ensure HelmSDKRenderer implements TemplateRenderer at compile time.
var _ TemplateRenderer = (*HelmSDKRenderer)(nil)
