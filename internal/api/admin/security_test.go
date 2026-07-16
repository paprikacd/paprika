package admin

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHostAcceptsOnlyCanonicalIPv4LoopbackWithPort(t *testing.T) {
	t.Parallel()

	for _, host := range []string{"127.0.0.1:1", "127.0.0.1:3001", "127.0.0.1:65535"} {
		host := host
		t.Run("accept "+host, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, "http://"+host+"/dashboard/", nil)
			request.Host = host
			require.NoError(t, ValidateLoopbackHost(request))
		})
	}

	for _, host := range []string{
		"",
		"localhost:3001",
		"[::1]:3001",
		"0.0.0.0:3001",
		"127.0.0.2:3001",
		"*:3001",
		"127.0.0.1",
		"127.0.0.1:0",
		"127.0.0.1:080",
		"127.0.0.1:+80",
		"127.0.0.1:65536",
		"user@127.0.0.1:3001",
		"127.0.0.1:3001/path",
		" 127.0.0.1:3001",
	} {
		host := host
		t.Run("reject "+host, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3001/", nil)
			request.Host = host
			require.ErrorIs(t, ValidateLoopbackHost(request), ErrInvalidLoopbackHost)
		})
	}
}

func TestHostRejectsForwardedAuthorityHeaders(t *testing.T) {
	t.Parallel()

	for _, header := range []string{
		"Forwarded",
		"X-Forwarded-Host",
		"X-Forwarded-For",
		"X-Forwarded-Proto",
		"X-Original-Host",
	} {
		header := header
		t.Run(header, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3001/", nil)
			request.Host = "127.0.0.1:3001"
			request.Header.Set(header, "attacker.example")
			require.ErrorIs(t, ValidateLoopbackHost(request), ErrInvalidLoopbackHost)
		})
	}
}

func TestOriginAcceptsSameOriginAndRewritesToCanonicalUpstream(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:49152/admin/session/exchange", nil)
	request.Host = "127.0.0.1:49152"
	request.Header.Set("Origin", "http://127.0.0.1:49152")

	require.NoError(t, ValidateAndRewriteMutationOrigin(
		request,
		"http://127.0.0.1:3001",
	))
	assert.Equal(t, "http://127.0.0.1:3001", request.Header.Get("Origin"))
}

func TestOriginRejectsMissingForeignMalformedOrAmbiguousValuesBeforeRewrite(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		origins []string
	}{
		{name: "missing"},
		{name: "null", origins: []string{"null"}},
		{name: "HTTPS", origins: []string{"https://127.0.0.1:49152"}},
		{name: "localhost", origins: []string{"http://localhost:49152"}},
		{name: "foreign port", origins: []string{"http://127.0.0.1:49153"}},
		{name: "foreign IP", origins: []string{"http://127.0.0.2:49152"}},
		{name: "userinfo", origins: []string{"http://user@127.0.0.1:49152"}},
		{name: "path", origins: []string{"http://127.0.0.1:49152/path"}},
		{name: "trailing slash", origins: []string{"http://127.0.0.1:49152/"}},
		{name: "malformed", origins: []string{"://"}},
		{name: "multiple", origins: []string{
			"http://127.0.0.1:49152",
			"http://127.0.0.1:49152",
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:49152/admin/session", nil)
			request.Host = "127.0.0.1:49152"
			for _, origin := range test.origins {
				request.Header.Add("Origin", origin)
			}

			require.ErrorIs(t, ValidateAndRewriteMutationOrigin(
				request,
				"http://127.0.0.1:3001",
			), ErrInvalidMutationOrigin)
			assert.NotEqual(t, "http://127.0.0.1:3001", request.Header.Get("Origin"))
		})
	}
}

func TestOriginRejectsInvalidHostForwardingAndUpstreamContract(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		mutate   func(*http.Request)
		upstream string
		want     error
	}{
		{
			name: "browser Host",
			mutate: func(request *http.Request) {
				request.Host = "localhost:49152"
			},
			upstream: "http://127.0.0.1:3001",
			want:     ErrInvalidLoopbackHost,
		},
		{
			name: "forwarded Host",
			mutate: func(request *http.Request) {
				request.Header.Set("X-Forwarded-Host", "attacker.example")
			},
			upstream: "http://127.0.0.1:3001",
			want:     ErrInvalidLoopbackHost,
		},
		{
			name:     "foreign upstream",
			mutate:   func(_ *http.Request) {},
			upstream: "http://10.0.0.1:3001",
			want:     ErrInvalidMutationOrigin,
		},
		{
			name:     "upstream path",
			mutate:   func(_ *http.Request) {},
			upstream: "http://127.0.0.1:3001/dashboard",
			want:     ErrInvalidMutationOrigin,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:49152/admin/session", nil)
			request.Host = "127.0.0.1:49152"
			request.Header.Set("Origin", "http://127.0.0.1:49152")
			test.mutate(request)

			require.ErrorIs(t, ValidateAndRewriteMutationOrigin(request, test.upstream), test.want)
		})
	}
}
