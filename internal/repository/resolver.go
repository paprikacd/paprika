// Package repository resolves Repository CRDs into concrete source configurations
// and credentials for renderers and controllers.
package repository

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Resolver looks up Repository CRDs and their credentials.
type Resolver struct {
	client client.Client
}

// NewResolver creates a resolver backed by the given Kubernetes client.
func NewResolver(c client.Client) *Resolver {
	return &Resolver{client: c}
}

// Resolved holds a TemplateSpec with Repository fields merged in, plus credentials.
type Resolved struct {
	Spec     paprikav1.TemplateSpec
	Username string
	Password string
	Insecure bool
}

// ResolveTemplate merges a Repository reference into the template spec and loads credentials.
func (r *Resolver) ResolveTemplate(ctx context.Context, namespace string, spec *paprikav1.TemplateSpec) (*Resolved, error) {
	if spec == nil || spec.RepoRef == "" {
		return nil, nil
	}

	var repo corev1alpha1.Repository
	if err := r.client.Get(ctx, client.ObjectKey{Name: spec.RepoRef, Namespace: namespace}, &repo); err != nil {
		return nil, fmt.Errorf("get repository %s/%s: %w", namespace, spec.RepoRef, err)
	}

	resolved := spec.DeepCopy()
	resolved.RepoRef = ""

	username, password, err := r.loadSecret(ctx, namespace, repo.Spec.SecretRef)
	if err != nil {
		return nil, fmt.Errorf("load repository credentials: %w", err)
	}

	switch repo.Spec.Type {
	case corev1alpha1.RepositoryTypeGit:
		applyGitRepo(resolved, repo.Spec.URL, repo.Spec.SecretRef)
	case corev1alpha1.RepositoryTypeHelm:
		applyHelmRepo(resolved, repo.Spec.URL)
	case corev1alpha1.RepositoryTypeOCI:
		applyOCIRepo(resolved, repo.Spec.URL, repo.Spec.Insecure)
	}

	return &Resolved{
		Spec:     *resolved,
		Username: username,
		Password: password,
		Insecure: repo.Spec.Insecure,
	}, nil
}

func (r *Resolver) loadSecret(ctx context.Context, namespace string, ref *corev1alpha1.SecretRef) (username, password string, err error) {
	if ref == nil || ref.Name == "" {
		return "", "", nil
	}
	var secret corev1.Secret
	if err = r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: namespace}, &secret); err != nil {
		return "", "", fmt.Errorf("get secret %s/%s: %w", namespace, ref.Name, err)
	}
	return string(secret.Data["username"]), string(secret.Data["password"]), nil
}

func applyGitRepo(spec *paprikav1.TemplateSpec, repoURL string, secretRef *corev1alpha1.SecretRef) {
	if spec.Git == nil {
		return
	}
	if spec.Git.RepoURL == "" {
		spec.Git.RepoURL = repoURL
	}
	if spec.Git.SecretRef == "" && secretRef != nil {
		spec.Git.SecretRef = secretRef.Name
	}
}

func applyHelmRepo(spec *paprikav1.TemplateSpec, repoURL string) {
	if spec.Chart.Repo == "" {
		spec.Chart.Repo = repoURL
	}
}

func applyOCIRepo(spec *paprikav1.TemplateSpec, repoURL string, insecure bool) {
	if spec.OCI == nil {
		return
	}
	if spec.OCI.URL == "" {
		spec.OCI.URL = repoURL
	}
	spec.OCI.Insecure = spec.OCI.Insecure || insecure
}
