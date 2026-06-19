package receiver

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// testGithubRepo mirrors the webhook payload structure for tests.
//
//nolint:tagliatelle // Webhook payloads use snake_case.
type testGithubRepo struct {
	CloneURL string `json:"clone_url"`
}

// testGitlabProject mirrors the webhook payload structure for tests.
//
//nolint:tagliatelle // Webhook payloads use snake_case.
type testGitlabProject struct {
	GitHTTPURL string `json:"git_http_url"`
}

func TestHandler_ServeHTTP_GitHubPush(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	_ = paprika.AddToScheme(scheme)

	cases := []struct {
		name        string
		ref         string
		wantTrigger bool
	}{
		{"matching branch", "refs/heads/main", true},
		{"wrong branch", "refs/heads/other", false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			app := &paprika.Application{
				ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: "default"},
				Spec: paprika.ApplicationSpec{
					Source: paprika.ApplicationSource{
						Type:     "git",
						RepoURL:  "https://github.com/org/repo.git",
						Revision: "main",
					},
				},
			}

			c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).Build()
			h := NewHandler(c, "")

			payload, _ := json.Marshal(githubPushPayload{
				Ref:        tc.ref,
				Repository: testGithubRepo{CloneURL: "https://github.com/org/repo.git"},
			})

			req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/webhook", bytes.NewReader(payload))
			req.Header.Set(githubEventHeader, githubPushEvent)
			rec := httptest.NewRecorder()

			h.ServeHTTP(rec, req)
			assert.Equal(t, http.StatusAccepted, rec.Code)

			var updated paprika.Application
			_ = c.Get(context.Background(), types.NamespacedName{Name: "app-1", Namespace: "default"}, &updated)
			if tc.wantTrigger {
				assert.NotEmpty(t, updated.Annotations["paprika.io/sync"])
			} else {
				assert.Empty(t, updated.Annotations["paprika.io/sync"])
			}
		})
	}
}

func TestHandler_ServeHTTP_GitLabPush(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	_ = paprika.AddToScheme(scheme)

	tmpl := &paprika.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "tmpl-1", Namespace: "default"},
		Spec: paprika.TemplateSpec{
			Type: "git",
			Git: &paprika.GitSourceSpec{
				RepoURL:  "https://gitlab.com/org/repo.git",
				Revision: "develop",
			},
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(tmpl).Build()
	h := NewHandler(c, "")

	payload, _ := json.Marshal(gitlabPushPayload{
		Ref:     "refs/heads/develop",
		Project: testGitlabProject{GitHTTPURL: "https://gitlab.com/org/repo.git"},
	})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/webhook", bytes.NewReader(payload))
	req.Header.Set(gitlabEventHeader, gitlabPushEvent)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusAccepted, rec.Code)

	var updated paprika.Template
	_ = c.Get(context.Background(), types.NamespacedName{Name: "tmpl-1", Namespace: "default"}, &updated)
	assert.NotEmpty(t, updated.Annotations["paprika.io/sync"])
}

func TestHandler_ServeHTTP_Ping(t *testing.T) {
	t.Parallel()
	c := fake.NewClientBuilder().Build()
	h := NewHandler(c, "")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/webhook", nil)
	req.Header.Set(githubEventHeader, githubPingEvent)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestHandler_ServeHTTP_InvalidEvent(t *testing.T) {
	t.Parallel()
	c := fake.NewClientBuilder().Build()
	h := NewHandler(c, "")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/webhook", nil)
	req.Header.Set(githubEventHeader, "unknown")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestHandler_ServeHTTP_GitHubSignature(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	_ = paprika.AddToScheme(scheme)

	app := &paprika.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: "default"},
		Spec: paprika.ApplicationSpec{
			Source: paprika.ApplicationSource{
				Type:    "git",
				RepoURL: "https://github.com/org/repo.git",
			},
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).Build()
	secret := "test-secret"
	h := NewHandler(c, secret)

	payload := []byte(`{"ref":"refs/heads/main","repository":{"clone_url":"https://github.com/org/repo.git"}}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/webhook", bytes.NewReader(payload))
	req.Header.Set(githubEventHeader, githubPushEvent)
	req.Header.Set(githubSignature, sig)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusAccepted, rec.Code)
}

func TestUrlsEqual(t *testing.T) {
	t.Parallel()
	assert.True(t, urlsEqual("https://github.com/org/repo.git", "https://github.com/org/repo"))
	assert.True(t, urlsEqual("https://github.com/org/repo", "https://github.com/org/repo"))
	assert.False(t, urlsEqual("https://github.com/org/repo", "https://github.com/org/other"))
	assert.True(t, urlsEqual("https://USER:PASS@github.com/org/repo.git", "https://github.com/org/repo"))
}

func TestNormalizeURL(t *testing.T) {
	t.Parallel()
	u, err := normalizeURL("https://github.com/org/repo.git")
	require.NoError(t, err)
	assert.Equal(t, "https://github.com/org/repo", u)
}

type fixedClock struct {
	now time.Time
}

func (f *fixedClock) Now() time.Time { return f.now }

func TestNowString(t *testing.T) {
	t.Parallel()
	now := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	c := fake.NewClientBuilder().Build()
	h := NewHandler(c, "", WithClock(&fixedClock{now: now}))

	assert.Equal(t, "1704067200", h.nowString())
}

// Ensure Handler implements http.Handler.
var _ http.Handler = (*Handler)(nil)
