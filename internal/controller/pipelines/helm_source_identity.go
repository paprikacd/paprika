package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const legacyHelmConfigAnnotation = "paprika.io/legacy-helm-config-hash"
const helmConfigHashPrefix = "helm-config-v1:"

// helmConfigHash includes everything Helm renders from the generated Template:
// chart version/reference, inline values, repository and effective namespace.
func helmConfigHash(spec paprikav1.TemplateSpec) string {
	// TemplateSpec contains only JSON-serializable fields.
	encoded, _ := json.Marshal(spec)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// Preserve the old Template configuration BEFORE converging its spec. Existing
// applications retain their release identity on controller upgrade; their next
// real configuration change adopts the complete hash. Persisting the baseline
// on the Template makes retries and controller restarts safe.
func (r *ApplicationReconciler) preserveLegacyHelmConfig(ctx context.Context, app *paprikav1.Application, expected *paprikav1.Template) error {
	if isRemoteSourceType(app.Spec.Source.Type) || app.Status.SourceHash == "" || strings.HasPrefix(app.Status.SourceHash, helmConfigHashPrefix) {
		return nil
	}
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var current paprikav1.Template
		if err := r.client.Get(ctx, client.ObjectKeyFromObject(expected), &current); err != nil {
			if !apierrors.IsNotFound(err) {
				return fmt.Errorf("read legacy Helm configuration: %w", err)
			}
			// A missing legacy Template has no recoverable previous configuration.
			// Recreating it must not force a release for an unchanged Application.
			expected.Annotations = map[string]string{legacyHelmConfigAnnotation: helmConfigHash(expected.Spec)}
			return nil
		}
		if current.Annotations[legacyHelmConfigAnnotation] != "" {
			return nil
		}
		before := current.DeepCopy()
		if current.Annotations == nil {
			current.Annotations = map[string]string{}
		}
		current.Annotations[legacyHelmConfigAnnotation] = helmConfigHash(current.Spec)
		return r.client.Patch(ctx, &current, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{}))
	})
}

func (r *ApplicationReconciler) resolveHelmConfigHash(ctx context.Context, app *paprikav1.Application) (string, string, error) {
	configHash := helmConfigHash(r.buildTemplateSpec(ctx, app))
	if app.Status.SourceHash != "" && !strings.HasPrefix(app.Status.SourceHash, helmConfigHashPrefix) {
		var tmpl paprikav1.Template
		key := client.ObjectKey{Namespace: app.Namespace, Name: app.Name + "-template"}
		if err := r.client.Get(ctx, key, &tmpl); err != nil && !apierrors.IsNotFound(err) {
			return "", "", fmt.Errorf("read Helm configuration baseline: %w", err)
		}
		if tmpl.Annotations[legacyHelmConfigAnnotation] == configHash {
			sum := sha256.Sum256([]byte(app.Spec.Source.Chart.Path + app.Spec.Source.Chart.Repo + app.Spec.Source.Chart.Name))
			return hex.EncodeToString(sum[:]), "", nil
		}
	}
	return helmConfigHashPrefix + configHash, "", nil
}
