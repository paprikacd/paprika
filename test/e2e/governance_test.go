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

const governanceNamespace = "e2e-governance"

var _ = Describe("Governance", Ordered, func() {
	BeforeAll(func() {
		By(fmt.Sprintf("creating governance namespace %q", governanceNamespace))
		cmd := exec.Command("kubectl", "create", "ns", governanceNamespace)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create governance namespace")
	})

	AfterAll(func() {
		By("cleaning up governance test resources")
		cmd := exec.Command("kubectl", "delete", "ns", governanceNamespace, "--ignore-not-found", "--timeout=60s")
		_, _ = utils.Run(cmd)
	})

	It("should block an Application that violates its AppProject namespace constraint", func() {
		By("creating a restrictive AppProject")
		project := fmt.Sprintf(`{
			"apiVersion": "core.paprika.io/v1alpha1",
			"kind": "AppProject",
			"metadata": {"name": "restrictive", "namespace": "%s"},
			"spec": {
				"sourceRepos": ["*"],
				"destinations": [{"server": "*", "namespace": "payments-*"}],
				"kinds": ["*"]
			}
		}`, governanceNamespace)
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(project)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create AppProject")

		By("creating an Application in a non-allowed namespace")
		app := fmt.Sprintf(`{
			"apiVersion": "pipelines.paprika.io/v1alpha1",
			"kind": "Application",
			"metadata": {"name": "e2e-governance-app", "namespace": "%s"},
			"spec": {
				"project": "restrictive",
				"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
				"stages": [{"name": "dev", "ring": 1}],
				"strategy": "Rolling",
				"syncPolicy": "Auto",
				"parameters": {
					"replicaCount": "1",
					"features.canary.enabled": "false",
					"features.monitoring.enabled": "false",
					"features.ingress.enabled": "false"
				}
			}
		}`, governanceNamespace)
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(app)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create Application")

		By("waiting for GovernanceChecked=False on the Application")
		Eventually(func(g Gomega) {
			gcmd := exec.Command("kubectl", "get", "application", "e2e-governance-app",
				"-n", governanceNamespace, "-o", "jsonpath={.status.conditions[?(@.type=='GovernanceChecked')].status}")
			gout, gerr := utils.Run(gcmd)
			g.Expect(gerr).NotTo(HaveOccurred())
			g.Expect(gout).To(Equal("False"), "Application should report a governance violation")
		}, 2*time.Minute, 2*time.Second).Should(Succeed())

		By("verifying no deployment was created in the governed namespace")
		cmd = exec.Command("kubectl", "get", "deployments", "-n", governanceNamespace,
			"-l", "app.paprika.io/name=e2e-governance-app", "-o", "jsonpath={.items}")
		out, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred())
		Expect(out).To(Equal("[]"), "No deployment should be created for a blocked Application")

		By("updating the AppProject to allow the governance namespace")
		patch := fmt.Sprintf(`[{"op": "add", "path": "/spec/destinations/-", "value": {"server": "*", "namespace": "%s"}}]`, governanceNamespace)
		cmd = exec.Command("kubectl", "patch", "appproject", "restrictive", "-n", governanceNamespace, "--type=json", "-p", patch)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to patch AppProject")

		By("triggering a resync of the Application")
		cmd = exec.Command("kubectl", "annotate", "application", "e2e-governance-app", "-n", governanceNamespace,
			"paprika.io/resync-triggered=now", "--overwrite")
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to annotate Application")

		By("waiting for the Application to reach Healthy")
		Eventually(func(g Gomega) {
			gcmd := exec.Command("kubectl", "get", "application", "e2e-governance-app",
				"-n", governanceNamespace, "-o", "jsonpath={.status.phase}")
			gout, gerr := utils.Run(gcmd)
			g.Expect(gerr).NotTo(HaveOccurred())
			g.Expect(gout).To(Equal("Healthy"), "Application should become Healthy after the violation is resolved")
		}, 3*time.Minute, 2*time.Second).Should(Succeed())
	})
})
