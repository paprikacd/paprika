package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"sigs.k8s.io/kustomize/api/krusty"
	"sigs.k8s.io/kustomize/kyaml/filesys"
	"sigs.k8s.io/yaml"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// renderKustomize renders a Kustomize template. If previousOutput is non-empty and
// the template requests InputFromPrevious, a temporary kustomization directory is
// created that uses the previous output as its resource set.
func (r *HelmSDKRenderer) renderKustomize(ctx context.Context, tmpl *paprika.Template, previousOutput []byte) ([]byte, error) {
	if tmpl.Spec.Kustomize == nil {
		return nil, fmt.Errorf("kustomize spec is required for type=%s", sourceTypeKustomize)
	}

	kust := tmpl.Spec.Kustomize

	if kust.InputFromPrevious {
		if len(previousOutput) == 0 {
			return nil, errors.New("kustomize inputFromPrevious requested but no previous render output available")
		}
		return r.renderWithOverlay(kust, "", previousOutput)
	}

	path, err := r.resolveKustomizePath(ctx, tmpl)
	if err != nil {
		return nil, fmt.Errorf("resolve kustomize path: %w", err)
	}

	if !kustomizeHasTransformations(kust) {
		return r.runKustomizeBuild(path)
	}

	return r.renderWithOverlay(kust, path, nil)
}

func kustomizeHasTransformations(kust *paprika.KustomizeSourceSpec) bool {
	return kust.NamePrefix != "" ||
		kust.NameSuffix != "" ||
		kust.Namespace != "" ||
		len(kust.Images) > 0 ||
		len(kust.CommonLabels) > 0 ||
		len(kust.CommonAnnotations) > 0
}

func (r *HelmSDKRenderer) resolveKustomizePath(ctx context.Context, tmpl *paprika.Template) (string, error) {
	kust := tmpl.Spec.Kustomize
	if kust.Path != "" {
		return kust.Path, nil
	}

	switch tmpl.Spec.Type {
	case sourceTypeGit:
		result, resolveErr := r.resolveGitSource(ctx, tmpl)
		if resolveErr != nil {
			return "", resolveErr
		}
		return result.LocalPath, nil
	case sourceTypeS3:
		result, resolveErr := r.resolveS3Source(ctx, tmpl)
		if resolveErr != nil {
			return "", resolveErr
		}
		return result.LocalPath, nil
	case sourceTypeOCI:
		result, resolveErr := r.resolveOCISource(ctx, tmpl)
		if resolveErr != nil {
			return "", resolveErr
		}
		return result.LocalPath, nil
	default:
		return "", errors.New("kustomize path or git/s3/oci source is required")
	}
}

func (r *HelmSDKRenderer) renderWithOverlay(kust *paprika.KustomizeSourceSpec, basePath string, baseContent []byte) ([]byte, error) {
	dir, createErr := os.MkdirTemp(r.WorkDir, "paprika-kustomize-*")
	if createErr != nil {
		return nil, fmt.Errorf("create temp dir: %w", createErr)
	}
	defer os.RemoveAll(dir) //nolint:errcheck // safe to ignore cleanup error

	relBase, prepareErr := r.prepareOverlayBase(dir, basePath, baseContent)
	if prepareErr != nil {
		return nil, prepareErr
	}

	kustomization := buildKustomization(kust, relBase)
	kustomizationFile := filepath.Join(dir, "kustomization.yaml")
	raw, marshalErr := yaml.Marshal(kustomization)
	if marshalErr != nil {
		return nil, fmt.Errorf("marshal kustomization: %w", marshalErr)
	}
	if writeErr := os.WriteFile(kustomizationFile, raw, filePerm); writeErr != nil {
		return nil, fmt.Errorf("write kustomization: %w", writeErr)
	}

	return r.runKustomizeBuild(dir)
}

func (r *HelmSDKRenderer) prepareOverlayBase(dir, basePath string, baseContent []byte) (string, error) {
	if baseContent != nil {
		resourcesFile := filepath.Join(dir, "resources.yaml")
		if writeErr := os.WriteFile(resourcesFile, baseContent, filePerm); writeErr != nil {
			return "", fmt.Errorf("write resources: %w", writeErr)
		}
		return "resources.yaml", nil
	}

	if basePath == "" {
		return "", errors.New("kustomize overlay requires a base path or previous output")
	}

	baseDst := filepath.Join(dir, "base")
	if copyErr := copyKustomizeBase(basePath, baseDst); copyErr != nil {
		return "", fmt.Errorf("copy kustomize base: %w", copyErr)
	}
	return "base", nil
}

func buildKustomization(kust *paprika.KustomizeSourceSpec, basePath string) map[string]any {
	kustomization := map[string]any{
		"apiVersion": "kustomize.config.k8s.io/v1beta1",
		"kind":       "Kustomization",
		"resources":  []string{basePath},
	}
	if kust.NamePrefix != "" {
		kustomization["namePrefix"] = kust.NamePrefix
	}
	if kust.NameSuffix != "" {
		kustomization["nameSuffix"] = kust.NameSuffix
	}
	if kust.Namespace != "" {
		kustomization["namespace"] = kust.Namespace
	}
	if len(kust.Images) > 0 {
		kustomization["images"] = normalizeKustomizeImages(kust.Images)
	}
	if len(kust.CommonLabels) > 0 {
		kustomization["commonLabels"] = kust.CommonLabels
	}
	if len(kust.CommonAnnotations) > 0 {
		kustomization["commonAnnotations"] = kust.CommonAnnotations
	}
	return kustomization
}

func normalizeKustomizeImages(images []paprika.KustomizeImage) []map[string]string {
	out := make([]map[string]string, 0, len(images))
	for _, img := range images {
		entry := map[string]string{"name": img.Name}
		if img.NewName != "" {
			entry["newName"] = img.NewName
		}
		if img.NewTag != "" {
			entry["newTag"] = img.NewTag
		}
		if img.Digest != "" {
			entry["digest"] = img.Digest
		}
		out = append(out, entry)
	}
	return out
}

func (r *HelmSDKRenderer) runKustomizeBuild(path string) ([]byte, error) {
	kustomizer := krusty.MakeKustomizer(krusty.MakeDefaultOptions())
	resMap, err := kustomizer.Run(filesys.MakeFsOnDisk(), path)
	if err != nil {
		return nil, fmt.Errorf("kustomize build %s: %w", path, err)
	}
	out, err := resMap.AsYaml()
	if err != nil {
		return nil, fmt.Errorf("marshal kustomize output: %w", err)
	}
	return out, nil
}

// copyKustomizeBase copies a file or directory into dst so that the overlay can
// reference it with a relative path.
func copyKustomizeBase(src, dst string) error {
	info, statErr := os.Stat(src)
	if statErr != nil {
		return fmt.Errorf("stat %s: %w", src, statErr)
	}
	if !info.IsDir() {
		return copyFile(src, dst)
	}

	if mkdirErr := os.MkdirAll(dst, info.Mode()); mkdirErr != nil {
		return fmt.Errorf("mkdir %s: %w", dst, mkdirErr)
	}
	entries, readErr := os.ReadDir(src)
	if readErr != nil {
		return fmt.Errorf("read dir %s: %w", src, readErr)
	}
	for _, entry := range entries {
		if copyErr := copyKustomizeBase(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); copyErr != nil {
			return copyErr
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	//nolint:gosec // src/dst come from Kustomize build output paths
	in, openErr := os.Open(src)
	if openErr != nil {
		return fmt.Errorf("open %s: %w", src, openErr)
	}
	defer in.Close() //nolint:errcheck // safe to ignore close error

	if mkdirErr := os.MkdirAll(filepath.Dir(dst), 0o750); mkdirErr != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(dst), mkdirErr)
	}
	//nolint:gosec // src/dst come from Kustomize build output paths
	out, createErr := os.Create(dst)
	if createErr != nil {
		return fmt.Errorf("create %s: %w", dst, createErr)
	}

	if _, copyErr := io.Copy(out, in); copyErr != nil {
		closeErr := out.Close()
		return errors.Join(fmt.Errorf("copy %s to %s: %w", src, dst, copyErr), fmt.Errorf("close %s: %w", dst, closeErr))
	}
	if closeErr := out.Close(); closeErr != nil {
		return fmt.Errorf("close %s: %w", dst, closeErr)
	}
	return nil
}
