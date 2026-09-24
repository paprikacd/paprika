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

// clusterField returns a function that asserts the named Cluster's status
// field (a jsonpath expression) reads non-empty.
func clusterField(name, jsonpath string) func(Gomega) {
	return func(g Gomega) {
		cmd := exec.Command("kubectl", "get", "cluster", name, "-n", namespace,
			"-o", fmt.Sprintf("jsonpath={%s}", jsonpath))
		out, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(),
			"expected cluster %s field %s to be populated", name, jsonpath)
	}
}

func clusterPhase(name string) func(Gomega, string) {
	return func(g Gomega, want string) {
		cmd := exec.Command("kubectl", "get", "cluster", name, "-n", namespace,
			"-o", "jsonpath={.status.phase}")
		out, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(strings.TrimSpace(out)).To(Equal(want))
	}
}

var _ = Describe("Cluster", Ordered, func() {
	const (
		inClusterName = "e2e-in-cluster"
		badDirectName = "e2e-bad-direct"
	)

	BeforeAll(func() {
		By("creating an in-cluster Cluster registration")
		manifest := fmt.Sprintf(`{
			"apiVersion": "clusters.paprika.io/v1alpha1",
			"kind": "Cluster",
			"metadata": {"name": "%s", "namespace": "%s"},
			"spec": {
				"mode": "in-cluster",
				"displayName": "E2E Kind Cluster",
				"healthCheck": {"interval": "5s", "timeout": "5s"}
			}
		}`, inClusterName, namespace)
		cmd := exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(manifest)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create in-cluster Cluster")

		By("creating a direct Cluster with an unresolvable kubeconfig reference")
		manifest = fmt.Sprintf(`{
			"apiVersion": "clusters.paprika.io/v1alpha1",
			"kind": "Cluster",
			"metadata": {"name": "%s", "namespace": "%s"},
			"spec": {
				"mode": "direct",
				"server": "https://127.0.0.1:1",
				"kubeconfigSecretRef": {"name": "e2e-missing-kubeconfig", "key": "kubeconfig"}
			}
		}`, badDirectName, namespace)
		cmd = exec.Command("kubectl", "apply", "-f", "-")
		cmd.Stdin = strings.NewReader(manifest)
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create direct Cluster")
	})

	AfterAll(func() {
		By("cleaning up Cluster registrations")
		cmd := exec.Command("kubectl", "delete", "cluster", inClusterName, badDirectName,
			"-n", namespace, "--ignore-not-found")
		_, _ = utils.Run(cmd)
	})

	It("should reach Healthy for the in-cluster registration", func() {
		Eventually(func(g Gomega) {
			clusterPhase(inClusterName)(g, "Healthy")
		}, 90*time.Second, 2*time.Second).Should(Succeed())
	})

	It("should populate the cluster inventory from the Kubernetes API", func() {
		Eventually(clusterField(inClusterName, ".status.version"), 60*time.Second, 2*time.Second).Should(Succeed())

		for _, field := range []string{
			".status.inventory.nodeCount",
			".status.inventory.readyNodeCount",
			".status.inventory.podCount",
			".status.inventory.namespaceCount",
			".status.inventory.kubeletVersions[0]",
			".status.lastHealthCheckTime",
		} {
			Eventually(clusterField(inClusterName, field), 30*time.Second, 2*time.Second).Should(Succeed())
		}

		By("asserting the node counts are internally consistent")
		cmd := exec.Command("kubectl", "get", "cluster", inClusterName, "-n", namespace,
			"-o", "jsonpath={.status.inventory.readyNodeCount}/{.status.inventory.nodeCount}")
		out, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred())
		parts := strings.Split(strings.TrimSpace(out), "/")
		Expect(parts).To(HaveLen(2))
		Expect(parts[0]).To(Equal(parts[1]), "kind nodes should all be Ready")
	})

	It("should report no cloud provider on kind", func() {
		By("waiting for a completed health check first")
		Eventually(clusterField(inClusterName, ".status.lastHealthCheckTime"),
			60*time.Second, 2*time.Second).Should(Succeed())

		By("checking provider status is absent for kind:// providerIDs")
		cmd := exec.Command("kubectl", "get", "cluster", inClusterName, "-n", namespace,
			"-o", "jsonpath={.status.provider}")
		out, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(out)).To(BeEmpty(),
			"kind nodes carry no recognizable cloud providerID; provider status must stay absent")
	})

	It("should re-run health checks on the configured interval", func() {
		readCheckTime := func() string {
			cmd := exec.Command("kubectl", "get", "cluster", inClusterName, "-n", namespace,
				"-o", "jsonpath={.status.lastHealthCheckTime}")
			out, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			return strings.TrimSpace(out)
		}

		var first string
		Eventually(func() string {
			first = readCheckTime()
			return first
		}, 60*time.Second, 2*time.Second).ShouldNot(BeEmpty())

		By("waiting for a subsequent health check to advance the timestamp")
		Eventually(func(g Gomega) {
			g.Expect(readCheckTime()).NotTo(Equal(first))
		}, 30*time.Second, 2*time.Second).Should(Succeed())
	})

	It("should mark a direct cluster with a bad kubeconfig Unhealthy", func() {
		Eventually(func(g Gomega) {
			clusterPhase(badDirectName)(g, "Unhealthy")
		}, 90*time.Second, 2*time.Second).Should(Succeed())

		By("checking the failure condition carries a reason")
		cmd := exec.Command("kubectl", "get", "cluster", badDirectName, "-n", namespace,
			"-o", "jsonpath={.status.conditions[0].reason}")
		out, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(out)).NotTo(BeEmpty())
	})
})
