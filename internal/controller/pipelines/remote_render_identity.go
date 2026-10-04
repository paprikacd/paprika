package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const legacyRemoteRenderAnnotation = "paprika.io/legacy-remote-render-config-hash"
const remoteRenderHashPrefix = "render-config-v1-"

// Resolved source content already identifies Git/S3/OCI inputs. Keep the
// remaining render inputs separate so unrelated Git revisions and fetch/auth
// settings do not restart a release, while values and namespace changes do.
func remoteRenderConfigHash(spec *paprikav1.TemplateSpec) (string, error) {
	config := spec.DeepCopy()
	config.Git, config.S3, config.OCI, config.RepoRef = nil, nil, nil, ""
	return helmConfigHash(config)
}

// Capture legacy render inputs before converging the generated Template.
// Unchanged applications retain their release identity on controller upgrade.
func (r *ApplicationReconciler) preserveLegacyRemoteRenderConfig(ctx context.Context, app *paprikav1.Application, expected *paprikav1.Template) error {
	if !isRemoteSourceType(app.Spec.Source.Type) || app.Status.SourceHash == "" || strings.HasPrefix(sourceContentHash(app.Status.SourceHash), remoteRenderHashPrefix) {
		return nil
	}
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		return r.initializeLegacyRemoteRenderConfig(ctx, expected)
	}); err != nil {
		return fmt.Errorf("preserve legacy remote render configuration: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) initializeLegacyRemoteRenderConfig(ctx context.Context, expected *paprikav1.Template) error {
	var current paprikav1.Template
	err := r.helmMetadataReader().Get(ctx, client.ObjectKeyFromObject(expected), &current)
	if apierrors.IsNotFound(err) {
		hash, hashErr := remoteRenderConfigHash(&expected.Spec)
		if hashErr != nil {
			return hashErr
		}
		if expected.Annotations == nil {
			expected.Annotations = make(map[string]string)
		}
		expected.Annotations[legacyRemoteRenderAnnotation] = hash
		return nil
	}
	if err != nil {
		return fmt.Errorf("read legacy remote render configuration: %w", err)
	}
	if current.Annotations[legacyRemoteRenderAnnotation] != "" {
		return nil
	}
	hash, err := remoteRenderConfigHash(&current.Spec)
	if err != nil {
		return err
	}
	before := current.DeepCopy()
	if current.Annotations == nil {
		current.Annotations = make(map[string]string)
	}
	current.Annotations[legacyRemoteRenderAnnotation] = hash
	if err := r.client.Patch(ctx, &current, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{})); err != nil {
		return fmt.Errorf("patch legacy remote render configuration: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) remoteRenderSourceHash(ctx context.Context, app *paprikav1.Application, tmpl *paprikav1.Template, resolvedHash string) (string, error) {
	if resolvedHash == "" || app.Status.SourceHash == "" {
		return resolvedHash, nil
	}
	configHash, err := remoteRenderConfigHash(&tmpl.Spec)
	if err != nil {
		return "", err
	}
	if app.Status.SourceHash != "" && !strings.HasPrefix(sourceContentHash(app.Status.SourceHash), remoteRenderHashPrefix) {
		var stored paprikav1.Template
		if err := r.helmMetadataReader().Get(ctx, client.ObjectKeyFromObject(tmpl), &stored); err != nil {
			return "", fmt.Errorf("read remote render configuration baseline: %w", err)
		}
		baseline := stored.Annotations[legacyRemoteRenderAnnotation]
		if baseline == "" || baseline == configHash {
			return resolvedHash, nil
		}
	}
	combined := sha256.Sum256([]byte(sourceContentHash(resolvedHash) + "\n" + configHash))
	content := remoteRenderHashPrefix + hex.EncodeToString(combined[:])
	if i := strings.LastIndex(resolvedHash, ":"); i >= 0 {
		return resolvedHash[:i+1] + content, nil
	}
	return content, nil
}
