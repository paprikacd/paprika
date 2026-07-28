package apiserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	trustedRepository     = "paprikacd/paprika"
	trustedEnvironment    = "vke-production"
	trustedSubject        = "repo:paprikacd/paprika:environment:vke-production"
	trustedRef            = "refs/heads/master"
	automaticWorkflowRef  = "paprikacd/paprika/.github/workflows/ci.yml@refs/heads/master"
	manualWorkflowRef     = "paprikacd/paprika/.github/workflows/deploy-vke-manual.yml@refs/heads/master"
	trustedJobWorkflowRef = "paprikacd/paprika/.github/workflows/deploy-vke.yml@refs/heads/master"
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

func trustedGitHubActionsTokenExchangeConfig(t testing.TB) *GitHubActionsTokenExchangeConfig {
	t.Helper()
	cfg := &GitHubActionsTokenExchangeConfig{
		Audience:                "paprika-vke-deploy",
		Repository:              trustedRepository,
		Environment:             trustedEnvironment,
		Subject:                 trustedSubject,
		ServiceAccountNamespace: "paprika-e2e",
		ServiceAccountName:      "github-actions-vke-deployer",
		ServiceAccountTokenTTL:  15 * time.Minute,
	}
	boundary := map[string]any{
		"AllowedEventNames":   []string{"push", "repository_dispatch"},
		"Ref":                 trustedRef,
		"AllowedWorkflowRefs": []string{automaticWorkflowRef, manualWorkflowRef},
		"JobWorkflowRef":      trustedJobWorkflowRef,
	}
	data, err := json.Marshal(boundary)
	if err != nil {
		t.Fatalf("marshal trusted config: %v", err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		t.Fatalf("unmarshal trusted config: %v", err)
	}
	return cfg
}

func trustedGitHubActionsClaims(t testing.TB, eventName, workflowRef string, overrides map[string]string) *GitHubActionsClaims {
	t.Helper()
	payload := map[string]string{
		"repository":       trustedRepository,
		"environment":      trustedEnvironment,
		"event_name":       eventName,
		"ref":              trustedRef,
		"workflow_ref":     workflowRef,
		"job_workflow_ref": trustedJobWorkflowRef,
	}
	for name, value := range overrides {
		payload[name] = value
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal trusted claims: %v", err)
	}
	var claims GitHubActionsClaims
	if err := json.Unmarshal(data, &claims); err != nil {
		t.Fatalf("unmarshal trusted claims: %v", err)
	}
	claims.Subject = trustedSubject
	return &claims
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
	verifier := &fakeGitHubTokenVerifier{claims: trustedGitHubActionsClaims(t, "push", automaticWorkflowRef, nil)}
	issuer := &fakeServiceAccountTokenIssuer{token: "k8s-token", expiresAt: expiresAt}

	handler := NewGitHubActionsTokenExchangeHandler(trustedGitHubActionsTokenExchangeConfig(t), verifier, issuer)

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

func TestGitHubActionsTokenExchangeAuthorizesTrustedWorkflowBoundary(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		event     string
		workflow  string
		overrides map[string]string
		allowed   bool
	}{
		{name: "automatic master push", event: "push", workflow: automaticWorkflowRef, allowed: true},
		{name: "manual repository dispatch", event: "repository_dispatch", workflow: manualWorkflowRef, allowed: true},
		{name: "pull request event", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"event_name": "pull_request"}},
		{name: "other branch", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"ref": "refs/heads/feature"}},
		{name: "foreign caller workflow", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"workflow_ref": "paprikacd/paprika/.github/workflows/foreign.yml@refs/heads/master"}},
		{name: "wrong called workflow", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"job_workflow_ref": "paprikacd/paprika/.github/workflows/foreign.yml@refs/heads/master"}},
		{name: "missing event name", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"event_name": ""}},
		{name: "missing ref", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"ref": ""}},
		{name: "missing caller workflow", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"workflow_ref": ""}},
		{name: "missing called workflow", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"job_workflow_ref": ""}},
		{name: "foreign repository", event: "push", workflow: automaticWorkflowRef, overrides: map[string]string{"repository": "someone/else"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			verifier := &fakeGitHubTokenVerifier{claims: trustedGitHubActionsClaims(t, test.event, test.workflow, test.overrides)}
			issuer := &fakeServiceAccountTokenIssuer{token: "k8s-token"}
			handler := NewGitHubActionsTokenExchangeHandler(trustedGitHubActionsTokenExchangeConfig(t), verifier, issuer)

			req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/auth/github-actions/token", strings.NewReader(`{"token":"github-token"}`))
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)

			if test.allowed {
				if res.Code != http.StatusOK {
					t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
				}
				if issuer.name == "" {
					t.Fatal("issuer was not called for trusted claims")
				}
				return
			}
			if res.Code != http.StatusForbidden {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
			if issuer.name != "" {
				t.Fatal("issuer must not be called for untrusted claims")
			}
		})
	}
}

func TestGitHubActionsClaimsParseWorkflowBoundary(t *testing.T) {
	t.Parallel()

	var claims GitHubActionsClaims
	if err := json.Unmarshal([]byte(`{
		"event_name":"repository_dispatch",
		"ref":"refs/heads/master",
		"workflow_ref":"paprikacd/paprika/.github/workflows/deploy-vke-manual.yml@refs/heads/master",
		"job_workflow_ref":"paprikacd/paprika/.github/workflows/deploy-vke.yml@refs/heads/master"
	}`), &claims); err != nil {
		t.Fatalf("unmarshal claims: %v", err)
	}
	data, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal parsed claims: %v", err)
	}
	var roundTrip map[string]any
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatalf("unmarshal parsed claims map: %v", err)
	}
	want := map[string]string{
		"event_name":       "repository_dispatch",
		"ref":              trustedRef,
		"workflow_ref":     manualWorkflowRef,
		"job_workflow_ref": trustedJobWorkflowRef,
	}
	for name, value := range want {
		if got := reflect.ValueOf(roundTrip[name]); !got.IsValid() || got.String() != value {
			t.Errorf("claim %s = %v, want %q", name, roundTrip[name], value)
		}
	}
}

func TestGitHubActionsTokenExchangeRejectsVerifierErrors(t *testing.T) {
	t.Parallel()

	handler := NewGitHubActionsTokenExchangeHandler(&GitHubActionsTokenExchangeConfig{
		Repository:              trustedRepository,
		Environment:             trustedEnvironment,
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
