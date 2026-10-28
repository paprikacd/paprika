package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFixtureAuthorizationUsesExactCallback(t *testing.T) {
	const callback = "http://127.0.0.1:3015/auth/callback"
	for _, redirect := range []string{
		"http://127.0.0.1:3016/auth/callback",
		"http://127.0.0.1:3015/other",
		callback + "?extra=true",
		callback + "#fragment",
		"http://user@127.0.0.1:3015/auth/callback",
		"http://localhost:3015/auth/callback",
		"https://example.com/auth/callback",
		"%invalid",
	} {
		t.Run(redirect, func(t *testing.T) {
			f := &fixture{redirectURI: callback, codes: make(map[string]authorization)}
			query := url.Values{"redirect_uri": {redirect}, "client_id": {clientID}, "code_challenge_method": {"S256"}}
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/authorize?"+query.Encode(), http.NoBody)
			response := httptest.NewRecorder()
			f.authorizeRequest(response, request)
			assert.Equal(t, http.StatusBadRequest, response.Code)
			assert.Empty(t, response.Header().Get("Location"))
			assert.Empty(t, f.codes)
		})
	}

	f := &fixture{redirectURI: callback, codes: make(map[string]authorization)}
	query := url.Values{
		"redirect_uri": {callback}, "client_id": {clientID}, "code_challenge_method": {"S256"},
		"code_challenge": {"challenge"}, "state": {"state & with / delimiters"},
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/authorize?"+query.Encode(), http.NoBody)
	response := httptest.NewRecorder()
	f.authorizeRequest(response, request)
	require.Equal(t, http.StatusFound, response.Code)
	location, err := url.Parse(response.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, query.Get("state"), location.Query().Get("state"))
	code := location.Query().Get("code")
	require.NotEmpty(t, code)
	assert.Equal(t, authorization{challenge: "challenge", redirect: callback}, f.codes[code])
	location.RawQuery = ""
	assert.Equal(t, callback, location.String())
}
