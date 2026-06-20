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
	"fmt"
	"os/exec"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

// conftestPolicyEnforceFmt is a ConftestPolicy that unconditionally denies every rendered
// Deployment. We use an unconditional deny (input.kind == "Deployment") so the outcome is
// deterministic regardless of the chart's labels. The enforcement field is templated so the
// same fixture covers both the enforce-blocks and warn-passes scenarios.
const conftestPolicyEnforceFmt = `{
	"apiVersion": "pipelines.paprika.io/v1alpha1",
	"kind": "ConftestPolicy",
	"metadata": {"name": "e2e-deny-deployment", "namespace": "%s"},
	"spec": {
		"enforcement": "%s",
		"rego": "package main\n\ndeny[msg] {\n  input.kind == \"Deployment\"\n  msg := \"deployments are forbidden\"\n}\n"
	}
}`

// conftestApplicationFmt is an Application using the same helm demo-app source as the
// ApplicationHealthCheck context. The rendered chart includes a Deployment, so the deny
// policy above will fire. The Application binds the policy by name via conftestPolicies.
const conftestApplicationFmt = `{
	"apiVersion": "pipelines.paprika.io/v1alpha1",
	"kind": "Application",
	"metadata": {"name": "e2e-conftest", "namespace": "%s"},
	"spec": {
		"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
		"stages": [{"name": "dev", "ring": 1}],
		"strategy": "Rolling",
		"syncPolicy": "Auto",
		"parameters": {
			"replicaCount": "1",
			"features.canary.enabled": "false",
			"features.monitoring.enabled": "false",
			"features.ingress.enabled": "false"
		},
		"conftestPolicies": [{"name": "e2e-deny-deployment"}]
	}
}`

// releaseConftestCondition returns the status of the named condition on the Application's
// Release. The Release is found via the app.paprika.io/name label selector that the suite
// relies on for cleanup (releases carry this label — see release_controller.go, which reads
// release.Labels["app.paprika.io/name"] at every promotion site).
func releaseConftestCondition(g Gomega, conditionType string) string {
	cmd := exec.Command("kubectl", "get", "release", "-n", namespace,
		"-l", "app.paprika.io/name=e2e-conftest",
		"-o", fmt.Sprintf("jsonpath={.items[0].status.conditions[?(@.type==\"%s\")].status}", conditionType))
	out, err := utils.Run(cmd)
	g.Expect(err).NotTo(HaveOccurred())
	return strings.TrimSpace(out)
}

var _ = Context("ApplicationConftestGate", Ordered, func() {
	AfterAll(func() {
		By("cleaning up conftest e2e resources")
		cmd := exec.Command("kubectl", "delete", "application", "e2e-conftest", "-n", namespace, "--ignore-not-found", "--timeout=30s")
		_, _ = utils.Run(cmd)
		cmd = exec.Command("kubectl", "delete", "conftestpolicy", "e2e-deny-deployment", "-n", namespace, "--ignore-not-found", "--timeout=10s")
		_, _ = utils.Run(cmd)
		for _, resource := range []string{"releases", "stages", "pipelines", "templates"} {
			cmd := exec.Command("kubectl", "delete", resource, "-l", "app.paprika.io/name=e2e-conftest", "-n", namespace, "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)
		}
		for _, resource := range []string{"deployments", "services", "ingresses", "configmaps", "jobs", "pods"} {
			cmd := exec.Command("kubectl", "delete", resource, "-n", namespace, "-l", "app.paprika.io/name=e2e-conftest", "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)
		}
	})

	It("should block promotion when an enforce policy denies the manifests", func() {
		By("creating an enforce ConftestPolicy that denies Deployments")
		policy := fmt.Sprintf(conftestPolicyEnforceFmt, namespace, "enforce")
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(policy)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create ConftestPolicy")

		By("creating an Application bound to the policy")
		app := fmt.Sprintf(conftestApplicationFmt, namespace)
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(app)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create Application")

		By("waiting for the Release to report ConftestPassed=False")
		Eventually(func(g Gomega) {
			g.Expect(releaseConftestCondition(g, "ConftestPassed")).To(Equal("False"),
				"expected the release to be blocked by the conftest gate")
		}, 3*time.Minute, 2*time.Second).Should(Succeed())

		By("confirming the Application does not reach Healthy while blocked")
		Consistently(func(g Gomega) {
			cmd := exec.Command("kubectl", "get", "application", "e2e-conftest", "-n", namespace, "-o", "jsonpath={.status.phase}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).NotTo(Equal("Healthy"), "Application must not be Healthy while conftest blocks promotion")
		}, 30*time.Second, 5*time.Second).Should(Succeed())
	})

	It("should promote once the policy is switched to warn", func() {
		By("switching the policy enforcement to warn")
		policy := fmt.Sprintf(conftestPolicyEnforceFmt, namespace, "warn")
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(policy)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to update ConftestPolicy to warn")

		By("waiting for the Application to reach Healthy")
		Eventually(func(g Gomega) {
			cmd := exec.Command("kubectl", "get", "application", "e2e-conftest", "-n", namespace, "-o", "jsonpath={.status.phase}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("Healthy"), "Application should reach Healthy once the gate only warns")
		}, 4*time.Minute, 2*time.Second).Should(Succeed())
	})
})
