// Package repository resolves Repository CRDs into concrete source configurations
// and credentials for renderers and controllers.
package repository

import (
	"context"
	"fmt"
	"strconv"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
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
	Spec      paprikav1.TemplateSpec
	Username  string
	Password  string
	GitHubApp *source.GitHubAppAuth
	Insecure  bool
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

	githubApp, err := r.resolveGitHubApp(ctx, namespace, &repo)
	if err != nil {
		return nil, err
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
		Spec:      *resolved,
		Username:  username,
		Password:  password,
		GitHubApp: githubApp,
		Insecure:  repo.Spec.Insecure,
	}, nil
}

func (r *Resolver) resolveGitHubApp(ctx context.Context, namespace string, repo *corev1alpha1.Repository) (*source.GitHubAppAuth, error) {
	if repo.Spec.Type != corev1alpha1.RepositoryTypeGit || repo.Spec.GitHubApp == nil {
		return nil, nil
	}
	privateKey, err := r.loadSecretKey(ctx, namespace, repo.Spec.SecretRef, "privateKey")
	if err != nil {
		return nil, fmt.Errorf("load github app private key: %w", err)
	}
	appID, err := strconv.ParseInt(repo.Spec.GitHubApp.AppID, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("parse github app appID: %w", err)
	}
	installationID, err := strconv.ParseInt(repo.Spec.GitHubApp.InstallationID, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("parse github app installationID: %w", err)
	}
	return &source.GitHubAppAuth{
		AppID:          appID,
		InstallationID: installationID,
		PrivateKey:     []byte(privateKey),
		EnterpriseURL:  repo.Spec.GitHubApp.EnterpriseURL,
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

func (r *Resolver) loadSecretKey(ctx context.Context, namespace string, ref *corev1alpha1.SecretRef, key string) (string, error) {
	if ref == nil || ref.Name == "" {
		return "", fmt.Errorf("secret ref is required for %s", key)
	}
	var secret corev1.Secret
	if err := r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: namespace}, &secret); err != nil {
		return "", fmt.Errorf("get secret %s/%s: %w", namespace, ref.Name, err)
	}
	value, ok := secret.Data[key]
	if !ok {
		return "", fmt.Errorf("secret %s/%s missing key %q", namespace, ref.Name, key)
	}
	return string(value), nil
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
