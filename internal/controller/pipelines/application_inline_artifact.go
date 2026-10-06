package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"regexp"
	"strings"

	"github.com/distribution/reference"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

var artifactRevisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

func inlineArtifact(app *paprikav1.Application) *paprikav1.InlineArtifact {
	if app.Spec.Source.Type != paprikav1.SourceTypeInline || app.Spec.Source.Inline == nil {
		return nil
	}
	return app.Spec.Source.Inline.Artifact
}

func canonicalArtifactRepository(repository string) (string, error) {
	parsed, err := url.Parse(repository)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("artifact repository must be an HTTP(S) repository URL without credentials or query")
	}
	return strings.TrimSuffix(strings.TrimRight(repository, "/"), ".git"), nil
}

func artifactImageRepositories(artifact *paprikav1.InlineArtifact) (map[string]string, error) {
	if artifact == nil || !artifactRevisionPattern.MatchString(artifact.Revision) || len(artifact.Images) == 0 {
		return nil, errors.New("inline artifact requires an exact source commit and immutable application images")
	}
	if _, err := canonicalArtifactRepository(artifact.Repository); err != nil {
		return nil, err
	}
	repositories := make(map[string]string, len(artifact.Images))
	for component, image := range artifact.Images {
		if component == "" {
			return nil, errors.New("artifact image container name must not be empty")
		}
		name, err := artifactImageRepository(component, image)
		if err != nil {
			return nil, err
		}
		if previous, exists := repositories[name]; exists && previous != string(image) {
			return nil, errors.New("artifact declares conflicting versions of the same image repository")
		}
		repositories[name] = string(image)
	}
	return repositories, nil
}

func artifactImageRepository(component string, image paprikav1.ArtifactImageReference) (string, error) {
	ref, err := reference.ParseNormalizedNamed(string(image))
	if err != nil || ref.String() != string(image) {
		return "", fmt.Errorf("artifact image %q must be a fully qualified image reference", component)
	}
	digested, ok := ref.(reference.Digested)
	if !ok || digested.Digest().Algorithm().String() != "sha256" || digested.Digest().Validate() != nil {
		return "", fmt.Errorf("artifact image %q must have a full sha256 digest", component)
	}
	return reference.TrimNamed(ref).String(), nil
}

func readInlineArtifactSnapshot(ctx context.Context, c client.Reader, namespace, name, targetNamespace, expectedHash string, artifact *paprikav1.InlineArtifact) (payload []byte, sourceHash string, err error) {
	var snapshot corev1.ConfigMap
	if err := c.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &snapshot); err != nil {
		return nil, "", fmt.Errorf("get inline artifact snapshot: %w", err)
	}
	if snapshot.Immutable == nil || !*snapshot.Immutable {
		return nil, "", errors.New("inline artifact snapshot must be immutable")
	}
	payload = []byte(snapshot.Data["manifests.yaml"])
	if expectedHash == "" || expectedHash != inlineArtifactPayloadHash(payload) {
		return nil, "", errors.New("inline artifact snapshot differs from its declared manifestHash")
	}
	if err := validateInlineArtifactPayload(payload, artifact, targetNamespace); err != nil {
		return nil, "", err
	}
	return payload, inlineArtifactPayloadHash(payload), nil
}

func validateInlineArtifactPayload(payload []byte, artifact *paprikav1.InlineArtifact, targetNamespace string) error {
	return validateInlineArtifactDocuments(payload, artifact, targetNamespace, targetNamespace)
}

func validateInlineArtifactDocuments(payload []byte, artifact *paprikav1.InlineArtifact, targetNamespace, defaultNamespace string) error {
	repositories, err := artifactImageRepositories(artifact)
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(artifact.Images))
	identities := make(map[string]struct{})
	for _, document := range engine.SplitYAMLDocuments(payload) {
		if err := validateArtifactDocument(document, artifact.Images, repositories, seen, identities, targetNamespace, defaultNamespace); err != nil {
			return err
		}
	}
	for component := range artifact.Images {
		if !seen[component] {
			return fmt.Errorf("inline artifact payload has no application container %q", component)
		}
	}
	return nil
}

func validateArtifactDocument(document []byte, images map[string]paprikav1.ArtifactImageReference, repositories map[string]string, seen map[string]bool, identities map[string]struct{}, targetNamespace, defaultNamespace string) error {
	var object map[string]interface{}
	if err := yaml.Unmarshal(document, &object); err != nil {
		return fmt.Errorf("decode inline artifact manifest: %w", err)
	}
	if len(object) == 0 {
		return nil
	}
	resource := unstructured.Unstructured{Object: object}
	if namespace := resource.GetNamespace(); targetNamespace != "" && namespace != "" && namespace != targetNamespace && !isClusterScopedKind(resource.GetKind()) {
		return errors.New("inline artifact payload contains a different workload namespace")
	}
	identity, err := artifactResourceIdentity(&resource, defaultNamespace)
	if err != nil {
		return err
	}
	if _, duplicate := identities[identity]; duplicate {
		return errors.New("inline artifact payload contains duplicate resource identities")
	}
	identities[identity] = struct{}{}
	return validateArtifactWorkload(&resource, images, repositories, seen)
}

func artifactResourceIdentity(resource *unstructured.Unstructured, defaultNamespace string) (string, error) {
	if resource.GetAPIVersion() == "" || resource.GetKind() == "" || resource.GetName() == "" {
		return "", errors.New("inline artifact resources require apiVersion, kind and name")
	}
	namespace := resource.GetNamespace()
	if isClusterScopedKind(resource.GetKind()) {
		namespace = ""
	} else if namespace == "" {
		namespace = defaultNamespace
	}
	// Served versions address the same underlying Kubernetes object. Preserve
	// the API group so unrelated resources with the same Kind stay distinct.
	group := ""
	if parts := strings.SplitN(resource.GetAPIVersion(), "/", 2); len(parts) == 2 {
		group = parts[0]
	}
	return strings.Join([]string{group, resource.GetKind(), namespace, resource.GetName()}, "\x00"), nil
}

func artifactPodSpecPath(kind string) []string {
	switch kind {
	case "Pod":
		return []string{"spec"}
	case "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController", "Job", "Rollout":
		return []string{"spec", "template", "spec"}
	case "CronJob":
		return []string{"spec", "jobTemplate", "spec", "template", "spec"}
	default:
		return nil
	}
}

func validateArtifactWorkload(resource *unstructured.Unstructured, images map[string]paprikav1.ArtifactImageReference, repositories map[string]string, seen map[string]bool) error {
	path := artifactPodSpecPath(resource.GetKind())
	if path == nil {
		if resource.GetKind() == "List" {
			return errors.New("inline artifact payload must contain individual resource documents, not Lists")
		}
		return nil
	}
	for _, field := range []string{"containers", "initContainers"} {
		containers, _, err := unstructured.NestedSlice(resource.Object, append(path, field)...)
		if err != nil {
			return fmt.Errorf("read inline artifact containers: %w", err)
		}
		for _, container := range containers {
			object, ok := container.(map[string]interface{})
			if !ok {
				return errors.New("inline artifact contains an invalid container")
			}
			if err := validateArtifactContainer(object, images, repositories); err != nil {
				return err
			}
		}
	}
	return validateArtifactPrimaryComponent(resource, path, images, seen)
}

func validateArtifactPrimaryComponent(resource *unstructured.Unstructured, path []string, images map[string]paprikav1.ArtifactImageReference, seen map[string]bool) error {
	switch resource.GetKind() {
	case "Deployment", "StatefulSet", "DaemonSet", "Rollout", "Pod":
	default:
		return nil
	}
	component := resource.GetLabels()["app.kubernetes.io/component"]
	expected, declared := images[component]
	if !declared {
		return nil
	}
	containers, _, err := unstructured.NestedSlice(resource.Object, append(path, "containers")...)
	if err != nil {
		return fmt.Errorf("read inline artifact primary containers: %w", err)
	}
	for _, value := range containers {
		container, ok := value.(map[string]interface{})
		if !ok {
			continue
		}
		if artifactContainerMatches(container, component, expected) {
			seen[component] = true
			return nil
		}
	}
	return fmt.Errorf("inline artifact primary component %q does not deploy its declared image", component)
}

func artifactContainerMatches(container map[string]interface{}, component string, expected paprikav1.ArtifactImageReference) bool {
	name, hasName := container["name"].(string)
	image, hasImage := container["image"].(string)
	return hasName && hasImage && name == component && image == string(expected)
}

func validateArtifactContainer(container map[string]interface{}, images map[string]paprikav1.ArtifactImageReference, repositories map[string]string) error {
	name, hasName := container["name"].(string)
	image, hasImage := container["image"].(string)
	if !hasName || !hasImage {
		return errors.New("inline artifact container must declare a name and image")
	}
	if expected, declared := images[name]; declared {
		if image != string(expected) {
			return fmt.Errorf("inline artifact container %q does not use its declared immutable image", name)
		}
	}
	// Also bind migrations, jobs and differently named containers that reuse an
	// application image repository. Dependency repositories remain tenant-local.
	ref, err := reference.ParseNormalizedNamed(image)
	if err != nil {
		return fmt.Errorf("inline artifact container %q has an invalid image reference", name)
	}
	if expected, declared := repositories[reference.TrimNamed(ref).String()]; declared && image != expected {
		return fmt.Errorf("inline artifact container %q uses a different application image version", name)
	}
	return nil
}

func artifactReleaseMatches(app *paprikav1.Application, release *paprikav1.Release) bool {
	artifact := inlineArtifact(app)
	return artifact != nil && release.Spec.ManifestSource != nil &&
		release.Spec.ManifestSource.ConfigMapRef == app.Spec.Source.Inline.ConfigMapRef &&
		reflect.DeepEqual(release.Spec.ManifestSource.Artifact, artifact) &&
		release.Annotations[sourceRevisionAnnotation] == artifact.Revision &&
		app.Spec.Source.Inline.ManifestHash != "" && release.Annotations[sourceHashAnnotation] == app.Spec.Source.Inline.ManifestHash && metav1.IsControlledBy(release, app)
}

// External publishers retain ownership of creating their inline Releases. Bind
// source identity only after the owned Release selects this exact immutable
// bundle; an Application edit alone must never relabel the previous deployment.
func (r *ApplicationReconciler) prepareInlineArtifactSource(ctx context.Context, app *paprikav1.Application) error {
	deployment := effectiveDeploymentApp(app)
	artifact := inlineArtifact(deployment)
	if artifact == nil {
		return nil
	}
	_, hash, err := readInlineArtifactSnapshot(ctx, r.client, deployment.Namespace, deployment.Spec.Source.Inline.ConfigMapRef, appTargetNamespace(deployment), deployment.Spec.Source.Inline.ManifestHash, artifact)
	if err != nil {
		return err
	}
	if !promotionReady(app) {
		release := r.getCurrentRelease(ctx, app)
		if release == nil || !artifactReleaseMatches(deployment, release) {
			return nil
		}
		if release.Annotations[sourceHashAnnotation] != hash {
			return errors.New("inline artifact release snapshot differs from its frozen source hash")
		}
	}
	if app.Status.SourceHash == hash && app.Status.SourceRevision == artifact.Revision {
		return nil
	}
	app.Status.SourceHash = hash
	app.Status.SourceRevision = artifact.Revision
	if err := r.patchAppStatus(ctx, app); err != nil {
		return fmt.Errorf("bind inline artifact source identity: %w", err)
	}
	return nil
}

func (r *ApplicationReconciler) compatibleInlineArtifacts(ctx context.Context, target, upstream *paprikav1.Application) error {
	if err := compatibleInlineArtifactIdentity(inlineArtifact(target), inlineArtifact(upstream)); err != nil {
		return err
	}
	release := r.getCurrentRelease(ctx, upstream)
	if release == nil || !artifactReleaseMatches(upstream, release) {
		return errors.New("upstream release does not bind the declared inline artifact and snapshot")
	}
	for _, app := range []*paprikav1.Application{upstream, target} {
		_, hash, err := readInlineArtifactSnapshot(ctx, r.client, app.Namespace, app.Spec.Source.Inline.ConfigMapRef, appTargetNamespace(app), app.Spec.Source.Inline.ManifestHash, inlineArtifact(app))
		if err != nil {
			return err
		}
		if app == upstream && release.Annotations[sourceHashAnnotation] != hash {
			return errors.New("upstream inline artifact snapshot differs from its frozen release payload")
		}
	}
	return nil
}

func compatibleInlineArtifactIdentity(left, right *paprikav1.InlineArtifact) error {
	if left == nil || right == nil {
		return errors.New("inline promotion requires versioned artifacts in both Applications")
	}
	leftRepo, err := canonicalArtifactRepository(left.Repository)
	if err != nil {
		return err
	}
	rightRepo, err := canonicalArtifactRepository(right.Repository)
	if err != nil {
		return err
	}
	if leftRepo != rightRepo || left.Revision != right.Revision || !reflect.DeepEqual(left.Images, right.Images) {
		return errors.New("inline promotion requires the same artifact repository, revision and immutable image mapping")
	}
	return nil
}

func appTargetNamespace(app *paprikav1.Application) string {
	if app.Spec.Source.TargetNamespace != "" {
		return app.Spec.Source.TargetNamespace
	}
	return app.Namespace
}

func inlineReleaseManifestSource(app *paprikav1.Application) *paprikav1.ManifestSource {
	app = effectiveDeploymentApp(app)
	if inlineArtifact(app) == nil {
		return nil
	}
	return &paprikav1.ManifestSource{
		ConfigMapRef: app.Spec.Source.Inline.ConfigMapRef,
		Artifact:     app.Spec.Source.Inline.Artifact.DeepCopy(),
	}
}

func inlineArtifactPayloadHash(payload []byte) string {
	hash := sha256.Sum256(payload)
	return hex.EncodeToString(hash[:])
}

func validateInlineArtifactReleaseSnapshot(snapshot *corev1.ConfigMap, release *paprikav1.Release, targetNamespace string) error {
	if release.Spec.ManifestSource == nil || release.Spec.ManifestSource.Artifact == nil {
		return nil
	}
	artifact := release.Spec.ManifestSource.Artifact
	if snapshot.Immutable == nil || !*snapshot.Immutable || release.Annotations[sourceRevisionAnnotation] != artifact.Revision {
		return errors.New("inline artifact release requires an immutable snapshot and matching source revision")
	}
	payload := []byte(snapshot.Data["manifests.yaml"])
	if release.Annotations[sourceHashAnnotation] != inlineArtifactPayloadHash(payload) {
		return errors.New("inline artifact snapshot differs from its frozen release source hash")
	}
	defaultNamespace := targetNamespace
	if defaultNamespace == "" {
		defaultNamespace = release.Namespace
	}
	return validateInlineArtifactDocuments(payload, artifact, targetNamespace, defaultNamespace)
}

func validateInlineArtifactApplicationSnapshot(snapshot *corev1.ConfigMap, release *paprikav1.Release, app *paprikav1.Application) error {
	if release.Spec.ManifestSource == nil || release.Spec.ManifestSource.Artifact == nil {
		return nil
	}
	deployment := effectiveDeploymentApp(app)
	if inlineArtifact(deployment) == nil || deployment.Spec.Source.Inline.ManifestHash != release.Annotations[sourceHashAnnotation] {
		return errors.New("inline artifact release source hash differs from the accepted manifestHash")
	}
	return validateInlineArtifactReleaseSnapshot(snapshot, release, appTargetNamespace(deployment))
}
