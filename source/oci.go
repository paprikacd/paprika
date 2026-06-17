// Package source provides source resolution for git, S3, OCI, and other sources.
package source

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/registry"
)

// OCISource represents an OCI registry source (Helm chart or artifact).
type OCISource struct {
	URL       string
	Tag       string
	Insecure  bool
	WorkDir   string
	SecretRef string
	Namespace string
	Client    client.Client
}

// clientOptions returns registry client options including authentication.
func (o *OCISource) clientOptions(ctx context.Context) ([]registry.ClientOption, error) {
	opts := []registry.ClientOption{registry.ClientOptEnableCache(true)}
	if o.Insecure {
		opts = append(opts, registry.ClientOptPlainHTTP())
	}
	if o.SecretRef == "" || o.Client == nil {
		return opts, nil
	}

	var secret corev1.Secret
	if err := o.Client.Get(ctx, client.ObjectKey{Name: o.SecretRef, Namespace: o.Namespace}, &secret); err != nil {
		return nil, fmt.Errorf("get OCI secret %s/%s: %w", o.Namespace, o.SecretRef, err)
	}

	if dockerCfg := secret.Data[".dockerconfigjson"]; len(dockerCfg) > 0 {
		cfgDir := filepath.Join(o.WorkDir, "oci-docker-config", SanitizeName(o.URL))
		if err := os.MkdirAll(cfgDir, 0o750); err != nil {
			return nil, fmt.Errorf("create docker config dir: %w", err)
		}
		cfgPath := filepath.Join(cfgDir, "config.json")
		if err := os.WriteFile(cfgPath, dockerCfg, 0o600); err != nil {
			return nil, fmt.Errorf("write docker config: %w", err)
		}
		opts = append(opts, registry.ClientOptCredentialsFile(cfgPath))
		return opts, nil
	}

	username := string(secret.Data["username"])
	password := string(secret.Data["password"])
	if username != "" || password != "" {
		opts = append(opts, registry.ClientOptBasicAuth(username, password))
		return opts, nil
	}

	return opts, nil
}

// IsOCIURL reports whether the given URL is an OCI registry reference.
func IsOCIURL(url string) bool {
	return strings.HasPrefix(url, "oci://")
}

// Resolve pulls the OCI artifact and returns the local chart path.
func (o *OCISource) Resolve(ctx context.Context) (*ResolveResult, error) {
	if !IsOCIURL(o.URL) {
		return nil, fmt.Errorf("not an OCI URL: %s", o.URL)
	}

	clientOpts, err := o.clientOptions(ctx)
	if err != nil {
		return nil, err
	}

	ref := buildOCIRef(o.URL, o.Tag)

	result, err := pullOCIChart(ctx, ref, clientOpts)
	if err != nil {
		return nil, err
	}

	destDir := filepath.Join(o.WorkDir, "oci-cache", SanitizeName(o.URL))
	if mkErr := os.MkdirAll(destDir, 0o750); mkErr != nil {
		return nil, fmt.Errorf("create OCI cache dir: %w", mkErr)
	}

	chartPath, err := writeChart(result.Chart, destDir)
	if err != nil {
		return nil, err
	}

	dirHash, err := ComputeDirHash(chartPath)
	if err != nil {
		return nil, fmt.Errorf("compute chart hash: %w", err)
	}

	revision := result.Ref
	if revision == "" {
		revision = o.Tag
	}

	return &ResolveResult{
		LocalPath: chartPath,
		Hash:      dirHash,
		Revision:  revision,
	}, nil
}

// pullOCIChart creates a registry client and pulls the chart.
func pullOCIChart(ctx context.Context, ref string, clientOpts []registry.ClientOption) (*registry.PullResult, error) {
	client, err := registry.NewClient(clientOpts...)
	if err != nil {
		return nil, fmt.Errorf("create registry client: %w", err)
	}

	result, err := client.Pull(ref)
	if err != nil {
		return nil, fmt.Errorf("pull OCI artifact %s: %w", ref, err)
	}
	if result == nil || result.Chart == nil {
		return nil, errors.New("registry pull returned no chart")
	}
	return result, nil
}

// buildOCIRef returns the full OCI reference including an optional tag.
func buildOCIRef(url, tag string) string {
	if tag != "" {
		return url + ":" + tag
	}
	return url
}

// writeChart extracts a pulled chart's tarball data to a directory and returns the chart path.
func writeChart(chartSummary *registry.DescriptorPullSummaryWithMeta, destDir string) (string, error) {
	if chartSummary == nil || len(chartSummary.Data) == 0 {
		return "", errors.New("pulled chart has no data")
	}
	chartName := chartSummary.Meta.Name
	if chartName == "" {
		chartName = "chart"
	}
	chartDir := filepath.Join(destDir, chartName)
	if mkErr := os.MkdirAll(chartDir, 0o750); mkErr != nil {
		return "", fmt.Errorf("create chart dir: %w", mkErr)
	}
	tmpFile := filepath.Join(destDir, chartName+".tgz")
	if writeErr := os.WriteFile(tmpFile, chartSummary.Data, 0o600); writeErr != nil {
		return "", fmt.Errorf("write chart tarball: %w", writeErr)
	}
	if err := extractChartFiles(tmpFile, chartDir); err != nil {
		return "", fmt.Errorf("extract chart: %w", err)
	}
	_ = os.Remove(tmpFile)
	return chartDir, nil
}

// extractChartFiles extracts a chart tarball into the given directory.
func extractChartFiles(archivePath, destDir string) error {
	c, err := loader.Load(archivePath)
	if err != nil {
		return fmt.Errorf("load chart archive: %w", err)
	}
	for _, f := range c.Raw {
		dest := filepath.Join(destDir, f.Name)
		if mkErr := os.MkdirAll(filepath.Dir(dest), 0o750); mkErr != nil {
			return fmt.Errorf("create file dir: %w", mkErr)
		}
		if writeErr := os.WriteFile(dest, f.Data, 0o600); writeErr != nil {
			return fmt.Errorf("write chart file: %w", writeErr)
		}
	}
	return nil
}
