package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
	"k8s.io/client-go/rest"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestGKEExecCredential(t *testing.T) {
	expiry := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	for _, version := range []string{"client.authentication.k8s.io/v1", "client.authentication.k8s.io/v1beta1"} {
		t.Run(version, func(t *testing.T) {
			var out bytes.Buffer
			info := `{"kind":"ExecCredential","apiVersion":"` + version + `"}`
			err := runGKEExecCredential(context.Background(), info, &out, func(context.Context) (*oauth2.Token, error) {
				return &oauth2.Token{AccessToken: "test-token", Expiry: expiry}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				APIVersion string `json:"apiVersion"`
				Kind       string `json:"kind"`
				Status     struct {
					Token  string    `json:"token"`
					Expiry time.Time `json:"expirationTimestamp"`
				} `json:"status"`
			}
			if err := json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.APIVersion != version || result.Kind != "ExecCredential" || result.Status.Token != "test-token" || !result.Status.Expiry.Equal(expiry) {
				t.Fatalf("unexpected credential response: %+v", result)
			}
		})
	}
}

func TestGKEExecCredentialClientGo(t *testing.T) {
	if os.Getenv("PAPRIKA_GKE_TEST_HELPER") == "1" {
		err := runGKEExecCredential(context.Background(), os.Getenv("KUBERNETES_EXEC_INFO"), os.Stdout, func(context.Context) (*oauth2.Token, error) {
			return &oauth2.Token{AccessToken: "test-token", Expiry: time.Now().Add(time.Hour)}, nil
		})
		if err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("unexpected authorization header %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	cfg := &rest.Config{Host: server.URL, TLSClientConfig: rest.TLSClientConfig{CAData: ca}, ExecProvider: &clientcmdapi.ExecConfig{
		APIVersion: "client.authentication.k8s.io/v1", Command: os.Args[0], Args: []string{"-test.run=^TestGKEExecCredentialClientGo$"},
		Env: []clientcmdapi.ExecEnvVar{{Name: "PAPRIKA_GKE_TEST_HELPER", Value: "1"}}, InteractiveMode: clientcmdapi.NeverExecInteractiveMode,
	}}
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected status %s", response.Status)
	}
}

func TestGKEExecCredentialRejectsInvalidRequestsAndTokens(t *testing.T) {
	valid := `{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1"}`
	for _, tc := range []struct {
		name, info string
		token      *oauth2.Token
		err        error
	}{
		{name: "bad request", info: `{`, token: &oauth2.Token{AccessToken: "x", Expiry: time.Now().Add(time.Hour)}},
		{name: "wrong kind", info: `{"kind":"Other","apiVersion":"client.authentication.k8s.io/v1"}`},
		{name: "wrong version", info: `{"kind":"ExecCredential","apiVersion":"v1"}`},
		{name: "missing expiry", info: valid, token: &oauth2.Token{AccessToken: "x"}},
		{name: "expired", info: valid, token: &oauth2.Token{AccessToken: "x", Expiry: time.Now().Add(-time.Minute)}},
		{name: "provider error", info: valid, err: errors.New("sensitive provider detail")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := runGKEExecCredential(context.Background(), tc.info, &out, func(context.Context) (*oauth2.Token, error) { return tc.token, tc.err })
			if err == nil || out.Len() != 0 || strings.Contains(err.Error(), "sensitive provider detail") {
				t.Fatalf("expected sanitized failure, got %q and output %q", err, out.String())
			}
		})
	}
}
