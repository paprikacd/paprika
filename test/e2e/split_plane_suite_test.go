//go:build e2e_split
// +build e2e_split

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

const splitNamespace = "paprika-system"

var (
	splitManagerImage = "paprika-split-manager:latest"
	splitClusterName  = "paprika-split-e2e"
	cloudRunPort      = "38080"
	cloudRunCmd       *exec.Cmd
)

func TestSplitPlaneE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting paprika split-plane e2e test suite\n")
	RunSpecs(t, "split-plane e2e suite")
}

var _ = BeforeSuite(func() {
	var cmd *exec.Cmd
	By("checking for existing Kind cluster")
	clusterExists, err := kindClusterExists(splitClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to check Kind clusters")

	if !clusterExists {
		By(fmt.Sprintf("creating Kind cluster %q", splitClusterName))
		cmd = exec.Command("kind", "create", "cluster", "--name", splitClusterName)
		_, runErr := utils.Run(cmd)
		ExpectWithOffset(1, runErr).NotTo(HaveOccurred(), "Failed to create Kind cluster")
		waitForClusterReady()
	} else {
		By("switching kubectl context to existing Kind cluster")
		cmd = exec.Command("kubectl", "config", "use-context", "kind-"+splitClusterName)
		_, runErr := utils.Run(cmd)
		ExpectWithOffset(1, runErr).NotTo(HaveOccurred(), "Failed to switch kubectl context")
	}

	By("building the manager image (skipped if SKIP_IMAGE_BUILD=true)")
	if os.Getenv("SKIP_IMAGE_BUILD") == "true" {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping image build (SKIP_IMAGE_BUILD=true)\n")
		inspectCmd := exec.Command("docker", "image", "inspect", splitManagerImage)
		_, inspectErr := inspectCmd.CombinedOutput()
		ExpectWithOffset(1, inspectErr).NotTo(HaveOccurred(),
			"Image "+splitManagerImage+" not found locally; cannot skip build")
	} else {
		buildCmd := exec.Command("make", "docker-build", "IMG="+splitManagerImage)
		_, err = utils.Run(buildCmd)
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the manager image")
	}

	By("loading the manager image on Kind")
	err = utils.LoadImageToKindClusterWithName(splitManagerImage, splitClusterName)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the manager image into Kind")

	By("installing cert-manager on Kind (skip if CERT_MANAGER_INSTALL_SKIP=true)")
	if os.Getenv("CERT_MANAGER_INSTALL_SKIP") == "true" {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager installation (CERT_MANAGER_INSTALL_SKIP=true)\n")
	} else {
		Expect(utils.IsCertManagerCRDsInstalled()).To(BeFalse())
		err = utils.InstallCertManager()
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to install cert-manager")
	}

	By("creating manager namespace")
	cmd = exec.Command("kubectl", "create", "ns", splitNamespace)
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to create namespace")

	By("installing CRDs")
	cmd = exec.Command("make", "install")
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to install CRDs")

	By("deploying the controller-manager (controllers only, UI served by cloud-run)")
	cmd = exec.Command("make", "deploy", "IMG="+splitManagerImage)
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to deploy the controller-manager")

	By("waiting for the operator deployment to be ready")
	cmd = exec.Command("kubectl", "wait", "--for=condition=available", "-n", splitNamespace,
		"deployment/paprika-controller-manager", "--timeout=300s")
	_, waitErr := utils.Run(cmd)
	if waitErr != nil {
		By("dumping operator pod status for debugging")
		runDebug := func(name string, debugCmd *exec.Cmd) {
			out, debugErr := utils.Run(debugCmd)
			_, _ = fmt.Fprintf(GinkgoWriter, "--- %s ---\n%s\nerr: %v\n", name, out, debugErr)
		}
		runDebug("pods", exec.Command("kubectl", "get", "pods", "-n", splitNamespace, "-o", "wide"))
		runDebug("deployment", exec.Command("kubectl", "describe", "deployment", "paprika-controller-manager", "-n", splitNamespace))
		runDebug("events", exec.Command("kubectl", "get", "events", "-n", splitNamespace, "--sort-by=.lastTimestamp"))
		runDebug("logs", exec.Command("kubectl", "logs", "-n", splitNamespace,
			"-l", "control-plane=controller-manager", "--tail=50"))
	}
	Expect(waitErr).NotTo(HaveOccurred(), "Operator deployment not available")

	By("building the cloud-run binary")
	cmd = exec.Command("go", "build", "-o", "/tmp/paprika-cloud-run-e2e", "./cmd/cloud-run/")
	_, err = utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "Failed to build cloud-run binary")

	By("starting the cloud-run binary")
	kubeconfigPath := kindKubeconfig(splitClusterName)
	cloudRunCmd = exec.Command("/tmp/paprika-cloud-run-e2e",
		"--kubeconfig", kubeconfigPath,
		"--health-probe-bind-address", ":38081",
		"--work-dir", "/tmp/paprika-cloudrun-e2e-work",
	)
	cloudRunCmd.Env = append(os.Environ(), "PORT="+cloudRunPort)
	cloudRunCmd.Stdout = GinkgoWriter
	cloudRunCmd.Stderr = GinkgoWriter
	err = cloudRunCmd.Start()
	Expect(err).NotTo(HaveOccurred(), "Failed to start cloud-run binary")

	By("waiting for the cloud-run server to be ready")
	Eventually(func(g Gomega) {
		cmd := exec.Command("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
			fmt.Sprintf("http://localhost:%s/healthz", cloudRunPort))
		output, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(output).To(Equal("200"))
	}, 30*time.Second, time.Second).Should(Succeed())

	_, _ = fmt.Fprintf(GinkgoWriter, "Cloud-run server ready at http://localhost:%s\n", cloudRunPort)
})

var _ = AfterSuite(func() {
	By("stopping the cloud-run binary")
	if cloudRunCmd != nil && cloudRunCmd.Process != nil {
		_ = cloudRunCmd.Process.Signal(os.Interrupt)
		_ = cloudRunCmd.Wait()
	}

	By("cleaning up the cloud-run binary")
	_ = os.Remove("/tmp/paprika-cloud-run-e2e")
	_ = os.RemoveAll("/tmp/paprika-cloudrun-e2e-work")

	By("undeploying the controller-manager")
	cmd := exec.Command("make", "undeploy")
	_, _ = utils.Run(cmd)

	By("uninstalling CRDs")
	cmd = exec.Command("make", "uninstall")
	_, _ = utils.Run(cmd)

	By("removing manager namespace")
	cmd = exec.Command("kubectl", "delete", "ns", splitNamespace, "--ignore-not-found")
	_, _ = utils.Run(cmd)

	By("deleting the Kind cluster")
	cmd = exec.Command("kind", "delete", "cluster", "--name", splitClusterName)
	_, _ = utils.Run(cmd)
})

func waitForClusterReady() {
	By("waiting for Kind cluster to be ready")
	Eventually(func(g Gomega) {
		cmd := exec.Command("kubectl", "get", "--raw", "/healthz") //nolint:noctx // test utility
		_, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
	}, 2*time.Minute, 5*time.Second).Should(Succeed())

	By("waiting for default cluster roles to be bootstrapped")
	Eventually(func(g Gomega) {
		cmd := exec.Command("kubectl", "get", "clusterrole", "cluster-admin") //nolint:noctx // test utility
		_, err := utils.Run(cmd)
		g.Expect(err).NotTo(HaveOccurred())
	}, 2*time.Minute, 5*time.Second).Should(Succeed())
}

func kindClusterExists(name string) (bool, error) {
	cmd := exec.Command("kind", "get", "clusters") //nolint:noctx // test utility
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

func kindKubeconfig(cluster string) string {
	cmd := exec.Command("kind", "get", "kubeconfig", "--name", cluster) //nolint:noctx // test utility
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	f, err := os.CreateTemp("", "kind-kubeconfig-*")
	if err != nil {
		return ""
	}
	_, _ = f.Write(output)
	_ = f.Close()
	return f.Name()
}
