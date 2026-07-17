package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/types"
)

const (
	// #nosec G101 -- deterministic fake value used only by the TokenReview tests.
	testKubernetesBearer = "kubernetes-credential-secret"
	sessionHeader        = "X-Paprika-Admin-Session"
)

type observedAdminRequest struct {
	path                string
	principalSubject    string
	descriptionSubject  string
	authorizationHeader string
	sessionHeader       string
}

type adminHTTPFixture struct {
	handler  http.Handler
	store    *Store
	clock    *testClock
	tokens   *sequenceTokenSource
	review   *KubernetesReview
	access   *fakeSubjectAccessReviewer
	observed chan observedAdminRequest
}

func newAdminHTTPFixture(t *testing.T) *adminHTTPFixture {
	t.Helper()

	store, clock, tokens := newTestStore()
	review, _, _, access := validKubernetesReview()
	observed := make(chan observedAdminRequest, 8)
	protected := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		principal, principalOK := ValidatedPrincipalFromContext(request.Context())
		description, descriptionOK := SessionDescriptionFromContext(request.Context())
		if !principalOK || !descriptionOK {
			t.Error("protected handler did not receive a validated admin context")
			http.Error(w, "missing validated context", http.StatusInternalServerError)
			return
		}
		observed <- observedAdminRequest{
			path:                request.URL.Path,
			principalSubject:    principal.Subject,
			descriptionSubject:  description.Subject,
			authorizationHeader: request.Header.Get("Authorization"),
			sessionHeader:       request.Header.Get(sessionHeader),
		}
		w.WriteHeader(http.StatusNoContent)
	})
	handler, err := NewHTTPHandler(&HTTPConfig{
		Store:          store,
		Review:         review,
		PodUID:         review.Identity.UID,
		HealthHandler:  statusHandler(http.StatusOK),
		ReadyHandler:   statusHandler(http.StatusOK),
		ConnectHandler: protected,
		UIHandler:      protected,
	})
	require.NoError(t, err)
	return &adminHTTPFixture{
		handler:  handler,
		store:    store,
		clock:    clock,
		tokens:   tokens,
		review:   review,
		access:   access,
		observed: observed,
	}
}

func statusHandler(status int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	})
}

func adminRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body io.Reader,
	headers map[string]string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(
		t.Context(),
		method,
		AdminListenerOrigin+path,
		body,
	)
	request.Host = "127.0.0.1:3001"
	if method == http.MethodPost || method == http.MethodDelete {
		request.Header.Set("Origin", AdminListenerOrigin)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func exchangeAdminSession(
	t *testing.T,
	fixture *adminHTTPFixture,
	currentToken string,
) ExchangeResponse {
	t.Helper()
	headers := map[string]string{"Authorization": "Bearer " + testKubernetesBearer}
	if currentToken != "" {
		headers[sessionHeader] = currentToken
	}
	recorder := adminRequest(
		t,
		fixture.handler,
		http.MethodPost,
		"/admin/session/exchange",
		http.NoBody,
		headers,
	)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
	var response ExchangeResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.NotEmpty(t, response.Token)
	require.Equal(t, "alice@example.com", response.Session.Subject)
	require.Equal(t, AccessMode, response.Session.AccessMode)
	require.NotContains(t, recorder.Body.String(), testKubernetesBearer)
	return response
}

func TestAdminHTTPHealthAndReadinessArePublic(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)

	for _, path := range []string{"/healthz", "/readyz"} {
		recorder := adminRequest(t, fixture.handler, http.MethodGet, path, http.NoBody, nil)
		assert.Equal(t, http.StatusOK, recorder.Code)
	}
}

func TestAdminHTTPExchangeCreatesAndAtomicallyRotatesSession(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)

	first := exchangeAdminSession(t, fixture, "")

	second := exchangeAdminSession(t, fixture, first.Token)
	assert.NotEqual(t, first.Token, second.Token)
	assert.Equal(t, first.Session.AbsoluteEnds, second.Session.AbsoluteEnds)

	old := adminRequest(t, fixture.handler, http.MethodGet, "/admin/session", http.NoBody, map[string]string{
		sessionHeader: first.Token,
	})
	assert.Equal(t, http.StatusUnauthorized, old.Code)

	current := adminRequest(t, fixture.handler, http.MethodGet, "/admin/session", http.NoBody, map[string]string{
		sessionHeader: second.Token,
	})
	assert.Equal(t, http.StatusOK, current.Code)
	assert.NotContains(t, current.Body.String(), second.Token)
	assert.Equal(t, "no-store", current.Header().Get("Cache-Control"))
}

func TestAdminHTTPExchangeRejectsRotationAcrossReviewedIdentities(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*authenticationv1.TokenReview)
	}{
		{
			name: "username changed",
			mutate: func(review *authenticationv1.TokenReview) {
				review.Status.User.Username = "bob@example.com"
			},
		},
		{
			name: "groups changed",
			mutate: func(review *authenticationv1.TokenReview) {
				review.Status.User.Groups = append(review.Status.User.Groups, "new-admin-group")
			},
		},
		{
			name: "extras changed",
			mutate: func(review *authenticationv1.TokenReview) {
				review.Status.User.Extra["oidc.example.com/team"] = []string{"different-team"}
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newAdminHTTPFixture(t)
			current := exchangeAdminSession(t, fixture, "")

			changed := authenticatedTokenReview("alice@example.com")
			test.mutate(changed)
			fixture.review.TokenReviews = &fakeTokenReviewer{response: changed}

			recorder := adminRequest(
				t,
				fixture.handler,
				http.MethodPost,
				"/admin/session/exchange",
				http.NoBody,
				map[string]string{
					"Authorization": "Bearer " + testKubernetesBearer,
					sessionHeader:   current.Token,
				},
			)
			assert.Equal(t, http.StatusForbidden, recorder.Code)
			assert.NotContains(t, recorder.Body.String(), current.Token)

			stillCurrent := adminRequest(
				t,
				fixture.handler,
				http.MethodGet,
				"/admin/session",
				http.NoBody,
				map[string]string{sessionHeader: current.Token},
			)
			assert.Equal(t, http.StatusOK, stillCurrent.Code)
			assert.Contains(t, stillCurrent.Body.String(), "alice@example.com")
		})
	}
}

func TestAdminHTTPExchangeRequiresStrictBearerAndMapsReviewFailures(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		authValues []string
		mutate     func(*adminHTTPFixture)
		wantStatus int
	}{
		{name: "missing bearer", wantStatus: http.StatusUnauthorized},
		{name: "basic credential", authValues: []string{"Basic secret"}, wantStatus: http.StatusUnauthorized},
		{name: "empty bearer", authValues: []string{"Bearer "}, wantStatus: http.StatusUnauthorized},
		{name: "lowercase scheme", authValues: []string{"bearer secret"}, wantStatus: http.StatusUnauthorized},
		{name: "credential whitespace", authValues: []string{"Bearer secret value"}, wantStatus: http.StatusUnauthorized},
		{name: "duplicate header", authValues: []string{"Bearer one", "Bearer two"}, wantStatus: http.StatusUnauthorized},
		{
			name:       "token review failure",
			authValues: []string{"Bearer " + testKubernetesBearer},
			mutate: func(fixture *adminHTTPFixture) {
				fixture.review.TokenReviews = &fakeTokenReviewer{
					response: authenticatedTokenReview("alice@example.com"),
					err:      errors.New("review API secret"),
				}
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "port forward denial",
			authValues: []string{"Bearer " + testKubernetesBearer},
			mutate: func(fixture *adminHTTPFixture) {
				fixture.access.response = &authorizationv1.SubjectAccessReview{
					Status: authorizationv1.SubjectAccessReviewStatus{Denied: true, Reason: "private reason"},
				}
			},
			wantStatus: http.StatusForbidden,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newAdminHTTPFixture(t)
			if test.mutate != nil {
				test.mutate(fixture)
			}
			request := httptest.NewRequestWithContext(
				t.Context(),
				http.MethodPost,
				AdminListenerOrigin+"/admin/session/exchange",
				http.NoBody,
			)
			request.Host = "127.0.0.1:3001"
			request.Header.Set("Origin", AdminListenerOrigin)
			for _, value := range test.authValues {
				request.Header.Add("Authorization", value)
			}
			recorder := httptest.NewRecorder()
			fixture.handler.ServeHTTP(recorder, request)

			assert.Equal(t, test.wantStatus, recorder.Code)
			assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			assert.NotContains(t, recorder.Body.String(), testKubernetesBearer)
			assert.NotContains(t, recorder.Body.String(), "review API secret")
			assert.NotContains(t, recorder.Body.String(), "private reason")
		})
	}
}

func TestAdminHTTPExchangeEnforcesJSONBodyContractAndLimit(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		body        string
		contentType string
		wantStatus  int
	}{
		{name: "no body", wantStatus: http.StatusCreated},
		{name: "empty JSON object", body: `{}`, contentType: "application/json", wantStatus: http.StatusCreated},
		{name: "wrong content type", body: `{}`, contentType: "text/plain", wantStatus: http.StatusUnsupportedMediaType},
		{name: "parameterized content type", body: `{}`, contentType: "application/json; charset=utf-8", wantStatus: http.StatusUnsupportedMediaType},
		{name: "unknown field", body: `{"credential":"secret"}`, contentType: "application/json", wantStatus: http.StatusBadRequest},
		{name: "trailing JSON", body: `{} {}`, contentType: "application/json", wantStatus: http.StatusBadRequest},
		{name: "oversized body", body: `{"padding":"` + strings.Repeat("x", maxExchangeBodyBytes) + `"}`, contentType: "application/json", wantStatus: http.StatusRequestEntityTooLarge},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newAdminHTTPFixture(t)
			headers := map[string]string{
				"Authorization": "Bearer " + testKubernetesBearer,
			}
			if test.contentType != "" {
				headers["Content-Type"] = test.contentType
			}
			recorder := adminRequest(
				t,
				fixture.handler,
				http.MethodPost,
				"/admin/session/exchange",
				bytes.NewBufferString(test.body),
				headers,
			)
			assert.Equal(t, test.wantStatus, recorder.Code, recorder.Body.String())
			assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			assert.NotContains(t, recorder.Body.String(), testKubernetesBearer)
		})
	}
}

func TestAdminHTTPSessionDescriptionAndRevocation(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)
	session := exchangeAdminSession(t, fixture, "")

	get := adminRequest(t, fixture.handler, http.MethodGet, "/admin/session", http.NoBody, map[string]string{
		sessionHeader: session.Token,
	})
	require.Equal(t, http.StatusOK, get.Code)
	assert.Equal(t, "application/json", get.Header().Get("Content-Type"))
	assert.Equal(t, "no-store", get.Header().Get("Cache-Control"))
	var description SessionDescription
	require.NoError(t, json.Unmarshal(get.Body.Bytes(), &description))
	assert.Equal(t, session.Session.Subject, description.Subject)
	assert.NotContains(t, get.Body.String(), session.Token)

	revoke := adminRequest(t, fixture.handler, http.MethodDelete, "/admin/session", http.NoBody, map[string]string{
		sessionHeader: session.Token,
	})
	assert.Equal(t, http.StatusNoContent, revoke.Code)
	assert.Empty(t, revoke.Body.String())
	assert.Equal(t, "no-store", revoke.Header().Get("Cache-Control"))

	after := adminRequest(t, fixture.handler, http.MethodGet, "/admin/session", http.NoBody, map[string]string{
		sessionHeader: session.Token,
	})
	assert.Equal(t, http.StatusUnauthorized, after.Code)
}

func TestAdminHTTPSessionRejectsMissingExpiredWrongPodAndOldTokens(t *testing.T) {
	t.Parallel()

	t.Run("missing", func(t *testing.T) {
		t.Parallel()
		fixture := newAdminHTTPFixture(t)
		for _, method := range []string{http.MethodGet, http.MethodDelete} {
			recorder := adminRequest(t, fixture.handler, method, "/admin/session", http.NoBody, nil)
			assert.Equal(t, http.StatusUnauthorized, recorder.Code)
			assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
		}
	})

	t.Run("wrong pod", func(t *testing.T) {
		t.Parallel()
		fixture := newAdminHTTPFixture(t)
		token, _, err := fixture.store.Create(reviewedIdentity(), types.UID("different-pod"))
		require.NoError(t, err)
		recorder := adminRequest(t, fixture.handler, http.MethodGet, "/admin/session", http.NoBody, map[string]string{
			sessionHeader: token,
		})
		assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	})

	t.Run("expired is unauthorized except idempotent revoke", func(t *testing.T) {
		t.Parallel()
		fixture := newAdminHTTPFixture(t)
		token, _, err := fixture.store.Create(reviewedIdentity(), validPodIdentity().UID)
		require.NoError(t, err)
		fixture.clock.Set(sessionEpoch.Add(10 * time.Minute))

		revoke := adminRequest(t, fixture.handler, http.MethodDelete, "/admin/session", http.NoBody, map[string]string{
			sessionHeader: token,
		})
		assert.Equal(t, http.StatusNoContent, revoke.Code)

		get := adminRequest(t, fixture.handler, http.MethodGet, "/admin/session", http.NoBody, map[string]string{
			sessionHeader: token,
		})
		assert.Equal(t, http.StatusUnauthorized, get.Code)
	})
}

func TestAdminHTTPProtectsUIAndConnectWithPrivateValidatedContext(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)

	for _, path := range []string{"/dashboard/", "/paprika.v1.PaprikaService/QueryFleetMap"} {
		without := adminRequest(t, fixture.handler, http.MethodGet, path, http.NoBody, nil)
		assert.Equal(t, http.StatusUnauthorized, without.Code)

		wrongToken := adminRequest(t, fixture.handler, http.MethodGet, path, http.NoBody, map[string]string{
			sessionHeader: "not-a-valid-session",
		})
		assert.Equal(t, http.StatusUnauthorized, wrongToken.Code)
	}

	session := exchangeAdminSession(t, fixture, "")
	for _, path := range []string{"/dashboard/", "/paprika.v1.PaprikaService/QueryFleetMap"} {
		recorder := adminRequest(t, fixture.handler, http.MethodGet, path, http.NoBody, map[string]string{
			"Authorization": "Bearer must-not-reach-handler",
			sessionHeader:   session.Token,
		})
		require.Equal(t, http.StatusNoContent, recorder.Code)
		observed := <-fixture.observed
		assert.Equal(t, path, observed.path)
		assert.Equal(t, "kubernetes:alice@example.com", observed.principalSubject)
		assert.Equal(t, "alice@example.com", observed.descriptionSubject)
		assert.Empty(t, observed.authorizationHeader)
		assert.Empty(t, observed.sessionHeader)
	}
}

func TestAdminHTTPProtectedRoutesRejectUnusableSessionStatesWithoutCallingHandler(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		token func(*testing.T, *adminHTTPFixture) string
	}{
		{
			name: "expired",
			token: func(t *testing.T, fixture *adminHTTPFixture) string {
				t.Helper()
				token, _, err := fixture.store.Create(
					reviewedIdentity(),
					validPodIdentity().UID,
				)
				require.NoError(t, err)
				fixture.clock.Set(sessionEpoch.Add(sessionIdleLifetime))
				return token
			},
		},
		{
			name: "wrong pod",
			token: func(t *testing.T, fixture *adminHTTPFixture) string {
				t.Helper()
				token, _, err := fixture.store.Create(
					reviewedIdentity(),
					types.UID("different-pod"),
				)
				require.NoError(t, err)
				return token
			},
		},
		{
			name: "old after rotation",
			token: func(t *testing.T, fixture *adminHTTPFixture) string {
				t.Helper()
				first := exchangeAdminSession(t, fixture, "")
				_ = exchangeAdminSession(t, fixture, first.Token)
				return first.Token
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newAdminHTTPFixture(t)
			token := test.token(t, fixture)

			for _, path := range []string{
				"/dashboard/",
				"/paprika.v1.PaprikaService/QueryFleetMap",
			} {
				recorder := adminRequest(
					t,
					fixture.handler,
					http.MethodGet,
					path,
					http.NoBody,
					map[string]string{sessionHeader: token},
				)
				assert.Equal(t, http.StatusUnauthorized, recorder.Code, path)
			}
			assert.Empty(t, fixture.observed, "protected handler was reached")
		})
	}
}

func TestAdminHTTPProtectedMutationsAuthenticateBeforeOriginValidation(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)

	for _, test := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/paprika.v1.PaprikaService/SyncApplication"},
		{method: http.MethodDelete, path: "/admin/session"},
	} {
		request := httptest.NewRequestWithContext(
			t.Context(),
			test.method,
			AdminListenerOrigin+test.path,
			http.NoBody,
		)
		request.Host = "127.0.0.1:3001"
		recorder := httptest.NewRecorder()
		fixture.handler.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	}

	session := exchangeAdminSession(t, fixture, "")
	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		AdminListenerOrigin+"/paprika.v1.PaprikaService/SyncApplication",
		http.NoBody,
	)
	request.Host = "127.0.0.1:3001"
	request.Header.Set(sessionHeader, session.Token)
	recorder := httptest.NewRecorder()
	fixture.handler.ServeHTTP(recorder, request)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
}

func TestAdminHTTPEventsIsAlwaysExactlyNotFound(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)
	session := exchangeAdminSession(t, fixture, "")

	for _, headers := range []map[string]string{
		nil,
		{sessionHeader: session.Token},
	} {
		recorder := adminRequest(t, fixture.handler, http.MethodGet, "/events", http.NoBody, headers)
		assert.Equal(t, http.StatusNotFound, recorder.Code)
	}

	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		"http://attacker.example/events",
		http.NoBody,
	)
	request.Host = "attacker.example"
	recorder := httptest.NewRecorder()
	fixture.handler.ServeHTTP(recorder, request)
	assert.Equal(t, http.StatusNotFound, recorder.Code)
}

func TestAdminHTTPEnforcesFixedHostAndMutationOrigin(t *testing.T) {
	t.Parallel()
	fixture := newAdminHTTPFixture(t)

	for _, host := range []string{"127.0.0.1:49152", "localhost:3001", "127.0.0.1:3001"} {
		request := httptest.NewRequestWithContext(
			t.Context(),
			http.MethodGet,
			"http://127.0.0.1:3001/dashboard/",
			http.NoBody,
		)
		request.Host = host
		if host == "127.0.0.1:3001" {
			request.Header.Set("X-Forwarded-Host", "attacker.example")
		}
		recorder := httptest.NewRecorder()
		fixture.handler.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusBadRequest, recorder.Code)
	}

	tests := []struct {
		name   string
		origin string
	}{
		{name: "missing"},
		{name: "foreign", origin: "http://127.0.0.1:49152"},
		{name: "HTTPS", origin: "https://127.0.0.1:3001"},
	}
	for _, test := range tests {
		request := httptest.NewRequestWithContext(
			t.Context(),
			http.MethodPost,
			AdminListenerOrigin+"/admin/session/exchange",
			http.NoBody,
		)
		request.Host = "127.0.0.1:3001"
		request.Header.Set("Authorization", "Bearer "+testKubernetesBearer)
		if test.origin != "" {
			request.Header.Set("Origin", test.origin)
		}
		recorder := httptest.NewRecorder()
		fixture.handler.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusForbidden, recorder.Code, test.name)
	}
}
