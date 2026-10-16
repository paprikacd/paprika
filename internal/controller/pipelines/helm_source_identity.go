package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const legacyHelmConfigAnnotation = "paprika.io/legacy-helm-config-hash"
const helmConfigHashPrefix = "helm-config-v1:"

func (r *ApplicationReconciler) helmMetadataReader() client.Reader {
	if r.sourceMetadataReader != nil {
		return r.sourceMetadataReader
	}
	return r.client
}

// helmConfigHash includes everything Helm renders from the generated Template:
// chart version/reference, inline values, repository and effective namespace.
func helmConfigHash(spec *paprikav1.TemplateSpec) (string, error) {
	encoded, err := json.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("encode Helm render configuration: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// Preserve the old Template configuration BEFORE converging its spec. Existing
// applications retain their release identity on controller upgrade; their next
// real configuration change adopts the complete hash. Persisting the baseline
// on the Template makes retries and controller restarts safe.
func (r *ApplicationReconciler) preserveLegacyHelmConfig(ctx context.Context, app *paprikav1.Application, expected *paprikav1.Template) error {
	if isRemoteSourceType(app.Spec.Source.Type) || app.Status.SourceHash == "" || strings.HasPrefix(app.Status.SourceHash, helmConfigHashPrefix) {
		return nil
	}
	retryErr := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		return r.initializeLegacyHelmConfig(ctx, expected)
	})
	if retryErr != nil {
		return fmt.Errorf("preserve legacy Helm configuration: %w", retryErr)
	}
	return nil
}

func (r *ApplicationReconciler) initializeLegacyHelmConfig(ctx context.Context, expected *paprikav1.Template) error {
	var current paprikav1.Template
	if err := r.helmMetadataReader().Get(ctx, client.ObjectKeyFromObject(expected), &current); err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("read legacy Helm configuration: %w", err)
		}
		// A missing legacy Template has no recoverable previous configuration.
		// Recreating it must not force a release for an unchanged Application.
		configHash, hashErr := helmConfigHash(&expected.Spec)
		if hashErr != nil {
			return hashErr
		}
		expected.Annotations = map[string]string{legacyHelmConfigAnnotation: configHash}
		return nil
	}
	if current.Annotations[legacyHelmConfigAnnotation] != "" {
		return nil
	}
	before := current.DeepCopy()
	if current.Annotations == nil {
		current.Annotations = map[string]string{}
	}
	configHash, hashErr := helmConfigHash(&current.Spec)
	if hashErr != nil {
		return hashErr
	}
	current.Annotations[legacyHelmConfigAnnotation] = configHash
	if err := r.client.Patch(ctx, &current, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{})); err != nil {
		return fmt.Errorf("patch legacy Helm configuration baseline: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) resolveHelmConfigHash(ctx context.Context, app *paprikav1.Application) (hash, revision string, err error) {
	spec := r.buildTemplateSpec(ctx, app)
	configHash, hashErr := helmConfigHash(&spec)
	if hashErr != nil {
		return "", "", hashErr
	}
	if app.Status.SourceHash != "" && !strings.HasPrefix(app.Status.SourceHash, helmConfigHashPrefix) {
		var tmpl paprikav1.Template
		key := client.ObjectKey{Namespace: app.Namespace, Name: app.Name + "-template"}
		if err := r.helmMetadataReader().Get(ctx, key, &tmpl); err != nil && !apierrors.IsNotFound(err) {
			return "", "", fmt.Errorf("read Helm configuration baseline: %w", err)
		}
		if tmpl.Annotations[legacyHelmConfigAnnotation] == configHash {
			sum := sha256.Sum256([]byte(app.Spec.Source.Chart.Path + app.Spec.Source.Chart.Repo + app.Spec.Source.Chart.Name))
			return hex.EncodeToString(sum[:]), "", nil
		}
	}
	return helmConfigHashPrefix + configHash, "", nil
}
