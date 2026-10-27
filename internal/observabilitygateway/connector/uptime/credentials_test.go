package uptime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

type tokenRoundTrip func(*http.Request) (*http.Response, error)

func (f tokenRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func tokenTestClient(t *testing.T, server *httptest.Server) *http.Client {
	t.Helper()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: tokenRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Scheme != "https" || request.URL.Host != "securetoken.googleapis.com" || request.URL.Path != "/v1/token" {
			t.Error("refresh endpoint is not pinned")
		}
		copyRequest := request.Clone(request.Context())
		copyURL := *request.URL
		copyURL.Scheme, copyURL.Host = endpoint.Scheme, endpoint.Host
		copyRequest.URL = &copyURL
		return http.DefaultTransport.RoundTrip(copyRequest)
	})}
}

func TestFirebaseRefreshUsesFixedEndpointAndFreshRequestToken(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Error("invalid Firebase refresh method")
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("refresh call must not forward provider authorization")
		}
		if r.URL.Query().Get("key") != "test-api-key" {
			t.Error("missing Firebase API key")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.PostForm.Get("grant_type") != "refresh_token" || r.PostForm.Get("refresh_token") != "test-refresh-token" || len(r.PostForm) != 2 {
			t.Error("invalid Firebase refresh body")
		}
		writeJSON(t, w, `{"id_token":"fresh-id-token","refresh_token":"rotated-private-value","expires_in":"3600"}`)
	}))
	defer server.Close()
	client := tokenTestClient(t, server)
	for range 2 {
		token, err := bearerCredential(context.Background(), []byte(`{"apiKey":"test-api-key","refreshToken":"test-refresh-token"}`), client)
		if err != nil || token != "fresh-id-token" {
			t.Fatalf("refresh failed: %v", err)
		}
	}
	if calls.Load() != 2 {
		t.Error("refresh token state leaked between requests")
	}
	token, err := bearerCredential(context.Background(), []byte("existing-bearer"), client)
	if err != nil || token != "existing-bearer" || calls.Load() != 2 {
		t.Error("raw bearer support changed")
	}
}

func TestFirebaseRefreshRejectsCredentialOverridesAndSanitizesErrors(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: tokenRoundTrip(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("private-token-in-transport-error")
	})}
	for _, raw := range []string{
		`{"apiKey":"key","refreshToken":"token","endpoint":"https://attacker.invalid"}`,
		`{"apiKey":"key","apiKey":"other","refreshToken":"token"}`,
		`{"apiKey":"key","refreshToken":"token"}{}`,
		`{"apiKey":"key"}`, `{"apiKey":"key","refreshToken":"bad\nheader"}`,
	} {
		if _, err := bearerCredential(context.Background(), []byte(raw), client); !errors.Is(err, connector.ErrForbidden) {
			t.Errorf("invalid credential accepted: %v", err)
		}
	}
	if calls.Load() != 0 {
		t.Error("invalid credential made a request")
	}
	_, err := bearerCredential(context.Background(), []byte(`{"apiKey":"key","refreshToken":"token"}`), client)
	if err == nil || strings.Contains(err.Error(), "private-token") {
		t.Error("transport error leaked")
	}
}

func TestFirebaseRefreshDoesNotRedirectAndBoundsResponse(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		forwarded.Add(1)
		writeJSON(t, w, `{"id_token":"must-not-read"}`)
	}))
	defer target.Close()
	for _, test := range []struct {
		name      string
		status    int
		body      string
		forbidden bool
	}{
		{"redirect", http.StatusTemporaryRedirect, "", false},
		{"revoked", http.StatusBadRequest, `{"error":{"message":"private-token"}}`, true},
		{"oversized", http.StatusOK, `{"id_token":"` + strings.Repeat("x", 33<<10) + `"}`, false},
		{"malformed", http.StatusOK, `{"id_token":"bad\nheader"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(test.status)
				writeJSON(t, w, test.body)
			}))
			defer server.Close()
			_, err := bearerCredential(context.Background(), []byte(`{"apiKey":"key","refreshToken":"token"}`), tokenTestClient(t, server))
			if err == nil || strings.Contains(err.Error(), "private-token") {
				t.Error("invalid refresh accepted or leaked")
			}
			if test.forbidden && !errors.Is(err, connector.ErrForbidden) {
				t.Error("revoked refresh should be Forbidden")
			}
		})
	}
	if forwarded.Load() != 0 {
		t.Fatal("Firebase refresh redirect followed")
	}
}

func TestFirebaseRefreshHonorsCallerDeadline(t *testing.T) {
	client := &http.Client{Transport: tokenRoundTrip(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := bearerCredential(ctx, []byte(`{"apiKey":"key","refreshToken":"token"}`), client)
	if err == nil || time.Since(start) > time.Second {
		t.Error("refresh did not honor parent deadline")
	}
}
