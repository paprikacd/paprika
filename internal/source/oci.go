// Package source provides source resolution for git, S3, OCI, and other sources.
package source

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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

	if dockerOpts, err := o.dockerConfigOptions(&secret, opts); err != nil || dockerOpts != nil {
		return dockerOpts, err
	}

	username := string(secret.Data["username"])
	password := string(secret.Data["password"])
	if username != "" || password != "" {
		opts = append(opts, registry.ClientOptBasicAuth(username, password))
		return opts, nil
	}

	return opts, nil
}

func (o *OCISource) dockerConfigOptions(secret *corev1.Secret, opts []registry.ClientOption) ([]registry.ClientOption, error) {
	dockerCfg := secret.Data[".dockerconfigjson"]
	if len(dockerCfg) == 0 {
		return nil, nil
	}

	if creds, err := parseDockerConfigCredentials(dockerCfg, o.URL); err == nil {
		opts = append(opts, registry.ClientOptBasicAuth(creds.username, creds.password))
		return opts, nil
	}

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
//
// The directory is named by the archive digest and is never written after it
// appears. Concurrent resolves of one chart can run in the same process, so each
// one writes its own temporary archive and staging directory, then renames the
// staging directory into place. A resolve that loses the rename uses the
// winner's identical directory. A shared path would let one resolve delete
// the archive that another still reads, or interleave two extractions.
func writeChart(chartSummary *registry.DescriptorPullSummaryWithMeta, destDir string) (string, error) {
	if chartSummary == nil || len(chartSummary.Data) == 0 {
		return "", errors.New("pulled chart has no data")
	}
	chartName := chartSummary.Meta.Name
	if chartName == "" {
		chartName = "chart"
	}
	digest := sha256.Sum256(chartSummary.Data)
	chartDir := filepath.Join(destDir, chartName+"-"+hex.EncodeToString(digest[:8]))
	if isDir(chartDir) {
		return chartDir, nil
	}
	return stageChartDir(chartSummary.Data, destDir, chartName, chartDir)
}

// stageChartDir extracts data into a private staging directory and renames it
// to chartDir. If another resolve renamed its copy first, it returns that one.
func stageChartDir(data []byte, destDir, chartName, chartDir string) (string, error) {
	stage, err := os.MkdirTemp(destDir, "."+chartName+"-extract-*")
	if err != nil {
		return "", fmt.Errorf("create chart staging dir: %w", err)
	}
	defer os.RemoveAll(stage) //nolint:errcheck // gone after the rename; cleanup after a failure
	if err := extractChartData(data, destDir, chartName, stage); err != nil {
		return "", err
	}
	if err := os.Rename(stage, chartDir); err != nil {
		if isDir(chartDir) {
			return chartDir, nil
		}
		return "", fmt.Errorf("publish chart dir: %w", err)
	}
	return chartDir, nil
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// extractChartData writes data to a private temporary archive, extracts it
// into dir and removes the archive.
func extractChartData(data []byte, tmpDir, chartName, dir string) error {
	archive, err := os.CreateTemp(tmpDir, "."+chartName+"-*.tgz")
	if err != nil {
		return fmt.Errorf("create chart tarball: %w", err)
	}
	archivePath := archive.Name()
	defer os.Remove(archivePath) //nolint:errcheck // private temporary archive; cleanup only
	if _, err := archive.Write(data); err != nil {
		_ = archive.Close() //nolint:errcheck // cleanup after a failed write
		return fmt.Errorf("write chart tarball: %w", err)
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("close chart tarball: %w", err)
	}
	if err := extractChartFiles(archivePath, dir); err != nil {
		return fmt.Errorf("extract chart: %w", err)
	}
	return nil
}

// dockerCredentials holds parsed registry credentials.
type dockerCredentials struct {
	username string
	password string
}

// dockerConfigFile represents the structure of a .dockerconfigjson file.
type dockerConfigFile struct {
	Auths map[string]struct {
		Auth string `json:"auth"`
	} `json:"auths"`
}

// parseDockerConfigCredentials extracts credentials for the given registry URL
// from a .dockerconfigjson blob, avoiding a write to disk.
func parseDockerConfigCredentials(data []byte, registryURL string) (*dockerCredentials, error) {
	var cfg dockerConfigFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse docker config: %w", err)
	}
	// Try the exact URL first, then common variants
	for _, host := range []string{registryURL, stripScheme(registryURL)} {
		if entry, ok := cfg.Auths[host]; ok && entry.Auth != "" {
			decoded, err := base64.StdEncoding.DecodeString(entry.Auth)
			if err != nil {
				return nil, fmt.Errorf("decode auth for %s: %w", host, err)
			}
			parts := strings.SplitN(string(decoded), ":", 2)
			if len(parts) == 2 {
				return &dockerCredentials{username: parts[0], password: parts[1]}, nil
			}
		}
	}
	return nil, errors.New("no matching registry credentials found")
}

// stripScheme removes the protocol scheme from a URL for docker config lookup.
func stripScheme(url string) string {
	if idx := strings.Index(url, "://"); idx >= 0 {
		return url[idx+3:]
	}
	return url
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
