package engine

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

type TemplateRenderer struct {
	WorkDir string
}

func NewTemplateRenderer(workDir string) *TemplateRenderer {
	return &TemplateRenderer{WorkDir: workDir}
}

func (r *TemplateRenderer) Render(ctx context.Context, tmpl *paprika.Template, params map[string]string) ([]byte, error) {
	if tmpl.Spec.Type != "helm" {
		return nil, fmt.Errorf("unsupported template type %q (Phase 1: helm only)", tmpl.Spec.Type)
	}

	chart := tmpl.Spec.Chart
	repoName := sanitizeRepoName(chart.Repo)

	addCmd := exec.CommandContext(ctx, "helm", "repo", "add", repoName, chart.Repo, "--no-update")
	if out, err := addCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("helm repo add failed: %w\nOutput: %s", err, string(out))
	}

	updateCmd := exec.CommandContext(ctx, "helm", "repo", "update")
	if out, err := updateCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("helm repo update failed: %w\nOutput: %s", err, string(out))
	}

	chartRef := fmt.Sprintf("%s/%s", repoName, chart.Name)
	args := []string{"template", chartRef}

	if chart.Version != "" {
		args = append(args, "--version", chart.Version)
	}

	var valueArgs []string
	for k, v := range params {
		valueArgs = append(valueArgs, fmt.Sprintf("%s=%s", k, v))
	}
	if len(valueArgs) > 0 {
		args = append(args, "--set", strings.Join(valueArgs, ","))
	}

	templateCmd := exec.CommandContext(ctx, "helm", args...)
	var stdout, stderr bytes.Buffer
	templateCmd.Stdout = &stdout
	templateCmd.Stderr = &stderr

	if err := templateCmd.Run(); err != nil {
		return nil, fmt.Errorf("helm template failed: %w\nStderr: %s", err, stderr.String())
	}

	return stdout.Bytes(), nil
}

func (r *TemplateRenderer) RenderAll(ctx context.Context, templates []paprika.Template, params map[string]string) ([]byte, error) {
	var allManifests [][]byte

	for i, tmpl := range templates {
		rendered, err := r.Render(ctx, &tmpl, params)
		if err != nil {
			return nil, fmt.Errorf("template %d (%s) render failed: %w", i, tmpl.Name, err)
		}
		allManifests = append(allManifests, rendered)
	}

	return bytes.Join(allManifests, []byte("\n---\n")), nil
}

func (r *TemplateRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
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
