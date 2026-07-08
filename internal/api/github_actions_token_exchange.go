package apiserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const githubActionsIssuerURL = "https://token.actions.githubusercontent.com"

// GitHubActionsTokenExchangeConfig controls the public GitHub Actions OIDC
// exchange endpoint. Repository, environment, and service account settings are
// intentionally explicit so accidental broad token minting is hard to enable.
type GitHubActionsTokenExchangeConfig struct {
	Audience                string
	Repository              string
	Environment             string
	Subject                 string
	ServiceAccountNamespace string
	ServiceAccountName      string
	ServiceAccountTokenTTL  time.Duration
}

// GitHubActionsClaims are the claims this exchange authorizes against.
type GitHubActionsClaims struct {
	Subject     string
	Repository  string `json:"repository"`
	Environment string `json:"environment"`
}

// GitHubActionsTokenVerifier validates a raw GitHub Actions OIDC JWT.
type GitHubActionsTokenVerifier interface {
	VerifyGitHubActionsToken(ctx context.Context, rawToken string) (*GitHubActionsClaims, error)
}

// ServiceAccountTokenIssuer mints Kubernetes API tokens for a service account.
type ServiceAccountTokenIssuer interface {
	IssueServiceAccountToken(ctx context.Context, namespace, name string, expiration time.Duration) (string, time.Time, error)
}

// NewGitHubActionsTokenExchangeHandler returns an HTTP handler that exchanges a
// verified GitHub Actions OIDC token for a short-lived Kubernetes ExecCredential.
func NewGitHubActionsTokenExchangeHandler(
	cfg *GitHubActionsTokenExchangeConfig,
	verifier GitHubActionsTokenVerifier,
	issuer ServiceAccountTokenIssuer,
) http.Handler {
	if cfg == nil {
		cfg = &GitHubActionsTokenExchangeConfig{}
	}
	if cfg.ServiceAccountTokenTTL <= 0 {
		cfg.ServiceAccountTokenTTL = 15 * time.Minute
	}

	return &githubActionsTokenExchangeHandler{
		cfg:      cfg,
		verifier: verifier,
		issuer:   issuer,
	}
}

type githubActionsTokenExchangeHandler struct {
	cfg      *GitHubActionsTokenExchangeConfig
	verifier GitHubActionsTokenVerifier
	issuer   ServiceAccountTokenIssuer
}

func (h *githubActionsTokenExchangeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.verifier == nil || h.issuer == nil {
		http.Error(w, "token exchange is not configured", http.StatusServiceUnavailable)
		return
	}
	h.exchange(w, r)
}

func (h *githubActionsTokenExchangeHandler) exchange(w http.ResponseWriter, r *http.Request) {
	rawToken, ok := readGitHubActionsToken(w, r)
	if !ok {
		return
	}

	claims, err := h.verifier.VerifyGitHubActionsToken(r.Context(), rawToken)
	if err != nil {
		http.Error(w, "invalid GitHub Actions token", http.StatusUnauthorized)
		return
	}
	if authErr := authorizeGitHubActionsClaims(h.cfg, claims); authErr != nil {
		http.Error(w, "GitHub Actions token is not allowed", http.StatusForbidden)
		return
	}

	token, expiresAt, err := h.issuer.IssueServiceAccountToken(
		r.Context(),
		h.cfg.ServiceAccountNamespace,
		h.cfg.ServiceAccountName,
		h.cfg.ServiceAccountTokenTTL,
	)
	if err != nil {
		http.Error(w, "could not mint Kubernetes token", http.StatusBadGateway)
		return
	}

	if writeErr := writeExecCredential(w, token, expiresAt); writeErr != nil {
		return
	}
}

func readGitHubActionsToken(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return "", false
	}
	if req.Token == "" {
		http.Error(w, "token is required", http.StatusBadRequest)
		return "", false
	}
	return req.Token, true
}

func authorizeGitHubActionsClaims(cfg *GitHubActionsTokenExchangeConfig, claims *GitHubActionsClaims) error {
	if claims == nil {
		return errors.New("missing claims")
	}
	if cfg.Repository == "" {
		return errors.New("repository is required")
	}
	if claims.Repository != cfg.Repository {
		return fmt.Errorf("repository %q is not allowed", claims.Repository)
	}
	if cfg.Environment != "" && claims.Environment != cfg.Environment {
		return fmt.Errorf("environment %q is not allowed", claims.Environment)
	}
	if cfg.Subject != "" && claims.Subject != cfg.Subject {
		return fmt.Errorf("subject %q is not allowed", claims.Subject)
	}
	return nil
}

type oidcGitHubActionsTokenVerifier struct {
	verifier *oidc.IDTokenVerifier
}

// NewGitHubActionsTokenVerifier builds a verifier for GitHub Actions OIDC ID tokens.
func NewGitHubActionsTokenVerifier(ctx context.Context, audience string) (GitHubActionsTokenVerifier, error) {
	if audience == "" {
		return nil, errors.New("audience is required")
	}
	provider, err := oidc.NewProvider(ctx, githubActionsIssuerURL)
	if err != nil {
		return nil, fmt.Errorf("create GitHub Actions OIDC provider: %w", err)
	}
	return &oidcGitHubActionsTokenVerifier{
		verifier: provider.Verifier(&oidc.Config{ClientID: audience}),
	}, nil
}

func (v *oidcGitHubActionsTokenVerifier) VerifyGitHubActionsToken(ctx context.Context, rawToken string) (*GitHubActionsClaims, error) {
	idToken, err := v.verifier.Verify(ctx, rawToken)
	if err != nil {
		return nil, fmt.Errorf("verify GitHub Actions ID token: %w", err)
	}

	var claims GitHubActionsClaims
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}
	claims.Subject = idToken.Subject
	return &claims, nil
}

type kubernetesServiceAccountTokenIssuer struct {
	client kubernetes.Interface
}

// NewKubernetesServiceAccountTokenIssuer returns a TokenRequest-backed issuer.
func NewKubernetesServiceAccountTokenIssuer(client kubernetes.Interface) ServiceAccountTokenIssuer {
	return &kubernetesServiceAccountTokenIssuer{client: client}
}

func (i *kubernetesServiceAccountTokenIssuer) IssueServiceAccountToken(ctx context.Context, namespace, name string, expiration time.Duration) (string, time.Time, error) {
	if namespace == "" {
		return "", time.Time{}, errors.New("service account namespace is required")
	}
	if name == "" {
		return "", time.Time{}, errors.New("service account name is required")
	}
	if i == nil || i.client == nil {
		return "", time.Time{}, errors.New("kubernetes client is required")
	}

	expirationSeconds := int64(expiration.Seconds())
	tokenRequest := &authenticationv1.TokenRequest{
		Spec: authenticationv1.TokenRequestSpec{
			ExpirationSeconds: &expirationSeconds,
		},
	}
	resp, err := i.client.CoreV1().ServiceAccounts(namespace).CreateToken(ctx, name, tokenRequest, metav1.CreateOptions{})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("create service account token: %w", err)
	}
	return resp.Status.Token, resp.Status.ExpirationTimestamp.Time, nil
}

func writeExecCredential(w http.ResponseWriter, token string, expiresAt time.Time) error {
	resp := struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
		Status     struct {
			ExpirationTimestamp *time.Time `json:"expirationTimestamp,omitempty"`
			Token               string     `json:"token"`
		} `json:"status"`
	}{
		APIVersion: "client.authentication.k8s.io/v1",
		Kind:       "ExecCredential",
	}
	resp.Status.Token = token
	if !expiresAt.IsZero() {
		resp.Status.ExpirationTimestamp = &expiresAt
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		return fmt.Errorf("encode exec credential: %w", err)
	}
	return nil
}
