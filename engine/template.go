package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/source"
)

// TemplateRendererImpl renders Helm charts and resolves sources for templates.
type TemplateRendererImpl struct {
	WorkDir string
}

// NewTemplateRenderer creates a new TemplateRendererImpl with the given working directory.
func NewTemplateRenderer(workDir string) *TemplateRendererImpl {
	return &TemplateRendererImpl{WorkDir: workDir}
}

func ensureHelmDirs() error {
	dirs := []string{
		"/tmp/helm/cache",
		"/tmp/helm/config",
		"/tmp/helm/data",
	}
	for _, d := range dirs {
		// #nosec G301 -- helm requires world-readable cache directories
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("failed to create helm dir %s: %w", d, err)
		}
	}
	return nil
}

// ResolveSource resolves a template source (git, S3, etc.) and returns the local path.
func (r *TemplateRendererImpl) ResolveSource(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	switch tmpl.Spec.Type {
	case "git":
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
	case "s3":
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
	default:
		return nil, nil
	}
}

// Render renders a single Helm template and returns the resulting YAML manifests.
func (r *TemplateRendererImpl) Render(ctx context.Context, tmpl *paprika.Template, params map[string]string) ([]byte, error) {
	if err := ensureHelmDirs(); err != nil {
		return nil, err
	}

	chart, localPath, err := r.resolveChartPath(ctx, tmpl)
	if err != nil {
		return nil, err
	}

	releaseName := params["release-name"]
	if releaseName == "" {
		releaseName = "paprika-release"
	}

	var args []string

	if localPath != "" {
		args = []string{"template", releaseName, localPath}
	} else {
		args, err = r.resolveChartFromRepo(ctx, chart)
		if err != nil {
			return nil, err
		}
		args = append([]string{args[0], releaseName}, args[1:]...)
	}

	if tmpl.Spec.Namespace != "" {
		args = append(args, "--namespace", tmpl.Spec.Namespace)
	}

	valuesFile, err := r.writeValuesFile(params, tmpl.Spec.ValuesFile)
	if err != nil {
		return nil, fmt.Errorf("failed to write values file: %w", err)
	}
	if valuesFile != "" {
		args = append(args, "--values", valuesFile)
	}

	// #nosec G204 -- helm template with user-provided args from chart spec
	templateCmd := exec.CommandContext(ctx, "helm", args...)
	var stdout, stderr bytes.Buffer
	templateCmd.Stdout = &stdout
	templateCmd.Stderr = &stderr

	if err := templateCmd.Run(); err != nil {
		return nil, fmt.Errorf("helm template failed: %w\nStderr: %s", err, stderr.String())
	}

	return stdout.Bytes(), nil
}

func (r *TemplateRendererImpl) resolveChartPath(ctx context.Context, tmpl *paprika.Template) (paprika.ChartRef, string, error) {
	if tmpl.Spec.Type == "helm" {
		chart := tmpl.Spec.Chart
		if chart.Path != "" {
			return chart, chart.Path, nil
		}
		return chart, "", nil
	}

	result, err := r.ResolveSource(ctx, tmpl)
	if err != nil {
		return paprika.ChartRef{}, "", fmt.Errorf("resolve source: %w", err)
	}

	return paprika.ChartRef{Path: result.LocalPath}, result.LocalPath, nil
}

func (r *TemplateRendererImpl) writeValuesFile(params map[string]string, baseContent string) (string, error) {
	if len(params) == 0 && baseContent == "" {
		return "", nil
	}

	f, err := os.CreateTemp("", "paprika-values-*.yaml")
	if err != nil {
		return "", fmt.Errorf("create temp values file: %w", err)
	}
	defer func() { _ = f.Close() }()

	if baseContent != "" {
		if _, err := f.WriteString(baseContent); err != nil {
			return "", fmt.Errorf("write values base content: %w", err)
		}
		if len(params) > 0 && !strings.HasSuffix(baseContent, "\n") {
			_, _ = f.WriteString("\n")
		}
	}

	for k, v := range params {
		if _, err := fmt.Fprintf(f, "%s: %q\n", k, v); err != nil {
			return "", fmt.Errorf("write values param: %w", err)
		}
	}

	return f.Name(), nil
}

func (r *TemplateRendererImpl) resolveChartFromRepo(ctx context.Context, chart paprika.ChartRef) ([]string, error) {
	repoName := sanitizeRepoName(chart.Repo)
	// #nosec G204 -- helm repo commands with trusted chart repo URLs
	addCmd := exec.CommandContext(ctx, "helm", "repo", "add", repoName, chart.Repo, "--no-update")
	if out, addErr := addCmd.CombinedOutput(); addErr != nil {
		return nil, fmt.Errorf("helm repo add failed: %w\nOutput: %s", addErr, string(out))
	}
	// #nosec G204 -- helm repo update is a static command
	updateCmd := exec.CommandContext(ctx, "helm", "repo", "update")
	if out, updateErr := updateCmd.CombinedOutput(); updateErr != nil {
		return nil, fmt.Errorf("helm repo update failed: %w\nOutput: %s", updateErr, string(out))
	}
	chartRef := fmt.Sprintf("%s/%s", repoName, chart.Name)
	args := []string{"template", chartRef}
	if chart.Version != "" {
		args = append(args, "--version", chart.Version)
	}
	return args, nil
}

// RenderAll renders all templates and joins the resulting manifests.
func (r *TemplateRendererImpl) RenderAll(ctx context.Context, templates []paprika.Template, params map[string]string) ([]byte, error) {
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
func (r *TemplateRendererImpl) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	tmpl := &paprika.Template{
		Spec: paprika.TemplateSpec{
			Type: "helm",
			Chart: paprika.ChartRef{
				Repo:    chartRepo,
				Name:    chartName,
				Version: chartVersion,
			},
		},
	}
	return r.Render(ctx, tmpl, values)
}
