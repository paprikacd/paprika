package source

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func generateTestPrivateKey(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
}

func TestGitHubAppAuth_InstallationToken(t *testing.T) {
	t.Parallel()

	privateKey := generateTestPrivateKey(t)

	var receivedAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"token":"ghs_test_installation_token"}`)
	}))
	defer server.Close()

	auth := &GitHubAppAuth{
		AppID:          12345,
		InstallationID: 67890,
		PrivateKey:     privateKey,
		EnterpriseURL:  server.URL,
	}

	token, err := auth.InstallationToken(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "ghs_test_installation_token", token)
	assert.True(t, strings.HasPrefix(receivedAuth, "Bearer "))
	assert.True(t, len(receivedAuth) > len("Bearer "))
}

func TestGitHubAppAuth_MissingPrivateKey(t *testing.T) {
	t.Parallel()

	auth := &GitHubAppAuth{AppID: 1, InstallationID: 2}
	_, err := auth.InstallationToken(context.Background())
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "missing private key")
}

func TestGitHubAppAuth_GitHubError(t *testing.T) {
	t.Parallel()

	privateKey := generateTestPrivateKey(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, "bad credentials")
	}))
	defer server.Close()

	auth := &GitHubAppAuth{
		AppID:          12345,
		InstallationID: 67890,
		PrivateKey:     privateKey,
		EnterpriseURL:  server.URL,
	}

	_, err := auth.InstallationToken(context.Background())
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "401")
}

func TestGitHubAppAuth_EmptyToken(t *testing.T) {
	t.Parallel()

	privateKey := generateTestPrivateKey(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"token":""}`)
	}))
	defer server.Close()

	auth := &GitHubAppAuth{
		AppID:          12345,
		InstallationID: 67890,
		PrivateKey:     privateKey,
		EnterpriseURL:  server.URL,
	}

	_, err := auth.InstallationToken(context.Background())
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "empty installation token")
}
