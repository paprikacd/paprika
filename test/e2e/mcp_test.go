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
	"crypto/sha256"
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
	mcpNamespace = "paprika-mcp-system"
	mcpRelease   = "paprika-mcp"
	mcpPort      = 4002
	mcpClientID  = "e2e-mcp"
	// bcrypt hash of "admin123" — same credential as deploy/test-values.yaml.
	mcpBasicPasswordHash = "$2a$10$gokrR1H67p0nl/1Q2k1qk.i9u4iJNm8Iy1PUBR9ScjdhlznxnAKq6"
)

var mcpPortForwardCmd *exec.Cmd

func mcpURL(path string) string {
	return fmt.Sprintf("http://localhost:%d%s", mcpPort, path)
}

// mcpRPC performs a JSON-RPC call against the MCP endpoint and returns the
// decoded response body.
func mcpRPC(token, method string, params map[string]interface{}) (int, map[string]interface{}) {
	body, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	Expect(err).NotTo(HaveOccurred())

	req, err := http.NewRequest(http.MethodPost, mcpURL("/mcp"), strings.NewReader(string(body)))
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

// mintMCPToken drives the full OAuth 2.1 + PKCE flow against the local API
// server: consent approve (basic auth) -> authorization code -> token.
func mintMCPToken() string {
	verifierBytes := make([]byte, 48)
	_, err := rand.Read(verifierBytes)
	Expect(err).NotTo(HaveOccurred())
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	challenge := base64.RawURLEncoding.EncodeToString(sha256Sum(verifier))

	redirectURI := "http://localhost:8791/callback"
	consentBody, err := json.Marshal(map[string]interface{}{
		"client_id":             mcpClientID,
		"redirect_uri":          redirectURI,
		"code_challenge":        challenge,
		"code_challenge_method": "S256",
		"state":                 "e2e-state",
		"scopes":                []string{"paprika:read", "paprika:write"},
		"decision":              "approve",
	})
	Expect(err).NotTo(HaveOccurred())

	req, err := http.NewRequest(http.MethodPost, mcpURL("/mcp/authorize/consent"),
		strings.NewReader(string(consentBody)))
	Expect(err).NotTo(HaveOccurred())
	req.SetBasicAuth("admin", "admin123")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	Expect(err).NotTo(HaveOccurred())
	defer resp.Body.Close()
	Expect(resp.StatusCode).To(Equal(http.StatusOK),
		"consent approve should succeed with basic auth")

	var consent struct {
		RedirectTo string `json:"redirectTo"`
	}
	Expect(json.NewDecoder(resp.Body).Decode(&consent)).To(Succeed())
	Expect(consent.RedirectTo).To(ContainSubstring("code="))

	parsed, err := url.Parse(consent.RedirectTo)
	Expect(err).NotTo(HaveOccurred())
	code := parsed.Query().Get("code")
	Expect(code).NotTo(BeEmpty())
	Expect(parsed.Query().Get("state")).To(Equal("e2e-state"))

	tokenResp, err := http.PostForm(mcpURL("/mcp/token"), url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"client_id":     {mcpClientID},
		"redirect_uri":  {redirectURI},
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

func sha256Sum(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

var _ = Describe("MCP", Ordered, func() {
	var accessToken string

	BeforeAll(func() {
		By("writing the MCP-enabled api-server values file")
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
      value: "e2e-mcp-token-secret"
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
			mcpBasicPasswordHash, mcpClientID, mcpPort)
		tmp, err := os.CreateTemp("", "paprika-mcp-values-*.yaml")
		Expect(err).NotTo(HaveOccurred())
		valuesFile := tmp.Name()
		Expect(tmp.Close()).To(Succeed())
		Expect(os.WriteFile(valuesFile, []byte(valuesYAML), 0o600)).To(Succeed())

		By("deploying the MCP-enabled api-mode release via Helm")
		cmd := exec.Command("helm", "upgrade", "--install", mcpRelease, "./charts/chart",
			"--namespace", mcpNamespace,
			"--create-namespace",
			"-f", valuesFile,
			"--wait",
			"--timeout", "3m",
		)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to deploy MCP api-mode via Helm")

		By("granting the api service account read access for MCP tools")
		saName := mcpRelease + "-controller-manager"
		rbacYAML := fmt.Sprintf(`---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paprika-mcp-read
rules:
- apiGroups: ["pipelines.paprika.io"]
  resources: ["pipelines", "applications", "releases", "stages", "templates"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["clusters.paprika.io"]
  resources: ["clusters"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["namespaces", "pods", "nodes"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: paprika-mcp-read
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: paprika-mcp-read
subjects:
- kind: ServiceAccount
  name: %s
  namespace: %s
`, saName, mcpNamespace)
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(rbacYAML)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create MCP read RBAC")

		By("starting port-forward for the MCP api server")
		getDeploy := exec.Command("kubectl", "get", "deployment", "-n", mcpNamespace,
			"-l", "app.kubernetes.io/component=api-server", "-o", "name")
		deployName, err := utils.Run(getDeploy)
		Expect(err).NotTo(HaveOccurred(), "Failed to get api deployment name")
		pfCmd := exec.Command("kubectl", "port-forward", "-n", mcpNamespace,
			strings.TrimSpace(deployName), fmt.Sprintf("%d:3000", mcpPort))
		Expect(pfCmd.Start()).To(Succeed(), "Failed to start port-forward for MCP api server")
		mcpPortForwardCmd = pfCmd

		By("waiting for the api server to be reachable")
		Eventually(func(g Gomega) {
			resp, err := http.Get(mcpURL("/healthz"))
			g.Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
		}, 60*time.Second, 2*time.Second).Should(Succeed())
	})

	AfterAll(func() {
		By("stopping port-forward for the MCP api server")
		if mcpPortForwardCmd != nil && mcpPortForwardCmd.Process != nil {
			_ = mcpPortForwardCmd.Process.Signal(syscall.SIGTERM)
			_, _ = mcpPortForwardCmd.Process.Wait()
		}

		By("deleting the MCP RBAC")
		cmd := exec.Command("kubectl", "delete", "clusterrolebinding", "paprika-mcp-read", "--ignore-not-found")
		_, _ = utils.Run(cmd)
		cmd = exec.Command("kubectl", "delete", "clusterrole", "paprika-mcp-read", "--ignore-not-found")
		_, _ = utils.Run(cmd)

		By("uninstalling the MCP api-mode Helm release")
		cmd = exec.Command("helm", "uninstall", mcpRelease, "--namespace", mcpNamespace)
		_, _ = utils.Run(cmd)

		By("removing MCP namespace")
		cmd = exec.Command("kubectl", "delete", "ns", mcpNamespace, "--ignore-not-found")
		_, _ = utils.Run(cmd)
	})

	It("should serve OAuth discovery metadata", func() {
		resp, err := http.Get(mcpURL("/.well-known/oauth-authorization-server"))
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()
		Expect(resp.StatusCode).To(Equal(http.StatusOK))

		var meta struct {
			Issuer                string `json:"issuer"`
			AuthorizationEndpoint string `json:"authorization_endpoint"`
			TokenEndpoint         string `json:"token_endpoint"`
		}
		Expect(json.NewDecoder(resp.Body).Decode(&meta)).To(Succeed())
		Expect(meta.Issuer).To(Equal(fmt.Sprintf("http://localhost:%d", mcpPort)))
		Expect(meta.AuthorizationEndpoint).To(ContainSubstring("/mcp/authorize"))
		Expect(meta.TokenEndpoint).To(ContainSubstring("/mcp/token"))

		By("checking protected-resource metadata")
		resp, err = http.Get(mcpURL("/.well-known/oauth-protected-resource"))
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()
		Expect(resp.StatusCode).To(Equal(http.StatusOK))
	})

	It("should reject MCP calls without a token", func() {
		code, body := mcpRPC("", "tools/list", map[string]interface{}{})
		Expect(code).To(Equal(http.StatusUnauthorized))
		_ = body
	})

	It("should complete the OAuth consent and token exchange", func() {
		accessToken = mintMCPToken()
		Expect(accessToken).NotTo(BeEmpty())
	})

	It("should list MCP tools over JSON-RPC", func() {
		Expect(accessToken).NotTo(BeEmpty(), "token must be minted by the prior spec")
		code, body := mcpRPC(accessToken, "tools/list", map[string]interface{}{})
		Expect(code).To(Equal(http.StatusOK))

		result, ok := body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue(), "tools/list should return a result object")
		tools, ok := result["tools"].([]interface{})
		Expect(ok).To(BeTrue())
		Expect(tools).NotTo(BeEmpty())

		names := make(map[string]bool, len(tools))
		for _, t := range tools {
			if tm, ok := t.(map[string]interface{}); ok {
				if name, ok := tm["name"].(string); ok {
					names[name] = true
				}
			}
		}
		for _, want := range []string{"fleet_status", "list_applications", "list_clusters"} {
			Expect(names).To(HaveKey(want), "expected MCP tool %q to be registered", want)
		}
	})

	It("should answer read tools with structured content and text fallback", func() {
		Expect(accessToken).NotTo(BeEmpty())
		for _, tool := range []string{"fleet_status", "list_applications", "list_clusters"} {
			By(fmt.Sprintf("calling %s", tool))
			code, body := mcpRPC(accessToken, "tools/call", map[string]interface{}{
				"name":      tool,
				"arguments": map[string]interface{}{},
			})
			Expect(code).To(Equal(http.StatusOK), "tools/call %s should succeed", tool)
			Expect(body).NotTo(HaveKey("error"), "tools/call %s returned an error: %v", tool, body["error"])

			result, ok := body["result"].(map[string]interface{})
			Expect(ok).To(BeTrue())
			content, ok := result["content"].([]interface{})
			Expect(ok).To(BeTrue(), "%s should return a content array", tool)
			Expect(content).NotTo(BeEmpty(), "%s should return text fallback content", tool)

			first, ok := content[0].(map[string]interface{})
			Expect(ok).To(BeTrue())
			Expect(first["type"]).To(Equal("text"), "%s content[0] should be a text block", tool)
			Expect(first["text"]).NotTo(BeEmpty(), "%s text fallback should be non-empty", tool)
		}
	})
})
