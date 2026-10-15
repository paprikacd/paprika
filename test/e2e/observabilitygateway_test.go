//go:build e2e
// +build e2e

/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package e2e

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

const (
	obsNamespace = "paprika-obs-system"
	obsRelease   = "paprika-obs"
	obsPort      = 4003
	obsClientID  = "e2e-observe"
)

var obsPortForwardCmd *exec.Cmd

func obsURL(path string) string {
	return fmt.Sprintf("http://localhost:%d%s", obsPort, path)
}

// obsRPC performs a JSON-RPC call against the observability gateway's MCP
// endpoint and returns the decoded response body.
func obsRPC(token, method string, params map[string]interface{}) (int, map[string]interface{}) {
	body, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	Expect(err).NotTo(HaveOccurred())

	req, err := http.NewRequest(http.MethodPost, obsURL("/observe/mcp"), strings.NewReader(string(body)))
	Expect(err).NotTo(HaveOccurred())
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	Expect(err).NotTo(HaveOccurred())
	defer resp.Body.Close()

	var decoded map[string]interface{}
	raw, err := io.ReadAll(resp.Body)
	Expect(err).NotTo(HaveOccurred())
	if len(raw) > 0 {
		// Error responses (e.g. 401) may be non-JSON; decode only when it parses.
		_ = json.Unmarshal(raw, &decoded)
	}
	return resp.StatusCode, decoded
}

// obsConsent posts a consent decision for the given scopes and returns the
// status code, the redirectTo value, and the PKCE verifier used.
func obsConsent(scopes []string) (int, string, string) {
	verifierBytes := make([]byte, 48)
	_, err := rand.Read(verifierBytes)
	Expect(err).NotTo(HaveOccurred())
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	challenge := base64.RawURLEncoding.EncodeToString(sha256Sum(verifier))

	redirectURI := "http://localhost:8791/callback"
	consentBody, err := json.Marshal(map[string]interface{}{
		"client_id":             obsClientID,
		"redirect_uri":          redirectURI,
		"code_challenge":        challenge,
		"code_challenge_method": "S256",
		"state":                 "e2e-state",
		"scopes":                scopes,
		"decision":              "approve",
	})
	Expect(err).NotTo(HaveOccurred())

	req, err := http.NewRequest(http.MethodPost, obsURL("/observe/authorize/consent"),
		strings.NewReader(string(consentBody)))
	Expect(err).NotTo(HaveOccurred())
	req.SetBasicAuth("admin", "admin123")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	Expect(err).NotTo(HaveOccurred())
	defer resp.Body.Close()

	var consent struct {
		RedirectTo string `json:"redirectTo"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&consent)
	return resp.StatusCode, consent.RedirectTo, verifier
}

// mintObservabilityToken drives the full OAuth 2.1 + PKCE flow against the
// observability gateway: consent approve (basic auth) -> authorization code
// -> token scoped to paprika:observe.
func mintObservabilityToken() string {
	code, redirectTo, verifier := obsConsent([]string{"paprika:observe"})
	Expect(code).To(Equal(http.StatusOK),
		"consent approve should succeed with basic auth and the paprika:observe scope")
	Expect(redirectTo).To(ContainSubstring("code="))

	parsed, err := url.Parse(redirectTo)
	Expect(err).NotTo(HaveOccurred())
	codeValue := parsed.Query().Get("code")
	Expect(codeValue).NotTo(BeEmpty())
	Expect(parsed.Query().Get("state")).To(Equal("e2e-state"))

	tokenResp, err := http.PostForm(obsURL("/observe/token"), url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {codeValue},
		"code_verifier": {verifier},
		"client_id":     {obsClientID},
		"redirect_uri":  {"http://localhost:8791/callback"},
	})
	Expect(err).NotTo(HaveOccurred())
	defer tokenResp.Body.Close()
	Expect(tokenResp.StatusCode).To(Equal(http.StatusOK),
		"token exchange should succeed")

	var token struct {
		AccessToken string `json:"access_token"`
	}
	Expect(json.NewDecoder(tokenResp.Body).Decode(&token)).To(Succeed())
	Expect(token.AccessToken).NotTo(BeEmpty())
	return token.AccessToken
}

var _ = Describe("Observability Gateway", Ordered, func() {
	var obsAccessToken string

	BeforeAll(func() {
		By("writing the observability-gateway values file")
		valuesYAML := fmt.Sprintf(`
mode: api
deploymentMode: split
manager:
  enabled: false
webhookReceiver:
  enabled: false
repoServer:
  enabled: false
redis:
  enabled: false
metrics:
  enable: false
crd:
  enable: false
# This is an api-only release in a non-control-plane namespace: the default
# Global-scoped DataProviderBinding is only admitted in the operator namespace,
# and no manager runs here to serve it anyway.
capacity:
  defaultProvider:
    enabled: false
  metricsServer:
    enabled: false
apiServer:
  automountServiceAccountToken: true
  image:
    repository: %s
    tag: %s
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      value: "e2e-obs-token-secret"
observabilityGateway:
  enabled: true
  image:
    repository: %s
    tag: %s
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      value: "e2e-obs-token-secret"
  replicas: 1
auth:
  enabled: true
  basic:
    enabled: true
    username: "admin"
    passwordHash: "%s"
  rbac:
    - subjects: ["*"]
      actions: ["*"]
      resources: ["*"]
      namespaces: ["*"]
mcp:
  enabled: true
  oauth:
    clientId: "%s"
    redirectUris:
      - "http://localhost:8791/callback"
  publicURL: "http://localhost:%d"
`, strings.Split(managerImage, ":")[0], strings.Split(managerImage, ":")[1],
			strings.Split(managerImage, ":")[0], strings.Split(managerImage, ":")[1],
			mcpBasicPasswordHash, obsClientID, obsPort)
		tmp, err := os.CreateTemp("", "paprika-obs-values-*.yaml")
		Expect(err).NotTo(HaveOccurred())
		valuesFile := tmp.Name()
		Expect(tmp.Close()).To(Succeed())
		Expect(os.WriteFile(valuesFile, []byte(valuesYAML), 0o600)).To(Succeed())

		By("deploying the observability-gateway release via Helm")
		cmd := exec.Command("helm", "upgrade", "--install", obsRelease, "./charts/chart",
			"--namespace", obsNamespace,
			"--create-namespace",
			"-f", valuesFile,
			"--wait",
			"--timeout", "3m",
		)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to deploy observability-gateway via Helm")

		By("granting the release service account observability read access")
		saName := obsRelease + "-controller-manager"
		rbacYAML := fmt.Sprintf(`---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paprika-obs-read
rules:
- apiGroups: ["observability.paprika.io"]
  resources: ["observabilityproviders"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: paprika-obs-read
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: paprika-obs-read
subjects:
- kind: ServiceAccount
  name: %s
  namespace: %s
`, saName, obsNamespace)
		_, err = utils.ApplyManifest(rbacYAML)
		Expect(err).NotTo(HaveOccurred(), "Failed to create observability read RBAC")

		By("starting port-forward for the observability-gateway")
		getDeploy := exec.Command("kubectl", "get", "deployment", "-n", obsNamespace,
			"-l", "app.kubernetes.io/component=observability-gateway", "-o", "name")
		deployName, err := utils.Run(getDeploy)
		Expect(err).NotTo(HaveOccurred(), "Failed to get observability-gateway deployment name")
		pfCmd := exec.Command("kubectl", "port-forward", "-n", obsNamespace,
			strings.TrimSpace(deployName), fmt.Sprintf("%d:8090", obsPort))
		Expect(pfCmd.Start()).To(Succeed(), "Failed to start port-forward for observability-gateway")
		obsPortForwardCmd = pfCmd

		By("waiting for the observability-gateway to be reachable")
		Eventually(func(g Gomega) {
			resp, err := http.Get(obsURL("/healthz"))
			g.Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
		}, 60*time.Second, 2*time.Second).Should(Succeed())
	})

	AfterAll(func() {
		By("stopping port-forward for the observability-gateway")
		if obsPortForwardCmd != nil && obsPortForwardCmd.Process != nil {
			_ = obsPortForwardCmd.Process.Signal(syscall.SIGTERM)
			_, _ = obsPortForwardCmd.Process.Wait()
		}

		By("deleting the observability read RBAC")
		_ = utils.DeleteNamed(utils.ManifestID{Kind: "ClusterRoleBinding", Name: "paprika-obs-read"})
		_ = utils.DeleteNamed(utils.ManifestID{Kind: "ClusterRole", Name: "paprika-obs-read"})

		By("uninstalling the observability-gateway Helm release")
		_, _ = utils.Run(exec.Command("helm", "uninstall", obsRelease, "--namespace", obsNamespace))

		By("removing observability-gateway namespace")
		_, _ = utils.Kubectl("delete", "ns", obsNamespace, "--ignore-not-found")
	})

	It("should serve observability OAuth discovery metadata", func() {
		By("checking protected-resource metadata")
		resp, err := http.Get(obsURL("/observe/.well-known/oauth-protected-resource"))
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()
		Expect(resp.StatusCode).To(Equal(http.StatusOK))

		var protected struct {
			Resource        string   `json:"resource"`
			ScopesSupported []string `json:"scopes_supported"`
		}
		Expect(json.NewDecoder(resp.Body).Decode(&protected)).To(Succeed())
		Expect(protected.Resource).To(Equal(fmt.Sprintf("http://localhost:%d/observe/mcp", obsPort)))
		Expect(protected.ScopesSupported).To(Equal([]string{"paprika:observe"}))

		By("checking authorization-server metadata")
		resp, err = http.Get(obsURL("/observe/.well-known/oauth-authorization-server"))
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()
		Expect(resp.StatusCode).To(Equal(http.StatusOK))

		var meta struct {
			AuthorizationEndpoint string `json:"authorization_endpoint"`
			TokenEndpoint         string `json:"token_endpoint"`
			RegistrationEndpoint  string `json:"registration_endpoint"`
		}
		Expect(json.NewDecoder(resp.Body).Decode(&meta)).To(Succeed())
		Expect(meta.AuthorizationEndpoint).To(ContainSubstring("/observe/"))
		Expect(meta.TokenEndpoint).To(ContainSubstring("/observe/"))
		Expect(meta.RegistrationEndpoint).To(ContainSubstring("/observe/"))
	})

	It("should challenge unauthenticated MCP calls with the observability resource metadata", func() {
		body, err := json.Marshal(map[string]interface{}{
			"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": map[string]interface{}{},
		})
		Expect(err).NotTo(HaveOccurred())

		req, err := http.NewRequest(http.MethodPost, obsURL("/observe/mcp"), strings.NewReader(string(body)))
		Expect(err).NotTo(HaveOccurred())
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()

		Expect(resp.StatusCode).To(Equal(http.StatusUnauthorized))
		Expect(resp.Header.Get("WWW-Authenticate")).To(ContainSubstring(
			fmt.Sprintf(`resource_metadata="http://localhost:%d/observe/.well-known/oauth-protected-resource"`, obsPort)))
	})

	It("should isolate scopes at consent and mint an observability token", func() {
		By("requesting a fleet scope — the gateway must refuse")
		code, _, _ := obsConsent([]string{"paprika:read"})
		Expect(code).To(Equal(http.StatusBadRequest))

		By("approving the paprika:observe scope and exchanging the code")
		obsAccessToken = mintObservabilityToken()
		Expect(obsAccessToken).NotTo(BeEmpty())
	})

	It("should list exactly the five observability tools", func() {
		Expect(obsAccessToken).NotTo(BeEmpty(), "token must be minted by the prior spec")
		code, body := obsRPC(obsAccessToken, "tools/list", map[string]interface{}{})
		Expect(code).To(Equal(http.StatusOK))

		result, ok := body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue(), "tools/list should return a result object")
		tools, ok := result["tools"].([]interface{})
		Expect(ok).To(BeTrue())

		names := make(map[string]bool, len(tools))
		for _, t := range tools {
			if tm, ok := t.(map[string]interface{}); ok {
				if name, ok := tm["name"].(string); ok {
					names[name] = true
				}
			}
		}
		Expect(names).To(HaveLen(8), "the gateway should expose exactly the observability tools")
		for _, want := range []string{
			"list_observability_providers", "get_observability_provider",
			"query_logs", "query_metrics", "query_traces",
			"list_provider_types", "describe_provider_type", "validate_provider",
		} {
			Expect(names).To(HaveKey(want), "expected observability tool %q to be registered", want)
		}
		for _, fleet := range []string{"fleet_status", "sync_application"} {
			Expect(names).NotTo(HaveKey(fleet), "fleet tool %q must not leak onto the observability surface", fleet)
		}
	})

	It("should answer list_observability_providers with a tool result", func() {
		Expect(obsAccessToken).NotTo(BeEmpty())
		code, body := obsRPC(obsAccessToken, "tools/call", map[string]interface{}{
			"name":      "list_observability_providers",
			"arguments": map[string]interface{}{},
		})
		Expect(code).To(Equal(http.StatusOK))
		Expect(body).NotTo(HaveKey("error"), "list_observability_providers returned an error: %v", body["error"])

		result, ok := body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue())
		Expect(result["isError"]).NotTo(Equal(true))
		content, ok := result["content"].([]interface{})
		Expect(ok).To(BeTrue(), "list_observability_providers should return a content array")
		Expect(content).NotTo(BeEmpty())
	})

	It("should resolve a provider CR and return a sanitized tool result on connector failure", func() {
		By("applying an ObservabilityProvider with a connection-refusing endpoint")
		providerYAML := fmt.Sprintf(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: e2e-prometheus
  namespace: %s
spec:
  type: prometheus
  config:
    endpoint: "http://127.0.0.1:9"
`, obsNamespace)
		_, err := utils.ApplyManifest(providerYAML)
		Expect(err).NotTo(HaveOccurred(), "Failed to apply ObservabilityProvider CR")

		code, body := obsRPC(obsAccessToken, "tools/call", map[string]interface{}{
			"name": "query_metrics",
			"arguments": map[string]interface{}{
				"provider": fmt.Sprintf("%s/e2e-prometheus", obsNamespace),
				"query":    "up",
			},
		})
		Expect(code).To(Equal(http.StatusOK))
		Expect(body).NotTo(HaveKey("error"),
			"connector failures must be tool results, not JSON-RPC protocol errors")

		result, ok := body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue())
		Expect(result["isError"]).NotTo(Equal(true),
			"a sanitized connector failure should still be a successful tool result")

		state, reason := obsToolResultState(result)
		Expect(state).To(Equal("Error"), "connector failure should surface as state Error")
		Expect(reason).NotTo(BeEmpty(), "connector failure should carry a fixed-sentence reason")
		Expect(reason).NotTo(ContainSubstring("127.0.0.1"),
			"the reason must be sanitized and must not leak the provider endpoint")
	})

	It("should reject forged bearer tokens", func() {
		code, _ := obsRPC("not-a-token", "tools/call", map[string]interface{}{
			"name":      "query_metrics",
			"arguments": map[string]interface{}{},
		})
		Expect(code).To(Equal(http.StatusUnauthorized))
	})

	It("should query a mock provider for every signal with deterministic data", func() {
		By("applying a mock ObservabilityProvider")
		providerYAML := fmt.Sprintf(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: e2e-mock
  namespace: %s
spec:
  type: mock
  config:
    series: 4
    pointsPerSeries: 8
    logEntries: 12
    traces: 3
    seed: 42
`, obsNamespace)
		_, err := utils.ApplyManifest(providerYAML)
		Expect(err).NotTo(HaveOccurred(), "Failed to apply mock ObservabilityProvider CR")

		provider := fmt.Sprintf("%s/e2e-mock", obsNamespace)

		By("querying metrics twice and checking determinism")
		var firstData string
		for attempt := 0; attempt < 2; attempt++ {
			code, body := obsRPC(obsAccessToken, "tools/call", map[string]interface{}{
				"name": "query_metrics",
				"arguments": map[string]interface{}{
					"provider": provider,
					"query":    `mock_metric{job="e2e"}`,
				},
			})
			Expect(code).To(Equal(http.StatusOK))
			Expect(body).NotTo(HaveKey("error"), "query_metrics returned an error: %v", body["error"])
			result, ok := body["result"].(map[string]interface{})
			Expect(ok).To(BeTrue())
			state, _ := obsToolResultState(result)
			Expect(state).To(Equal("OK"), "mock metrics query should answer OK")
			data := obsToolResultData(result)
			Expect(data).NotTo(BeEmpty(), "mock metrics query should carry synthetic data")
			if attempt == 0 {
				firstData = data
			} else {
				Expect(data).To(Equal(firstData), "identical mock queries must return identical data")
			}
		}

		By("querying logs")
		code, body := obsRPC(obsAccessToken, "tools/call", map[string]interface{}{
			"name": "query_logs",
			"arguments": map[string]interface{}{
				"provider": provider,
				"query":    `{app="mock"}`,
			},
		})
		Expect(code).To(Equal(http.StatusOK))
		result, ok := body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue())
		state, _ := obsToolResultState(result)
		Expect(state).To(Equal("OK"), "mock logs query should answer OK")
		Expect(obsToolResultData(result)).NotTo(BeEmpty())

		By("querying traces")
		code, body = obsRPC(obsAccessToken, "tools/call", map[string]interface{}{
			"name": "query_traces",
			"arguments": map[string]interface{}{
				"provider": provider,
				"query":    `{.service.name="mock"}`,
			},
		})
		Expect(code).To(Equal(http.StatusOK))
		result, ok = body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue())
		state, _ = obsToolResultState(result)
		Expect(state).To(Equal("OK"), "mock traces query should answer OK")
		Expect(obsToolResultData(result)).NotTo(BeEmpty())
	})
})

// obsToolResultState extracts the state/reason pair from an observability
// tool result, preferring structuredContent and falling back to the JSON
// text block.
func obsToolResultState(result map[string]interface{}) (string, string) {
	if sc, ok := result["structuredContent"].(map[string]interface{}); ok {
		state, _ := sc["state"].(string)
		reason, _ := sc["reason"].(string)
		return state, reason
	}
	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		return "", ""
	}
	first, ok := content[0].(map[string]interface{})
	if !ok {
		return "", ""
	}
	text, ok := first["text"].(string)
	if !ok {
		return "", ""
	}
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return "", ""
	}
	state, _ := payload["state"].(string)
	reason, _ := payload["reason"].(string)
	return state, reason
}

// obsToolResultData renders the backend data payload of an observability
// tool result as compact JSON, preferring structuredContent and falling
// back to the JSON text block. A missing payload renders as "".
func obsToolResultData(result map[string]interface{}) string {
	if sc, ok := result["structuredContent"].(map[string]interface{}); ok {
		if data, ok := sc["data"]; ok && data != nil {
			return renderJSONValue(data)
		}
	}
	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		return ""
	}
	first, ok := content[0].(map[string]interface{})
	if !ok {
		return ""
	}
	text, ok := first["text"].(string)
	if !ok {
		return ""
	}
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return ""
	}
	data, ok := payload["data"]
	if !ok || data == nil {
		return ""
	}
	return renderJSONValue(data)
}

// renderJSONValue stringifies a decoded JSON value: strings pass through,
// anything else re-marshals compactly so object payloads compare by content.
func renderJSONValue(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	encoded, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(encoded)
}
