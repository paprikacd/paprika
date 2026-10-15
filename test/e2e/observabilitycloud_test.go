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
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awscredentials "github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cloudwatchtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	cloudwatchlogstypes "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs/types"

	"github.com/benebsworth/paprika/test/utils"
)

// Cloud-connector e2e coverage for the observability gateway. The spec
// onboards AWS and GCP providers against in-cluster emulators and then reads
// real data back through the gateway's MCP query tools:
//
//   - localstack stands in for CloudWatch Logs and CloudWatch Metrics. The
//     pinned tag accepts ANY static credentials, so credential-refusal
//     coverage is exercised against the canned responder below, which answers
//     an AWS AccessDenied error document for Logs calls.
//   - localstack does not emulate X-Ray or CloudTrail at all (probed live in
//     BeforeAll; the verdict is recorded), so both always run against the
//     canned AWS responder — an nginx serving the two REST/JSON shapes the
//     connectors call, plus an AccessDenied body on Logs targets.
//   - A nginx fake googleapis stands in for GCP: it grants the JWT bearer
//     grant the connector's service-account token source performs, then
//     serves canned entries:list / timeSeries / metricDescriptors / traces
//     bodies. The provider config's endpoint override points the connectors
//     at it, and the generated service-account JSON pins token_uri at the
//     in-cluster address so the token exchange happens pod-to-pod.
//
// Providers are onboarded three ways: the gateway's validate_provider probe,
// the api-server's CreateObservabilityProvider connect RPC (which mints the
// credential Secret), and plain kubectl-applied Secret + CR pairs.

const (
	obsCloudLocalPort   = 4005 // test-binary port-forward to the localstack edge (seeding)
	obsCloudAPIPort     = 4006 // test-binary port-forward to the api-server (connect RPC)
	obsCloudAWSKey      = "test"
	obsCloudAWSSecret   = "test"
	obsCloudMarker      = "PAPRIKA_E2E_MARKER"
	obsCloudAWSRegion   = "us-east-1"
	obsCloudGCPProject  = "e2e-project"
	obsCloudGCPToken    = "e2e-gcp-token"
	obsCloudLogGroup    = "paprika-e2e"
	obsCloudMetricNS    = "Paprika/E2E"
	localstackImage     = "localstack/localstack:4.14.0"
	nginxImage          = "nginx:alpine"
	localstackInCluster = "http://e2e-localstack." + obsNamespace + ".svc.cluster.local:4566"
	gcpFakeInCluster    = "http://e2e-gcpfake." + obsNamespace + ".svc.cluster.local"
	awsCannedInCluster  = "http://e2e-awscan." + obsNamespace + ".svc.cluster.local"
)

var (
	obsCloudToken      string
	obsCloudAPIToken   string
	obsCloudSAJSON     string
	obsCloudAWSCreds   = fmt.Sprintf(`{"access_key_id":%q,"secret_access_key":%q}`, obsCloudAWSKey, obsCloudAWSSecret)
	obsCloudOwnsGW     bool
	obsCloudGWForward  *exec.Cmd
	obsCloudLSForward  *utils.PortForward
	obsCloudAPIForward *utils.PortForward
)

// obsCloudURL addresses the api-server through the test-binary forward.
func obsCloudURL(path string) string {
	return fmt.Sprintf("http://localhost:%d%s", obsCloudAPIPort, path)
}

// obsCloudCallTool invokes one observability MCP tool and returns the
// decoded structuredContent (falling back to the first text content block).
func obsCloudCallTool(token, tool string, arguments map[string]interface{}) map[string]interface{} {
	return obsCloudCallToolG(Default, token, tool, arguments)
}

// obsCloudCallToolG is the Gomega-parameterized core so Eventually closures
// retry instead of failing the spec on the first attempt.
func obsCloudCallToolG(g Gomega, token, tool string, arguments map[string]interface{}) map[string]interface{} {
	code, body := obsRPC(token, "tools/call", map[string]interface{}{
		"name":      tool,
		"arguments": arguments,
	})
	g.Expect(code).To(Equal(http.StatusOK), "tools/call %s returned %d: %v", tool, code, body)
	g.Expect(body).NotTo(HaveKey("error"), "tools/call %s returned a JSON-RPC error: %v", tool, body["error"])
	result, ok := body["result"].(map[string]interface{})
	g.Expect(ok).To(BeTrue(), "tools/call %s should return a result object", tool)
	g.Expect(result["isError"]).NotTo(Equal(true), "tools/call %s returned isError: %v", tool, result["content"])
	if sc, ok := result["structuredContent"].(map[string]interface{}); ok {
		return sc
	}
	content, ok := result["content"].([]interface{})
	g.Expect(ok).To(BeTrue())
	if len(content) > 0 {
		if block, ok := content[0].(map[string]interface{}); ok {
			if text, ok := block["text"].(string); ok {
				var payload map[string]interface{}
				if err := json.Unmarshal([]byte(text), &payload); err == nil {
					return payload
				}
			}
		}
	}
	return map[string]interface{}{}
}

// obsCloudValidate runs validate_provider and returns the state verdict.
func obsCloudValidate(token, providerType string, config map[string]interface{}, credentials string) (string, string) {
	sc := obsCloudCallTool(token, "validate_provider", map[string]interface{}{
		"type":        providerType,
		"config":      config,
		"credentials": credentials,
	})
	state, _ := sc["state"].(string)
	reason, _ := sc["reason"].(string)
	return state, reason
}

// obsCloudQueryResult polls one query tool until the backend answers and
// returns the full structuredContent; the predicate sees each attempt.
func obsCloudQueryResult(token, tool string, args map[string]interface{}, predicate func(Gomega, map[string]interface{})) {
	Eventually(func(g Gomega) {
		sc := obsCloudCallToolG(g, token, tool, args)
		state, _ := sc["state"].(string)
		g.Expect(state).To(Equal("OK"),
			"%s should reach StateOK, got state=%v reason=%v", tool, sc["state"], sc["reason"])
		predicate(g, sc)
	}, 90*time.Second, 3*time.Second).Should(Succeed())
}

// obsCloudConnectPOST posts one unary connect call to the api-server and
// returns the HTTP status plus the decoded envelope (connect errors decode to
// {"code": ..., "message": ..., "details": [...]}).
func obsCloudConnectPOST(token, procedure string, payload map[string]interface{}) (int, map[string]interface{}) {
	body, err := json.Marshal(payload)
	Expect(err).NotTo(HaveOccurred())
	req, err := http.NewRequest(http.MethodPost,
		obsCloudURL("/paprika.v1.PaprikaService/"+procedure), strings.NewReader(string(body)))
	Expect(err).NotTo(HaveOccurred())
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	Expect(err).NotTo(HaveOccurred())
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	Expect(err).NotTo(HaveOccurred())
	var decoded map[string]interface{}
	_ = json.Unmarshal(raw, &decoded)
	return resp.StatusCode, decoded
}

// obsCloudCreateProviderRequest builds a CreateObservabilityProvider payload.
// config_json is a proto bytes field, so its JSON wire form is base64 —
// credential_document is a plain string.
func obsCloudCreateProviderRequest(name, providerType, configJSON, credentialDocument string) map[string]interface{} {
	return map[string]interface{}{
		"name":               name,
		"namespace":          obsNamespace,
		"type":               providerType,
		"configJson":         base64.StdEncoding.EncodeToString([]byte(configJSON)),
		"credentialDocument": credentialDocument,
	}
}

// obsCloudApplyJSON applies one manifest expressed as a Go value.
func obsCloudApplyJSON(obj map[string]interface{}) {
	raw, err := json.Marshal(obj)
	Expect(err).NotTo(HaveOccurred())
	_, err = utils.ApplyManifest(string(raw))
	Expect(err).NotTo(HaveOccurred(), "failed to apply %s %s", obj["kind"], obj["metadata"].(map[string]interface{})["name"])
}

// obsCloudSecret builds an opaque Secret manifest holding one credential doc.
func obsCloudSecret(name, document string) map[string]interface{} {
	return map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata":   map[string]interface{}{"name": name, "namespace": obsNamespace},
		"type":       "Opaque",
		"stringData": map[string]interface{}{"credentials": document},
	}
}

// obsCloudProvider builds an ObservabilityProvider CR manifest referencing a
// credential Secret.
func obsCloudProvider(name, providerType string, config map[string]interface{}, secretName string) map[string]interface{} {
	spec := map[string]interface{}{
		"type":   providerType,
		"config": config,
	}
	if secretName != "" {
		spec["credentialsSecretRef"] = map[string]interface{}{"name": secretName, "key": "credentials"}
	}
	return map[string]interface{}{
		"apiVersion": "observability.paprika.io/v1alpha1",
		"kind":       "ObservabilityProvider",
		"metadata":   map[string]interface{}{"name": name, "namespace": obsNamespace},
		"spec":       spec,
	}
}

// obsCloudAWSConfig is the shared AWS connector config shape.
func obsCloudAWSConfig(endpoint, extraKey, extraValue string) map[string]interface{} {
	cfg := map[string]interface{}{
		"region":   obsCloudAWSRegion,
		"endpoint": endpoint,
	}
	if extraKey != "" {
		cfg[extraKey] = extraValue
	}
	return cfg
}

const obsCloudGCPFakeNginx = `
server {
    listen 80;
    default_type application/json;

    location = /healthz {
        return 200 '{"ok":true}';
    }
    location = /token {
        return 200 '{"access_token":"` + obsCloudGCPToken + `","expires_in":3600,"token_type":"Bearer"}';
    }
    location = /v2/entries:list {
        if ($http_authorization != "Bearer ` + obsCloudGCPToken + `") { return 403; }
        return 200 '{"entries":[{"logName":"projects/` + obsCloudGCPProject + `/logs/e2e","resource":{"type":"global","labels":{"project_id":"` + obsCloudGCPProject + `"}},"timestamp":"2026-10-12T00:00:00Z","severity":"INFO","textPayload":"e2e background entry"},{"logName":"projects/` + obsCloudGCPProject + `/logs/e2e","resource":{"type":"global","labels":{"project_id":"` + obsCloudGCPProject + `"}},"timestamp":"2026-10-12T00:00:30Z","severity":"NOTICE","textPayload":"e2e marker entry ` + obsCloudMarker + `","jsonPayload":{"marker":"` + obsCloudMarker + `","origin":"e2e-fake"}}]}';
    }
    location = /v3/projects/` + obsCloudGCPProject + `/timeSeries {
        return 200 '{"timeSeries":[{"metric":{"type":"custom.googleapis.com/e2e","labels":{"env":"e2e"}},"resource":{"type":"global","labels":{"project_id":"` + obsCloudGCPProject + `"}},"metricKind":"GAUGE","valueType":"DOUBLE","points":[{"interval":{"startTime":"2026-10-12T00:00:00Z","endTime":"2026-10-12T00:00:00Z"},"value":{"doubleValue":42}}]}]}';
    }
    location = /v3/projects/` + obsCloudGCPProject + `/metricDescriptors {
        return 200 '{"metricDescriptors":[{"name":"projects/` + obsCloudGCPProject + `/metricDescriptors/custom.googleapis.com/e2e","type":"custom.googleapis.com/e2e","displayName":"E2E Metric","metricKind":"GAUGE","valueType":"DOUBLE"}]}';
    }
    location ~ ^/v1/projects/` + obsCloudGCPProject + `/traces/[^/]+$ {
        return 200 '{"projectId":"` + obsCloudGCPProject + `","traceId":"e2e-trace-0001","spans":[{"name":"e2e-span-detail","spanId":"00000001","startTime":"2026-10-12T00:00:00Z","endTime":"2026-10-12T00:00:01Z"}]}';
    }
    location = /v1/projects/` + obsCloudGCPProject + `/traces {
        return 200 '{"traces":[{"projectId":"` + obsCloudGCPProject + `","traceId":"e2e-trace-0001","spans":[{"name":"e2e-span","spanId":"00000001","startTime":"2026-10-12T00:00:00Z","endTime":"2026-10-12T00:00:01Z"}]}]}';
    }
    location / { return 404; }
}
`

// obsCloudAWSCannedNginx serves the X-Ray and CloudTrail read shapes the
// connectors call (localstack emulates neither) and answers CloudWatch Logs
// targets with an AWS AccessDenied document so credential-refusal
// classification can be exercised against a backend that actually refuses.
const obsCloudAWSCannedNginx = `
server {
    listen 80;
    default_type application/json;

    location = /healthz {
        return 200 '{"ok":true}';
    }
    location = /TraceSummaries {
        return 200 '{"TraceSummaries":[],"NextToken":null}';
    }
    location = /BatchGetTraces {
        return 200 '{"Traces":[],"UnprocessedTraceIds":[]}';
    }
    location / {
        if ($http_x_amz_target ~* "Logs_") {
            return 403 '{"__type":"AccessDenied","message":"The security token included in the request is invalid."}';
        }
        return 200 '{"Events":[]}';
    }
}
`

// obsCloudNginxWorkload builds the ConfigMap + Deployment + Service triple for
// one fake backend.
func obsCloudNginxWorkload(name, nginxConf string) []map[string]interface{} {
	return []map[string]interface{}{
		{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata":   map[string]interface{}{"name": name + "-nginx", "namespace": obsNamespace},
			"data":       map[string]interface{}{"default.conf": nginxConf},
		},
		{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata":   map[string]interface{}{"name": name, "namespace": obsNamespace, "labels": map[string]interface{}{"app": name}},
			"spec": map[string]interface{}{
				"replicas": 1,
				"selector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": name}},
				"template": map[string]interface{}{
					"metadata": map[string]interface{}{"labels": map[string]interface{}{"app": name}},
					"spec": map[string]interface{}{"containers": []interface{}{map[string]interface{}{
						"name":  "nginx",
						"image": nginxImage,
						"ports": []interface{}{map[string]interface{}{"containerPort": 80}},
						"volumeMounts": []interface{}{map[string]interface{}{
							"name": "conf", "mountPath": "/etc/nginx/conf.d/default.conf", "subPath": "default.conf",
						}},
						"readinessProbe": map[string]interface{}{
							"httpGet": map[string]interface{}{"path": "/healthz", "port": 80},
						},
					}},
						"volumes": []interface{}{map[string]interface{}{
							"name": "conf",
							"configMap": map[string]interface{}{
								"name": name + "-nginx",
							},
						}},
					},
				},
			},
		},
		{
			"apiVersion": "v1",
			"kind":       "Service",
			"metadata":   map[string]interface{}{"name": name, "namespace": obsNamespace},
			"spec": map[string]interface{}{
				"selector": map[string]interface{}{"app": name},
				"ports":    []interface{}{map[string]interface{}{"port": 80, "targetPort": 80}},
			},
		},
	}
}

// obsCloudDeployGateway installs the paprika-obs api+observability-gateway
// release exactly like the sibling gateway spec does. The sibling's BeforeAll
// runs first in a full-suite pass; this body only executes when the gateway is
// not already reachable (a focused run of this spec alone).
func obsCloudDeployGateway() {
	By("deploying the paprika-obs release (focused run: gateway spec not active)")
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
	tmp, err := os.CreateTemp("", "paprika-obs-cloud-values-*.yaml")
	Expect(err).NotTo(HaveOccurred())
	valuesFile := tmp.Name()
	Expect(tmp.Close()).To(Succeed())
	Expect(os.WriteFile(valuesFile, []byte(valuesYAML), 0o600)).To(Succeed())

	_, err = utils.Run(exec.Command("helm", "upgrade", "--install", obsRelease, "./charts/chart",
		"--namespace", obsNamespace, "--create-namespace", "-f", valuesFile, "--wait", "--timeout", "3m"))
	Expect(err).NotTo(HaveOccurred(), "failed to deploy the paprika-obs release")

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
	Expect(err).NotTo(HaveOccurred(), "failed to create observability read RBAC")

	getDeploy := exec.Command("kubectl", "get", "deployment", "-n", obsNamespace,
		"-l", "app.kubernetes.io/component=observability-gateway", "-o", "name")
	deployName, err := utils.Run(getDeploy)
	Expect(err).NotTo(HaveOccurred(), "failed to get observability-gateway deployment name")
	pfCmd := exec.Command("kubectl", "port-forward", "-n", obsNamespace,
		strings.TrimSpace(deployName), fmt.Sprintf("%d:8090", obsPort))
	Expect(pfCmd.Start()).To(Succeed(), "failed to start port-forward for the observability-gateway")
	obsCloudGWForward = pfCmd
	obsCloudOwnsGW = true
}

// obsCloudEnsureGateway reuses the sibling gateway spec's release and forward
// when present (full-suite pass) and deploys it when running focused.
func obsCloudEnsureGateway() {
	reachable := func() bool {
		resp, err := http.Get(obsURL("/healthz"))
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}
	if reachable() {
		_, _ = fmt.Fprintf(GinkgoWriter, "paprika-obs gateway already reachable on :%d — reusing the sibling spec's release\n", obsPort)
		return
	}
	obsCloudDeployGateway()
	Eventually(reachable, 90*time.Second, 2*time.Second).Should(BeTrue(),
		"observability-gateway must answer /healthz on :%d", obsPort)
}

var _ = Describe("Observability Cloud Providers", Ordered, func() {
	BeforeAll(func() {
		By("ensuring the paprika-obs release exists")
		obsCloudEnsureGateway()

		By("minting an observability token")
		obsCloudToken = mintObservabilityToken()
		Expect(obsCloudToken).NotTo(BeEmpty())

		By("deploying localstack for CloudWatch Logs/Metrics")
		obsCloudApplyJSON(map[string]interface{}{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata":   map[string]interface{}{"name": "e2e-localstack", "namespace": obsNamespace, "labels": map[string]interface{}{"app": "e2e-localstack"}},
			"spec": map[string]interface{}{
				"replicas": 1,
				"selector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "e2e-localstack"}},
				"template": map[string]interface{}{
					"metadata": map[string]interface{}{"labels": map[string]interface{}{"app": "e2e-localstack"}},
					"spec": map[string]interface{}{"containers": []interface{}{map[string]interface{}{
						"name":  "localstack",
						"image": localstackImage,
						"env":   []interface{}{map[string]interface{}{"name": "DEFAULT_REGION", "value": obsCloudAWSRegion}},
						"ports": []interface{}{map[string]interface{}{"containerPort": 4566}},
						"readinessProbe": map[string]interface{}{
							"httpGet": map[string]interface{}{"path": "/_localstack/health", "port": 4566},
						},
					}}},
				},
			},
		})
		obsCloudApplyJSON(map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Service",
			"metadata":   map[string]interface{}{"name": "e2e-localstack", "namespace": obsNamespace},
			"spec": map[string]interface{}{
				"selector": map[string]interface{}{"app": "e2e-localstack"},
				"ports":    []interface{}{map[string]interface{}{"port": 4566, "targetPort": 4566}},
			},
		})
		Expect(utils.WaitAvailable(obsNamespace, "deployment", "e2e-localstack", 3*time.Minute)).To(Succeed(),
			"localstack did not become available")

		By("port-forwarding the localstack edge for seeding")
		var err error
		obsCloudLSForward, err = utils.StartPortForward(obsNamespace, "deployment/e2e-localstack", fmt.Sprintf("%d:4566", obsCloudLocalPort))
		Expect(err).NotTo(HaveOccurred())
		Eventually(func(g Gomega) {
			resp, err := http.Get(fmt.Sprintf("http://localhost:%d/_localstack/health", obsCloudLocalPort))
			g.Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
		}, 2*time.Minute, 3*time.Second).Should(Succeed(), "localstack edge never answered")

		By("deploying the fake googleapis backend")
		for _, obj := range obsCloudNginxWorkload("e2e-gcpfake", obsCloudGCPFakeNginx) {
			obsCloudApplyJSON(obj)
		}
		Expect(utils.WaitAvailable(obsNamespace, "deployment", "e2e-gcpfake", 2*time.Minute)).To(Succeed(),
			"fake googleapis did not become available")

		By("deploying the canned AWS responder (X-Ray/CloudTrail + refusal body)")
		for _, obj := range obsCloudNginxWorkload("e2e-awscan", obsCloudAWSCannedNginx) {
			obsCloudApplyJSON(obj)
		}
		Expect(utils.WaitAvailable(obsNamespace, "deployment", "e2e-awscan", 2*time.Minute)).To(Succeed(),
			"canned AWS responder did not become available")

		By("probing which AWS APIs localstack actually serves")
		// X-Ray and CloudTrail are not emulated by the pinned localstack tag
		// (verified live: both answer InternalFailure). The canned responder
		// covers both; the probe stays so a future tag bump that starts
		// emulating them is visible in the output rather than silent.
		probe := func(target string) error {
			req, err := http.NewRequest(http.MethodPost,
				fmt.Sprintf("http://localhost:%d/", obsCloudLocalPort), strings.NewReader("{}"))
			if err != nil {
				return err
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Amz-Target", target)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				raw, _ := io.ReadAll(resp.Body)
				return fmt.Errorf("localstack answered %d for %s: %s", resp.StatusCode, target, strings.TrimSpace(string(raw)))
			}
			return nil
		}
		for _, api := range []struct {
			target string
			name   string
		}{
			{"XRay_20160610.GetTraceSummaries", "xray"},
			{"CloudTrail_20131101.LookupEvents", "cloudtrail"},
		} {
			if err := probe(api.target); err != nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "localstack does not serve %s — canned responder mode: %v\n", api.name, err)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "localstack serves %s (unexpected for %s — canned responder still used)\n", api.name, localstackImage)
			}
		}

		By("seeding CloudWatch Logs and Metrics through the AWS SDK")
		ctx := context.Background()
		awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
			awsconfig.WithRegion(obsCloudAWSRegion),
			awsconfig.WithCredentialsProvider(awscredentials.NewStaticCredentialsProvider(obsCloudAWSKey, obsCloudAWSSecret, "")))
		Expect(err).NotTo(HaveOccurred())
		endpoint := fmt.Sprintf("http://localhost:%d/", obsCloudLocalPort)

		cwl := cloudwatchlogs.NewFromConfig(awsCfg, func(o *cloudwatchlogs.Options) { o.BaseEndpoint = aws.String(endpoint) })
		_, _ = cwl.CreateLogGroup(ctx, &cloudwatchlogs.CreateLogGroupInput{LogGroupName: aws.String(obsCloudLogGroup)})
		_, _ = cwl.CreateLogStream(ctx, &cloudwatchlogs.CreateLogStreamInput{
			LogGroupName: aws.String(obsCloudLogGroup), LogStreamName: aws.String("e2e-stream"),
		})
		now := time.Now()
		_, err = cwl.PutLogEvents(ctx, &cloudwatchlogs.PutLogEventsInput{
			LogGroupName:  aws.String(obsCloudLogGroup),
			LogStreamName: aws.String("e2e-stream"),
			LogEvents: []cloudwatchlogstypes.InputLogEvent{
				{Timestamp: aws.Int64(now.Add(-2 * time.Minute).UnixMilli()), Message: aws.String("e2e boot message")},
				{Timestamp: aws.Int64(now.Add(-time.Minute).UnixMilli()), Message: aws.String("e2e request finished " + obsCloudMarker)},
				{Timestamp: aws.Int64(now.UnixMilli()), Message: aws.String("e2e shutdown message")},
			},
		})
		Expect(err).NotTo(HaveOccurred(), "failed to seed CloudWatch log events")

		cw := cloudwatch.NewFromConfig(awsCfg, func(o *cloudwatch.Options) { o.BaseEndpoint = aws.String(endpoint) })
		_, err = cw.PutMetricData(ctx, &cloudwatch.PutMetricDataInput{
			Namespace: aws.String(obsCloudMetricNS),
			MetricData: []cloudwatchtypes.MetricDatum{{
				MetricName: aws.String("RequestCount"),
				Value:      aws.Float64(42),
				Timestamp:  aws.Time(now),
				Unit:       cloudwatchtypes.StandardUnitCount,
			}},
		})
		Expect(err).NotTo(HaveOccurred(), "failed to seed CloudWatch metrics")

		By("generating a service-account JSON whose token_uri points at the fake googleapis")
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		Expect(err).NotTo(HaveOccurred())
		der, err := x509.MarshalPKCS8PrivateKey(key)
		Expect(err).NotTo(HaveOccurred())
		privateKeyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
		saDoc := map[string]interface{}{
			"type":                        "service_account",
			"project_id":                  obsCloudGCPProject,
			"private_key":                 privateKeyPEM,
			"client_email":                "e2e@" + obsCloudGCPProject + ".iam.gserviceaccount.com",
			"token_uri":                   gcpFakeInCluster + "/token",
			"universe_domain":             "googleapis.com",
			"auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
		}
		saRaw, err := json.Marshal(saDoc)
		Expect(err).NotTo(HaveOccurred())
		obsCloudSAJSON = string(saRaw)

		By("port-forwarding the api-server and logging in for the connect RPC")
		obsCloudAPIForward, err = utils.StartPortForward(obsNamespace,
			"deployment/"+obsRelease+"-api-server", fmt.Sprintf("%d:3000", obsCloudAPIPort))
		Expect(err).NotTo(HaveOccurred())
		Eventually(func(g Gomega) {
			resp, err := http.Get(obsCloudURL("/healthz"))
			g.Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
		}, 60*time.Second, 2*time.Second).Should(Succeed(), "api-server never answered on :%d", obsCloudAPIPort)

		loginBody, err := json.Marshal(map[string]string{"username": "admin", "password": "admin123"})
		Expect(err).NotTo(HaveOccurred())
		loginResp, err := http.Post(obsCloudURL("/auth/basic-login"), "application/json", strings.NewReader(string(loginBody)))
		Expect(err).NotTo(HaveOccurred())
		defer loginResp.Body.Close()
		Expect(loginResp.StatusCode).To(Equal(http.StatusOK), "basic login failed")
		var login struct {
			IDToken string `json:"idToken"`
		}
		Expect(json.NewDecoder(loginResp.Body).Decode(&login)).To(Succeed())
		Expect(login.IDToken).NotTo(BeEmpty())
		obsCloudAPIToken = login.IDToken
	})

	AfterAll(func() {
		By("deleting the cloud-provider CRs and credential Secrets")
		for _, name := range []string{
			"e2e-aws-logs", "e2e-aws-metrics", "e2e-aws-xray", "e2e-aws-cloudtrail",
			"e2e-gcp-logging", "e2e-gcp-monitoring", "e2e-gcp-trace",
		} {
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "ObservabilityProvider", Namespace: obsNamespace, Name: name})
		}
		for _, name := range []string{
			"e2e-aws-logs-credentials", "e2e-aws-metrics-credentials",
			"e2e-aws-xray-creds", "e2e-aws-cloudtrail-creds",
			"e2e-gcp-credentials", "e2e-badtype-credentials",
		} {
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "Secret", Namespace: obsNamespace, Name: name})
		}

		By("deleting the emulator workloads")
		for _, name := range []string{"e2e-localstack", "e2e-gcpfake", "e2e-awscan"} {
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "Deployment", Namespace: obsNamespace, Name: name})
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "Service", Namespace: obsNamespace, Name: name})
		}
		for _, name := range []string{"e2e-gcpfake-nginx", "e2e-awscan-nginx"} {
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "ConfigMap", Namespace: obsNamespace, Name: name})
		}

		By("stopping the test-binary port-forwards")
		if obsCloudLSForward != nil {
			obsCloudLSForward.Stop()
		}
		if obsCloudAPIForward != nil {
			obsCloudAPIForward.Stop()
		}

		if obsCloudOwnsGW {
			By("removing the paprika-obs release deployed by this spec")
			if obsCloudGWForward != nil && obsCloudGWForward.Process != nil {
				_ = obsCloudGWForward.Process.Signal(syscall.SIGTERM)
				_, _ = obsCloudGWForward.Process.Wait()
			}
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "ClusterRoleBinding", Name: "paprika-obs-read"})
			_ = utils.DeleteNamed(utils.ManifestID{Kind: "ClusterRole", Name: "paprika-obs-read"})
			_, _ = utils.Run(exec.Command("helm", "uninstall", obsRelease, "--namespace", obsNamespace))
		}
	})

	It("onboards CloudWatch Logs: probe, console-RPC create, and query the marker", func() {
		By("rejecting a malformed credential document with state Error")
		state, reason := obsCloudValidate(obsCloudToken, "aws-cloudwatch-logs",
			obsCloudAWSConfig(localstackInCluster, "logGroup", obsCloudLogGroup),
			`{"access_key_id":"e2e-only"}`)
		Expect(state).To(Equal("Error"), "a credential document missing secret_access_key is a caller bug and must surface as Error")
		Expect(reason).NotTo(BeEmpty())

		By("classifying a backend AccessDenied refusal as Forbidden")
		state, reason = obsCloudValidate(obsCloudToken, "aws-cloudwatch-logs",
			obsCloudAWSConfig(awsCannedInCluster, "logGroup", obsCloudLogGroup),
			obsCloudAWSCreds)
		Expect(state).To(Equal("Forbidden"),
			"the canned responder answers an AWS AccessDenied document for Logs targets; localstack itself accepts any static keys")
		Expect(reason).NotTo(BeEmpty())

		By("accepting valid static keys against localstack")
		state, _ = obsCloudValidate(obsCloudToken, "aws-cloudwatch-logs",
			obsCloudAWSConfig(localstackInCluster, "logGroup", obsCloudLogGroup),
			obsCloudAWSCreds)
		Expect(state).To(Equal("OK"), "the seeded log group must probe OK through localstack")

		By("creating the provider through the api-server CreateObservabilityProvider RPC")
		configJSON, err := json.Marshal(obsCloudAWSConfig(localstackInCluster, "logGroup", obsCloudLogGroup))
		Expect(err).NotTo(HaveOccurred())
		status, envelope := obsCloudConnectPOST(obsCloudAPIToken, "CreateObservabilityProvider",
			obsCloudCreateProviderRequest("e2e-aws-logs", "aws-cloudwatch-logs", string(configJSON), obsCloudAWSCreds))
		Expect(status).To(Equal(http.StatusOK), "CreateObservabilityProvider answered %d: %v", status, envelope)
		Expect(envelope["name"]).To(Equal("e2e-aws-logs"))

		By("querying the seeded marker through query_logs")
		obsCloudQueryResult(obsCloudToken, "query_logs", map[string]interface{}{
			"provider": obsNamespace + "/e2e-aws-logs",
			"query":    obsCloudMarker,
			"limit":    10,
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(ContainSubstring(obsCloudMarker),
				"FilterLogEvents must return the seeded marker event")
		})
	})

	It("onboards CloudWatch Metrics through the kubectl Secret + CR path", func() {
		By("probing the seeded namespace")
		state, _ := obsCloudValidate(obsCloudToken, "aws-cloudwatch-metrics",
			obsCloudAWSConfig(localstackInCluster, "namespace", obsCloudMetricNS),
			obsCloudAWSCreds)
		Expect(state).To(Equal("OK"), "ListMetrics over the seeded namespace must probe OK")

		By("applying the credential Secret and ObservabilityProvider CR")
		obsCloudApplyJSON(obsCloudSecret("e2e-aws-metrics-credentials", obsCloudAWSCreds))
		obsCloudApplyJSON(obsCloudProvider("e2e-aws-metrics", "aws-cloudwatch-metrics",
			obsCloudAWSConfig(localstackInCluster, "namespace", obsCloudMetricNS),
			"e2e-aws-metrics-credentials"))

		By("querying RequestCount statistics through query_metrics")
		obsCloudQueryResult(obsCloudToken, "query_metrics", map[string]interface{}{
			"provider": obsNamespace + "/e2e-aws-metrics",
			"query":    "RequestCount",
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			var statistics struct {
				Datapoints []interface{} `json:"Datapoints"`
			}
			g.Expect(json.Unmarshal(data, &statistics)).To(Succeed())
			g.Expect(statistics.Datapoints).NotTo(BeEmpty(),
				"GetMetricStatistics must return the seeded datapoint: %s", string(data))
		})
	})

	It("serves X-Ray and CloudTrail through the canned responder", func() {
		By("probing both connectors against the canned responder")
		for _, providerType := range []string{"aws-xray", "aws-cloudtrail"} {
			state, reason := obsCloudValidate(obsCloudToken, providerType,
				obsCloudAWSConfig(awsCannedInCluster, "", ""), obsCloudAWSCreds)
			Expect(state).To(Equal("OK"), "%s probe against the canned responder must be OK (reason=%q)", providerType, reason)
		}

		By("applying the credential Secrets and provider CRs")
		for _, providerType := range []string{"aws-xray", "aws-cloudtrail"} {
			name := "e2e-" + providerType
			obsCloudApplyJSON(obsCloudSecret(name+"-creds", obsCloudAWSCreds))
			obsCloudApplyJSON(obsCloudProvider(name, providerType, obsCloudAWSConfig(awsCannedInCluster, "", ""), name+"-creds"))
		}

		By("querying a trace summary by ID through query_traces")
		obsCloudQueryResult(obsCloudToken, "query_traces", map[string]interface{}{
			"provider": obsNamespace + "/e2e-aws-xray",
			"trace_id": "1-00000000-00000000000000000000000",
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(ContainSubstring("Traces"),
				"BatchGetTraces answer should carry the Traces member: %s", string(data))
		})

		By("querying audit events through query_logs")
		obsCloudQueryResult(obsCloudToken, "query_logs", map[string]interface{}{
			"provider": obsNamespace + "/e2e-aws-cloudtrail",
			"query":    "EventName=AssumeRole",
			"limit":    10,
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(ContainSubstring("Events"),
				"LookupEvents answer should carry the Events member: %s", string(data))
		})
	})

	It("onboards GCP Cloud Logging, Monitoring and Trace against the fake googleapis", func() {
		By("probing Cloud Logging with the generated service account")
		state, reason := obsCloudValidate(obsCloudToken, "gcp-cloudlogging",
			map[string]interface{}{"projectId": obsCloudGCPProject, "endpoint": gcpFakeInCluster},
			obsCloudSAJSON)
		Expect(state).To(Equal("OK"),
			"the service-account JWT grant must reach the fake /token and entries:list must answer (reason=%q)", reason)

		By("describing the Cloud Logging catalog entry")
		detail := obsCloudCallTool(obsCloudToken, "describe_provider_type", map[string]interface{}{"type": "gcp-cloudlogging"})
		steps, ok := detail["steps"].([]interface{})
		Expect(ok).To(BeTrue(), "describe_provider_type should carry onboarding steps: %v", detail)
		Expect(steps).NotTo(BeEmpty(), "the gcp-cloudlogging catalog entry must ship onboarding steps")

		By("applying the shared GCP credential Secret and the three provider CRs")
		obsCloudApplyJSON(obsCloudSecret("e2e-gcp-credentials", obsCloudSAJSON))
		gcpConfig := map[string]interface{}{"projectId": obsCloudGCPProject, "endpoint": gcpFakeInCluster}
		for _, tc := range []struct {
			name string
			typ  string
		}{
			{"e2e-gcp-logging", "gcp-cloudlogging"},
			{"e2e-gcp-monitoring", "gcp-cloudmonitoring"},
			{"e2e-gcp-trace", "gcp-cloudtrace"},
		} {
			obsCloudApplyJSON(obsCloudProvider(tc.name, tc.typ, gcpConfig, "e2e-gcp-credentials"))
		}

		By("querying log entries and finding the marker")
		obsCloudQueryResult(obsCloudToken, "query_logs", map[string]interface{}{
			"provider": obsNamespace + "/e2e-gcp-logging",
			"query":    obsCloudMarker,
			"limit":    10,
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(ContainSubstring(obsCloudMarker),
				"entries:list must return the canned marker entry")
		})

		By("querying the canned time series")
		obsCloudQueryResult(obsCloudToken, "query_metrics", map[string]interface{}{
			"provider": obsNamespace + "/e2e-gcp-monitoring",
			"query":    `metric.type="custom.googleapis.com/e2e"`,
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(And(
				ContainSubstring("timeSeries"),
				ContainSubstring("custom.googleapis.com/e2e"),
			), "the timeSeries answer should carry the canned series: %s", string(data))
		})

		By("querying the trace list")
		obsCloudQueryResult(obsCloudToken, "query_traces", map[string]interface{}{
			"provider": obsNamespace + "/e2e-gcp-trace",
			"query":    "e2e",
			"limit":    10,
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(ContainSubstring("e2e-trace-0001"),
				"the trace list should carry the canned trace")
		})

		By("fetching one trace by ID")
		obsCloudQueryResult(obsCloudToken, "query_traces", map[string]interface{}{
			"provider": obsNamespace + "/e2e-gcp-trace",
			"trace_id": "e2e-trace-0001",
		}, func(g Gomega, sc map[string]interface{}) {
			data, _ := json.Marshal(sc["data"])
			g.Expect(string(data)).To(ContainSubstring("e2e-span-detail"),
				"the direct trace fetch should carry the canned span")
		})
	})

	It("enforces negative validation and create-path guardrails", func() {
		By("refusing an unauthorized_user GCP credential document")
		state, reason := obsCloudValidate(obsCloudToken, "gcp-cloudlogging",
			map[string]interface{}{"projectId": obsCloudGCPProject, "endpoint": gcpFakeInCluster},
			`{"type":"authorized_user"}`)
		Expect(state).To(Equal("Forbidden"),
			"the connector restricts credential documents to service_account/external_account/impersonated_service_account")
		Expect(reason).NotTo(BeEmpty())

		By("reporting NotConfigured when no project can be resolved")
		state, _ = obsCloudValidate(obsCloudToken, "gcp-cloudlogging", map[string]interface{}{}, "")
		Expect(state).To(Equal("NotConfigured"),
			"an empty config and no credentials leave the GCP project unresolvable")

		By("rejecting an unknown provider type at the api-server with InvalidArgument")
		status, envelope := obsCloudConnectPOST(obsCloudAPIToken, "CreateObservabilityProvider",
			obsCloudCreateProviderRequest("e2e-badtype", "not-a-type", "{}", obsCloudAWSCreds))
		Expect(status).To(Equal(http.StatusBadRequest), "webhook/CRD rejection must surface as connect InvalidArgument: %v", envelope)
		Expect(envelope["code"]).To(Equal("invalid_argument"))
		_, _ = fmt.Fprintf(GinkgoWriter, "bad-type rejection message: %v\n", envelope["message"])

		By("confirming the rejected create left no credential Secret behind")
		secretOut, secretErr := utils.GetJSONPath(obsNamespace, "secret", "e2e-badtype-credentials", "{.metadata.name}")
		Expect(secretErr).To(HaveOccurred(), "the credential secret must be cleaned up after a rejected create, got %q", secretOut)

		By("rejecting an unauthenticated create with Unauthenticated")
		noAuthConfig, err := json.Marshal(obsCloudAWSConfig(localstackInCluster, "logGroup", obsCloudLogGroup))
		Expect(err).NotTo(HaveOccurred())
		status, envelope = obsCloudConnectPOST("", "CreateObservabilityProvider",
			obsCloudCreateProviderRequest("e2e-noauth", "aws-cloudwatch-logs", string(noAuthConfig), ""))
		Expect(status).To(Equal(http.StatusUnauthorized), "create without a bearer token must be unauthenticated: %v", envelope)
		Expect(envelope["code"]).To(Equal("unauthenticated"))
	})

	It("serves the provider-type library tools", func() {
		By("listing the twelve provider types")
		sc := obsCloudCallTool(obsCloudToken, "list_provider_types", map[string]interface{}{})
		types, ok := sc["types"].([]interface{})
		Expect(ok).To(BeTrue(), "list_provider_types should return a types array: %v", sc)
		Expect(types).To(HaveLen(12), "the catalog should list exactly twelve connector types")
		listed := map[string]bool{}
		for _, t := range types {
			if tm, ok := t.(map[string]interface{}); ok {
				if typ, ok := tm["type"].(string); ok {
					listed[typ] = true
				}
			}
		}
		for _, want := range []string{
			"prometheus", "loki", "tempo", "otlp",
			"gcp-cloudlogging", "gcp-cloudmonitoring", "gcp-cloudtrace",
			"aws-cloudwatch-logs", "aws-cloudwatch-metrics", "aws-xray", "aws-cloudtrail",
		} {
			Expect(listed).To(HaveKey(want), "provider type %q must appear in list_provider_types", want)
		}

		By("erroring on an unknown provider type description")
		code, body := obsRPC(obsCloudToken, "tools/call", map[string]interface{}{
			"name":      "describe_provider_type",
			"arguments": map[string]interface{}{"type": "not-a-type"},
		})
		Expect(code).To(Equal(http.StatusOK))
		// Tool-level failures travel as isError tool results, not JSON-RPC
		// protocol errors — the same result-as-data contract the query tools
		// honor.
		result, ok := body["result"].(map[string]interface{})
		Expect(ok).To(BeTrue(), "describe_provider_type should return a result object: %v", body)
		Expect(result["isError"]).To(Equal(true), "an unknown type must surface as an error result")
		content, ok := result["content"].([]interface{})
		Expect(ok).To(BeTrue())
		first, ok := content[0].(map[string]interface{})
		Expect(ok).To(BeTrue())
		text, _ := first["text"].(string)
		Expect(text).To(ContainSubstring("not-a-type"),
			"the error result should name the unknown type")
	})
})
