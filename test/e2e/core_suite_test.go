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
	"os"
	"os/exec"
	"strings"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

const coreNamespace = "paprika-system"

var (
	coreManagerImage         = "paprika-core:e2e"
	coreClusterName          = "paprika-core-e2e"
	shouldCleanupCoreCluster = false
)

func TestCoreE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting paprika core e2e test suite\n")
	RunSpecs(t, "core e2e suite")
}

var _ = BeforeSuite(func() {
	if v := os.Getenv("MANAGER_IMAGE"); v != "" {
		coreManagerImage = v
	}
	if v := os.Getenv("KIND_CLUSTER_NAME"); v != "" {
		coreClusterName = v
	}

	By("checking for existing Kind cluster")
	exists, err := kindClusterExists(coreClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to check Kind clusters")

	if !exists {
		By(fmt.Sprintf("creating Kind cluster %q", coreClusterName))
		cmd := exec.Command("kind", "create", "cluster", "--name", coreClusterName)
		_, err := utils.Run(cmd)
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to create Kind cluster")
		shouldCleanupCoreCluster = true
	} else {
		By("switching kubectl context to existing Kind cluster")
		cmd := exec.Command("kubectl", "config", "use-context", fmt.Sprintf("kind-%s", coreClusterName))
		_, err := utils.Run(cmd)
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to switch kubectl context")
	}

	By("building lean manager image for core e2e")
	cmd := exec.Command("make", "docker-build-e2e-core", fmt.Sprintf("IMG=%s", coreManagerImage))
	_, err = utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build core manager image")

	By("loading the manager image on Kind")
	err = utils.LoadImageToKindClusterWithName(coreManagerImage, coreClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load image into Kind")

	By("installing CRDs")
	cmd = exec.Command("make", "install")
	_, err = utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to install CRDs")

	By("deploying the controller-manager")
	cmd = exec.Command("make", "deploy-e2e-core", fmt.Sprintf("IMG=%s", coreManagerImage))
	_, err = utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to deploy controller-manager")

	By("waiting for the operator deployment to be ready")
	cmd = exec.Command("kubectl", "wait", "--for=condition=available", "-n", coreNamespace,
		"deployment/paprika-controller-manager", "--timeout=120s")
	_, err = utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Operator deployment not available")
})

var _ = AfterSuite(func() {
	By("undeploying the controller-manager")
	cmd := exec.Command("make", "undeploy-e2e-core")
	_, _ = utils.Run(cmd)

	By("uninstalling CRDs")
	cmd = exec.Command("make", "uninstall")
	_, _ = utils.Run(cmd)

	By("removing manager namespace")
	cmd = exec.Command("kubectl", "delete", "ns", coreNamespace, "--ignore-not-found")
	_, _ = utils.Run(cmd)

	if !shouldCleanupCoreCluster {
		_, _ = fmt.Fprintf(GinkgoWriter, "Kind cluster %q was pre-existing; leaving it\n", coreClusterName)
		return
	}
	if os.Getenv("SKIP_KIND_CLEANUP") == "true" {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping Kind cluster cleanup (SKIP_KIND_CLEANUP=true)\n")
		return
	}

	By(fmt.Sprintf("deleting Kind cluster %q", coreClusterName))
	cmd = exec.Command("kind", "delete", "cluster", "--name", coreClusterName)
	_, _ = utils.Run(cmd)
})

func kindClusterExists(name string) (bool, error) {
	cmd := exec.Command("kind", "get", "clusters")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("failed to list Kind clusters: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == name {
			return true, nil
		}
	}
	return false, nil
}
