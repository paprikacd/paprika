//go:build e2e_core
// +build e2e_core

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

var _ = Describe("Core", Ordered, func() {
	var controllerPodName string

	AfterAll(func() {
		By("cleaning up core pipeline")
		cmd := exec.Command("kubectl", "delete", "pipeline", "e2e-core-hello", "-n", coreNamespace, "--ignore-not-found")
		_, _ = utils.Run(cmd)
		cmd = exec.Command("kubectl", "delete", "jobs", "-n", coreNamespace,
			"-l", "paprika.io/pipeline=e2e-core-hello", "--ignore-not-found")
		_, _ = utils.Run(cmd)
	})

	AfterEach(func() {
		if !CurrentSpecReport().Failed() {
			return
		}
		if controllerPodName == "" {
			return
		}

		By("Fetching controller manager pod logs")
		cmd := exec.Command("kubectl", "logs", controllerPodName, "-n", coreNamespace)
		logs, err := utils.Run(cmd)
		if err == nil {
			_, _ = fmt.Fprintf(GinkgoWriter, "Controller logs:\n%s\n", logs)
		} else {
			_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get controller logs: %v\n", err)
		}

		By("Fetching Kubernetes events")
		cmd = exec.Command("kubectl", "get", "events", "-n", coreNamespace, "--sort-by=.lastTimestamp")
		events, err := utils.Run(cmd)
		if err == nil {
			_, _ = fmt.Fprintf(GinkgoWriter, "Kubernetes events:\n%s\n", events)
		} else {
			_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get events: %v\n", err)
		}
	})

	SetDefaultEventuallyTimeout(2 * time.Minute)
	SetDefaultEventuallyPollingInterval(time.Second)

	It("should run the controller-manager pod", func() {
		verifyControllerUp := func(g Gomega) {
			By("getting the controller-manager pod name")
			cmd := exec.Command("kubectl", "get", "pods", "-l", "control-plane=controller-manager", "-n", coreNamespace,
				"-o", "go-template={{ range .items }}{{ if not .metadata.deletionTimestamp }}"+
					"{{ .metadata.name }}{{ \"\\n\" }}{{ end }}{{ end }}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred(), "Failed to list controller pods")
			names := utils.GetNonEmptyLines(out)
			g.Expect(names).To(HaveLen(1), "expected exactly one controller pod")
			controllerPodName = names[0]
			g.Expect(controllerPodName).To(ContainSubstring("controller-manager"))

			By("validating the pod is running")
			cmd = exec.Command("kubectl", "get", "pod", controllerPodName, "-n", coreNamespace,
				"-o", "jsonpath={.status.phase}")
			out, err = utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("Running"), "Controller pod is not running")
		}
		Eventually(verifyControllerUp).Should(Succeed())
	})

	It("should reconcile a simple pipeline", func() {
		By("creating a pipeline")
		pipeline := fmt.Sprintf(`{
			"apiVersion": "pipelines.paprika.io/v1alpha1",
			"kind": "Pipeline",
			"metadata": {"name": "e2e-core-hello", "namespace": "%s"},
			"spec": {
				"maxParallel": 1,
				"steps": [{"name": "greet", "image": "alpine:3.19", "script": "echo hello-from-paprika"}]
			}
		}`, coreNamespace)
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(pipeline)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create pipeline")

		By("waiting for the pipeline to succeed")
		Eventually(func(g Gomega) {
			cmd := exec.Command("kubectl", "get", "pipeline", "e2e-core-hello", "-n", coreNamespace,
				"-o", "jsonpath={.status.phase}")
			out, err := utils.Run(cmd)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("Succeeded"), "Pipeline should succeed")
		}, 2*time.Minute, time.Second).Should(Succeed())
	})
})
