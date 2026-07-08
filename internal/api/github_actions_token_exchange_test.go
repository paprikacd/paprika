package apiserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeGitHubTokenVerifier struct {
	claims *GitHubActionsClaims
	err    error
	raw    string
}

func (f *fakeGitHubTokenVerifier) VerifyGitHubActionsToken(_ context.Context, rawToken string) (*GitHubActionsClaims, error) {
	f.raw = rawToken
	if f.err != nil {
		return nil, f.err
	}
	return f.claims, nil
}

type fakeServiceAccountTokenIssuer struct {
	namespace  string
	name       string
	expiration time.Duration
	token      string
	expiresAt  time.Time
	err        error
}

func (f *fakeServiceAccountTokenIssuer) IssueServiceAccountToken(_ context.Context, namespace, name string, expiration time.Duration) (string, time.Time, error) {
	f.namespace = namespace
	f.name = name
	f.expiration = expiration
	if f.err != nil {
		return "", time.Time{}, f.err
	}
	return f.token, f.expiresAt, nil
}

func TestGitHubActionsTokenExchangeIssuesExecCredential(t *testing.T) {
	t.Parallel()

	expiresAt := time.Date(2026, 7, 8, 10, 0, 0, 0, time.UTC)
	verifier := &fakeGitHubTokenVerifier{claims: &GitHubActionsClaims{
		Subject:     "repo:paprikacd/paprika:environment:vke-production",
		Repository:  "paprikacd/paprika",
		Environment: "vke-production",
	}}
	issuer := &fakeServiceAccountTokenIssuer{token: "k8s-token", expiresAt: expiresAt}

	handler := NewGitHubActionsTokenExchangeHandler(&GitHubActionsTokenExchangeConfig{
		Audience:                "paprika-vke-deploy",
		Repository:              "paprikacd/paprika",
		Environment:             "vke-production",
		Subject:                 "repo:paprikacd/paprika:environment:vke-production",
		ServiceAccountNamespace: "paprika-e2e",
		ServiceAccountName:      "github-actions-vke-deployer",
		ServiceAccountTokenTTL:  15 * time.Minute,
	}, verifier, issuer)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/auth/github-actions/token", strings.NewReader(`{"token":"github-token"}`))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if verifier.raw != "github-token" {
		t.Fatalf("verifier token = %q", verifier.raw)
	}
	if issuer.namespace != "paprika-e2e" || issuer.name != "github-actions-vke-deployer" {
		t.Fatalf("issued token for %s/%s", issuer.namespace, issuer.name)
	}
	if issuer.expiration != 15*time.Minute {
		t.Fatalf("expiration = %s", issuer.expiration)
	}
	body := res.Body.String()
	for _, want := range []string{
		`"apiVersion":"client.authentication.k8s.io/v1"`,
		`"kind":"ExecCredential"`,
		`"token":"k8s-token"`,
		`"expirationTimestamp":"2026-07-08T10:00:00Z"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("response missing %s: %s", want, body)
		}
	}
}

func TestGitHubActionsTokenExchangeRejectsWrongClaims(t *testing.T) {
	t.Parallel()

	verifier := &fakeGitHubTokenVerifier{claims: &GitHubActionsClaims{
		Subject:     "repo:someone/else:environment:vke-production",
		Repository:  "someone/else",
		Environment: "vke-production",
	}}
	issuer := &fakeServiceAccountTokenIssuer{token: "k8s-token"}

	handler := NewGitHubActionsTokenExchangeHandler(&GitHubActionsTokenExchangeConfig{
		Repository:              "paprikacd/paprika",
		Environment:             "vke-production",
		ServiceAccountNamespace: "paprika-e2e",
		ServiceAccountName:      "github-actions-vke-deployer",
	}, verifier, issuer)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/auth/github-actions/token", strings.NewReader(`{"token":"github-token"}`))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if issuer.name != "" {
		t.Fatalf("issuer should not have been called")
	}
}

func TestGitHubActionsTokenExchangeRejectsVerifierErrors(t *testing.T) {
	t.Parallel()

	handler := NewGitHubActionsTokenExchangeHandler(&GitHubActionsTokenExchangeConfig{
		Repository:              "paprikacd/paprika",
		Environment:             "vke-production",
		ServiceAccountNamespace: "paprika-e2e",
		ServiceAccountName:      "github-actions-vke-deployer",
	}, &fakeGitHubTokenVerifier{err: errors.New("signature failed")}, &fakeServiceAccountTokenIssuer{})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/auth/github-actions/token", strings.NewReader(`{"token":"github-token"}`))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "signature failed") {
		t.Fatalf("response leaked verifier error: %s", res.Body.String())
	}
}
