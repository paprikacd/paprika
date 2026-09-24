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
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"syscall"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

const rolloutNamespace = "default"

func rolloutPodTemplate(name string) string {
	return fmt.Sprintf(`{
		"metadata": {"labels": {"app": "%s"}},
		"spec": {
			"containers": [{
				"name": "demo",
				"image": "%s",
				"imagePullPolicy": "Never",
				"ports": [{"containerPort": 8080}],
				"securityContext": {
					"allowPrivilegeEscalation": false,
					"capabilities": {"drop": ["ALL"]},
					"runAsNonRoot": true,
					"runAsUser": 1000,
					"seccompProfile": {"type": "RuntimeDefault"}
				}
			}]
		}
	}`, name, demoImage)
}

func rolloutField(name, jsonpath string) func(Gomega) {
	return func(g Gomega) {
		cmd := exec.Command("kubectl", "get", "rollout", name, "-n", rolloutNamespace,
			"-o", fmt.Sprintf("jsonpath={%s}", jsonpath))
		out, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(),
			"expected rollout %s field %s to be populated", name, jsonpath)
	}
}

func rolloutPhase(name string) func(Gomega, string) {
	return func(g Gomega, want string) {
		cmd := exec.Command("kubectl", "get", "rollout", name, "-n", rolloutNamespace,
			"-o", "jsonpath={.status.phase}")
		out, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(strings.TrimSpace(out)).To(Equal(want))
	}
}

var _ = Describe("Rollout", Ordered, func() {
	const (
		rollingName = "e2e-rolling"
		canaryName  = "e2e-canary"
	)

	BeforeAll(func() {
		By("creating a rolling-update Rollout")
		manifest := fmt.Sprintf(`{
			"apiVersion": "rollouts.paprika.io/v1alpha1",
			"kind": "Rollout",
			"metadata": {"name": "%s", "namespace": "%s"},
			"spec": {
				"target": {},
				"replicas": 2,
				"strategy": {"type": "Rolling", "rolling": {}},
				"template": %s
			}
		}`, rollingName, rolloutNamespace, rolloutPodTemplate(rollingName))
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(manifest)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create rolling Rollout")

		By("creating a canary Rollout")
		manifest = fmt.Sprintf(`{
			"apiVersion": "rollouts.paprika.io/v1alpha1",
			"kind": "Rollout",
			"metadata": {"name": "%s", "namespace": "%s"},
			"spec": {
				"target": {},
				"replicas": 2,
				"strategy": {
					"type": "Canary",
					"canary": {"steps": [{"setWeight": 50, "duration": "2s"}, {"setWeight": 100}]}
				},
				"template": %s
			}
		}`, canaryName, rolloutNamespace, rolloutPodTemplate(canaryName))
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(manifest)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create canary Rollout")
	})

	AfterAll(func() {
		By("cleaning up Rollouts")
		cmd := exec.Command("kubectl", "delete", "rollout", rollingName, canaryName,
			"-n", rolloutNamespace, "--ignore-not-found")
		_, _ = utils.Run(cmd)
	})

	It("should reconcile a rolling Rollout to Healthy", func() {
		Eventually(func(g Gomega) {
			rolloutPhase(rollingName)(g, "Healthy")
		}, 120*time.Second, 2*time.Second).Should(Succeed())

		By("verifying the stable ReplicaSet and ready replicas are reported")
		Eventually(rolloutField(rollingName, ".status.stableRs"), 30*time.Second, 2*time.Second).Should(Succeed())

		Eventually(func(g Gomega) {
			cmd := exec.Command("kubectl", "get", "rollout", rollingName, "-n", rolloutNamespace,
				"-o", "jsonpath={.status.stableReadyReplicas}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(out)).To(Equal("2"))
		}, 60*time.Second, 2*time.Second).Should(Succeed())
	})

	It("should progress a canary Rollout through its steps to Healthy", func() {
		Eventually(func(g Gomega) {
			rolloutPhase(canaryName)(g, "Healthy")
		}, 120*time.Second, 2*time.Second).Should(Succeed())

		By("verifying the rollout finished at 100%% weight")
		Eventually(func(g Gomega) {
			cmd := exec.Command("kubectl", "get", "rollout", canaryName, "-n", rolloutNamespace,
				"-o", "jsonpath={.status.currentStepWeight}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(out)).To(Equal("100"))
		}, 30*time.Second, 2*time.Second).Should(Succeed())
	})

	It("should roll a new ReplicaSet when the pod template changes", func() {
		readHash := func() string {
			cmd := exec.Command("kubectl", "get", "rollout", rollingName, "-n", rolloutNamespace,
				"-o", "jsonpath={.status.currentPodHash}")
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			return strings.TrimSpace(out)
		}
		originalHash := readHash()
		Expect(originalHash).NotTo(BeEmpty())

		By("patching the pod template to trigger a rolling update")
		cmd := exec.Command("kubectl", "patch", "rollout", rollingName, "-n", rolloutNamespace,
			"--type=json", "-p",
			`[{"op":"add","path":"/spec/template/spec/containers/0/env","value":[{"name":"E2E_REV","value":"2"}]}]`)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to patch rollout template")

		By("waiting for the rollout to settle on the new pod hash")
		Eventually(func(g Gomega) {
			g.Expect(readHash()).NotTo(Equal(originalHash))
			rolloutPhase(rollingName)(g, "Healthy")
		}, 120*time.Second, 2*time.Second).Should(Succeed())
	})

	It("should record rollout lifecycle metrics on the controller endpoint", func() {
		By("granting the test service account access to the metrics endpoint")
		cmd := exec.Command("kubectl", "create", "clusterrolebinding", metricsRoleBindingName,
			"--clusterrole=paprika-metrics-reader",
			fmt.Sprintf("--serviceaccount=%s:%s", namespace, serviceAccountName))
		_, _ = utils.Run(cmd) // may already exist from the Manager context

		By("port-forwarding to the controller metrics service")
		metricsCmd := exec.Command("kubectl", "port-forward",
			"-n", namespace,
			"service/"+metricsServiceName,
			"8443:8443",
		)
		Expect(metricsCmd.Start()).To(Succeed(), "Failed to start port-forward for metrics")
		defer func() {
			if metricsCmd.Process != nil {
				_ = metricsCmd.Process.Signal(syscall.SIGTERM)
				_, _ = metricsCmd.Process.Wait()
			}
		}()
		time.Sleep(3 * time.Second)

		token, err := serviceAccountToken()
		Expect(err).NotTo(HaveOccurred())

		By("asserting rollout phase and canary metrics are recorded")
		Eventually(func(g Gomega) {
			client := &http.Client{
				Transport: &http.Transport{
					TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402 -- test-only scrape
				},
				Timeout: 10 * time.Second,
			}
			req, reqErr := http.NewRequest(http.MethodGet, "https://localhost:8443/metrics", nil)
			g.Expect(reqErr).NotTo(HaveOccurred())
			req.Header.Set("Authorization", "Bearer "+token)
			resp, httpErr := client.Do(req)
			g.Expect(httpErr).NotTo(HaveOccurred())
			defer resp.Body.Close()
			g.Expect(resp.StatusCode).To(Equal(http.StatusOK))
			body, readErr := io.ReadAll(resp.Body)
			g.Expect(readErr).NotTo(HaveOccurred())
			metricsBody := string(body)

			g.Expect(metricsBody).To(ContainSubstring(
				fmt.Sprintf(`paprika_rollout_phase_total{namespace="%s",phase="Healthy",rollout="%s"`, rolloutNamespace, canaryName)),
				"canary rollout should have recorded a Healthy phase transition")
			g.Expect(metricsBody).To(ContainSubstring("paprika_rollout_canary_step_total"),
				"canary step transitions should be counted")
		}, 60*time.Second, 5*time.Second).Should(Succeed())
	})

	It("should reject an invalid rollout at the webhook", func() {
		By("submitting a canary Rollout with no steps")
		manifest := fmt.Sprintf(`{
			"apiVersion": "rollouts.paprika.io/v1alpha1",
			"kind": "Rollout",
			"metadata": {"name": "e2e-invalid-canary", "namespace": "%s"},
			"spec": {
				"target": {},
				"replicas": 1,
				"strategy": {"type": "Canary", "canary": {"steps": []}},
				"template": %s
			}
		}`, rolloutNamespace, rolloutPodTemplate("e2e-invalid-canary"))
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(manifest)
		_, err := utils.Run(cmd)
		Expect(err).To(HaveOccurred(), "webhook should reject a canary strategy with zero steps")
	})
})
