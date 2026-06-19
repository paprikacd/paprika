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
	"os"
	"os/exec"
	"strings"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

var (
	managerImage = "example.com/paprika:v0.0.1"
	demoImage    = "localhost/paprika-demo:latest"

	kindClusterName          = "paprika-test-e2e"
	shouldCleanupCertManager = false
	shouldCleanupKindCluster = false
	oldKubeRC                string
)

func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting paprika e2e test suite\n")
	RunSpecs(t, "e2e suite")
}

var _ = BeforeSuite(func() {
	By("checking for existing Kind cluster")
	clusterExists, err := kindClusterExists(kindClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to check Kind clusters")

	if !clusterExists {
		By(fmt.Sprintf("creating Kind cluster %q", kindClusterName))
		cmd := exec.Command("kind", "create", "cluster", "--name", kindClusterName)
		_, err := utils.Run(cmd)
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to create Kind cluster")
		shouldCleanupKindCluster = true
	} else {
		_, _ = fmt.Fprintf(GinkgoWriter, "Kind cluster %q already exists. Skipping creation.\n", kindClusterName)
		By("switching kubectl context to Kind cluster")
		cmd := exec.Command("kubectl", "config", "use-context", fmt.Sprintf("kind-%s", kindClusterName))
		_, err := utils.Run(cmd)
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to switch kubectl context")
	}

	By("building the manager image")
	cmd := exec.Command("make", "docker-build", fmt.Sprintf("IMG=%s", managerImage))
	_, err = utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the manager image")

	By("loading the manager image on Kind")
	err = utils.LoadImageToKindClusterWithName(managerImage, kindClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the manager image into Kind")

	By("building the demo app image")
	cmd = exec.Command("docker", "build", "-t", demoImage, "-f", "demo/Dockerfile", "demo")
	_, err = utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the demo image")

	By("loading the demo app image on Kind")
	err = utils.LoadImageToKindClusterWithName(demoImage, kindClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the demo image into Kind")

	configureKubectlKubeRC()
	setupCertManager()
	deployManager()
})

var _ = AfterSuite(func() {
	teardownManager()
	teardownCertManager()

	if oldKubeRC == "" {
		_ = os.Unsetenv("KUBECTL_KUBERC")
	} else {
		_ = os.Setenv("KUBECTL_KUBERC", oldKubeRC)
	}

	if shouldCleanupKindCluster {
		By(fmt.Sprintf("deleting Kind cluster %q", kindClusterName))
		cmd := exec.Command("kind", "delete", "cluster", "--name", kindClusterName)
		_, err := utils.Run(cmd)
		if err != nil {
			_, _ = fmt.Fprintf(GinkgoWriter, "Failed to delete Kind cluster: %v\n", err)
		}
	}
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

func configureKubectlKubeRC() {
	oldKubeRC = os.Getenv("KUBECTL_KUBERC")
	if oldKubeRC != "true" {
		By("disabling kubectl kuberc for test isolation")
		err := os.Setenv("KUBECTL_KUBERC", "false")
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to disable kubectl kuberc")
		_, _ = fmt.Fprintf(GinkgoWriter,
			"kubectl kuberc disabled for consistent test behavior (override with KUBECTL_KUBERC=true)\n")
	} else {
		_, _ = fmt.Fprintf(GinkgoWriter, "kubectl kuberc enabled (KUBECTL_KUBERC=true)\n")
	}
}

func setupCertManager() {
	if os.Getenv("CERT_MANAGER_INSTALL_SKIP") == "true" {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager installation (CERT_MANAGER_INSTALL_SKIP=true)\n")
		return
	}

	By("checking if CertManager is already installed")
	if utils.IsCertManagerCRDsInstalled() {
		_, _ = fmt.Fprintf(GinkgoWriter, "CertManager is already installed. Skipping installation.\n")
		return
	}

	shouldCleanupCertManager = true

	By("installing CertManager")
	Expect(utils.InstallCertManager()).To(Succeed(), "Failed to install CertManager")
}

func teardownCertManager() {
	if !shouldCleanupCertManager {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager cleanup (not installed by this suite)\n")
		return
	}

	By("uninstalling CertManager")
	utils.UninstallCertManager()
}
