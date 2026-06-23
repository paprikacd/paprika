// Package oci provides helpers for verifying OCI artifact references.
package oci

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/distribution/reference"
	"oras.land/oras-go/v2/registry/remote"
	"oras.land/oras-go/v2/registry/remote/auth"
)

// Verifier resolves an OCI reference and returns the descriptor digest.
type Verifier interface {
	Verify(ctx context.Context, ref string) (digest string, err error)
}

// RemoteVerifier resolves references against an OCI registry.
type RemoteVerifier struct {
	HTTPClient *http.Client
}

// NewVerifier creates a verifier with a default HTTP client.
func NewVerifier() *RemoteVerifier {
	return &RemoteVerifier{
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// Verify resolves the OCI reference and returns the descriptor digest.
func (r *RemoteVerifier) Verify(ctx context.Context, ref string) (string, error) {
	ref = strings.TrimPrefix(ref, "oci://")
	parsed, err := reference.ParseAnyReference(ref)
	if err != nil {
		return "", fmt.Errorf("parse OCI reference %q: %w", ref, err)
	}

	named, ok := parsed.(reference.Named)
	if !ok {
		return "", fmt.Errorf("OCI reference %q is not a named reference", ref)
	}

	repoName := reference.Domain(named) + "/" + reference.Path(named)
	repo, err := remote.NewRepository(repoName)
	if err != nil {
		return "", fmt.Errorf("create repository client for %q: %w", repoName, err)
	}
	repo.Client = &auth.Client{
		Client: r.HTTPClient,
		Cache:  auth.DefaultCache,
	}

	var targetRef string
	switch v := parsed.(type) {
	case reference.Tagged:
		targetRef = v.Tag()
	case reference.Digested:
		return string(v.Digest()), nil
	default:
		return "", errors.New("OCI reference must include a tag or digest")
	}

	desc, err := repo.Resolve(ctx, targetRef)
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", ref, err)
	}
	return desc.Digest.String(), nil
}

// NopVerifier is a test double that always succeeds.
type NopVerifier struct{}

func (NopVerifier) Verify(_ context.Context, ref string) (string, error) {
	return "sha256:" + strings.Repeat("0", 64), nil
}
