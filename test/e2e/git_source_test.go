//go:build e2e
// +build e2e

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

// The backend pod carries full restricted-mode securityContext —
// paprika-system enforces PodSecurity restricted.
//
// Git-source coverage against a real smart-HTTP git server
// (castlemilk/git-http-backend) running inside the cluster. This exercises
// the full production path — Repository credential resolution, GitSource
// mirror+worktree resolution over HTTP, Helm render, release apply — which
// local-path fixtures cannot cover (the distroless release image once broke
// this whole path by shipping no git binary).
const (
	gitBackendName   = "e2e-git-backend"
	gitBackendImage  = "castlemilk/git-http-backend"
	gitBackendUser   = "testuser"
	gitBackendPass   = "testpass"
	gitBackendInURL  = "http://e2e-git-backend.paprika-system.svc:3000/test-repo.git"
	gitBackendPFPort = "19000"
	gitE2EAppName    = "e2e-git-app"
	gitE2ERepoName   = "e2e-git-repo"
	gitE2ESecretName = "e2e-git-creds"
)

const gitBackendDeployManifest = `{
	"apiVersion": "apps/v1", "kind": "Deployment",
	"metadata": {"name": "%s", "namespace": "paprika-system"},
	"spec": {
		"replicas": 1,
		"selector": {"matchLabels": {"app": "%s"}},
		"template": {
			"metadata": {"labels": {"app": "%s"}},
			"spec": {
				"securityContext": {
					"runAsNonRoot": true,
					"runAsUser": 65532,
					"fsGroup": 65532,
					"seccompProfile": {"type": "RuntimeDefault"}
				},
				"containers": [{
					"name": "git-http",
					"image": "%s",
					"imagePullPolicy": "IfNotPresent",
					"ports": [{"containerPort": 3000}],
				"env": [{"name": "HOME", "value": "/tmp"}],
					"securityContext": {
						"allowPrivilegeEscalation": false,
						"capabilities": {"drop": ["ALL"]},
						"runAsNonRoot": true,
						"seccompProfile": {"type": "RuntimeDefault"}
					}
				}]
			}
		}
	}
}`

const gitBackendSvcManifest = `{
	"apiVersion": "v1", "kind": "Service",
	"metadata": {"name": "%s", "namespace": "paprika-system"},
	"spec": {
		"selector": {"app": "%s"},
		"ports": [{"port": 3000, "targetPort": 3000}]
	}
}`

var _ = Describe("GitSourceHTTP", Ordered, func() {
	SetDefaultEventuallyTimeout(3 * time.Minute)
	SetDefaultEventuallyPollingInterval(time.Second)

	var (
		workDir string
		fx      Fixture
	)

	BeforeAll(func() {
		By("loading the git backend image into kind")
		cluster := os.Getenv("E2E_KIND_CLUSTER")
		if cluster == "" {
			cluster = "paprika-test-e2e"
		}
		// kind load docker-image fails on this image's OCI index
		// attestations; exporting the host-platform archive avoids the
		// "content digest not found" import error.
		archive := filepath.Join(GinkgoT().TempDir(), "git-backend.tar")
		platform := "linux/arm64"
		if runtime.GOARCH == "amd64" {
			platform = "linux/amd64"
		}
		out, err := utils.Run(exec.Command("docker", "save",
			"--platform", platform, gitBackendImage, "-o", archive))
		Expect(err).NotTo(HaveOccurred(), "docker save: %s", out)
		out, err = utils.Run(exec.Command("kind", "load", "image-archive",
			archive, "--name", cluster))
		Expect(err).NotTo(HaveOccurred(), "kind load: %s", out)

		By("deploying the in-cluster HTTP git backend")
		fx.Apply(
			fmt.Sprintf(gitBackendDeployManifest,
				gitBackendName, gitBackendName, gitBackendName, gitBackendImage),
			fmt.Sprintf(gitBackendSvcManifest, gitBackendName, gitBackendName),
		)

		// Pod-level wait (not rollout status) so failure diagnostics include
		// the container state — the import can lag on fresh kind nodes.
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("-n", "paprika-system",
				"get", "pod", "-l", "app="+gitBackendName,
				"-o", "jsonpath={.items[0].status.containerStatuses[0].ready}")
			if err == nil && out == "true" {
				return
			}
			desc, _ := utils.Kubectl("-n", "paprika-system",
				"describe", "pod", "-l", "app="+gitBackendName)
			deployDesc, _ := utils.Kubectl("-n", "paprika-system",
				"describe", "deploy", gitBackendName)
			rsDesc, _ := utils.Kubectl("-n", "paprika-system",
				"describe", "rs", "-l", "app="+gitBackendName)
			g.Expect(err).ToNot(HaveOccurred())
			g.Expect(out).To(Equal("true"),
				"backend pod not ready:\nPODS: %s\nDEPLOY: %s\nRS: %s", desc, deployDesc, rsDesc)
		}, 4*time.Minute, 5*time.Second).Should(Succeed())

		By("starting a port-forward to push test content")
		pf, err := utils.StartPortForward("paprika-system",
			"svc/"+gitBackendName, gitBackendPFPort+":3000")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() {
			GinkgoWriter.Printf("port-forward log: %s\n", pf.Stop())
		})

		By("pushing a helm chart to the backend")
		workDir = GinkgoT().TempDir()
		credURL := fmt.Sprintf("http://%s:%s@127.0.0.1:%s/test-repo.git",
			gitBackendUser, gitBackendPass, gitBackendPFPort)
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("git", "clone", credURL,
				filepath.Join(workDir, "repo")))
			g.Expect(err).NotTo(HaveOccurred(), "clone: %s", out)
		}, 30*time.Second, 2*time.Second).Should(Succeed())

		repoDir := filepath.Join(workDir, "repo")
		pushGitChart(repoDir, "v1")
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("git", "-C", repoDir,
				"push", "origin", "main"))
			g.Expect(err).NotTo(HaveOccurred(), "push: %s", out)
		}, 30*time.Second, 2*time.Second).Should(Succeed())

		By("creating credentials secret, Repository, and Application")
		objects := []string{
			fmt.Sprintf(`{
				"apiVersion": "v1", "kind": "Secret",
				"metadata": {"name": "%s", "namespace": "paprika-system"},
				"stringData": {"username": "%s", "password": "%s"}
			}`, gitE2ESecretName, gitBackendUser, gitBackendPass),
			fmt.Sprintf(`{
				"apiVersion": "core.paprika.io/v1alpha1", "kind": "Repository",
				"metadata": {"name": "%s", "namespace": "paprika-system"},
				"spec": {
					"type": "git",
					"url": "%s",
					"secretRef": {"name": "%s"}
				}
			}`, gitE2ERepoName, gitBackendInURL, gitE2ESecretName),
			fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Application",
				"metadata": {"name": "%s", "namespace": "paprika-system"},
				"spec": {
					"source": {
						"type": "git",
						"repoRef": "%s",
						"path": "charts/e2e-git-app",
						"targetNamespace": "paprika-system",
						"pollInterval": "5s"
					},
					"stages": [{"name": "dev", "ring": 1}]
				}
			}`, gitE2EAppName, gitE2ERepoName),
		}
		fx.Apply(objects...)
	})

	AfterAll(func() {
		By("cleaning up git source e2e resources")
		DeleteByLabel("paprika-system", "app.paprika.io/application="+gitE2EAppName, "releases")
		DeleteByLabel("paprika-system", "e2e=git-source", "configmaps")
		fx.Teardown()
	})

	It("converges the git-source application through the full pipeline", func() {
		By("waiting for the application to become Healthy")
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "application", gitE2EAppName,
				"-o", "jsonpath={.status.phase}"))
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("Healthy"))
		}).Should(Succeed())

		By("verifying the rendered ConfigMap was applied")
		out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
			"get", "configmap", "e2e-git-marker",
			"-o", "jsonpath={.data.marker}"))
		Expect(err).NotTo(HaveOccurred())
		Expect(out).To(Equal("v1"))
	})

	It("tracks a pushed commit and re-applies", func() {
		repoDir := filepath.Join(workDir, "repo")
		By("pushing a second revision")
		pushGitChart(repoDir, "v2")
		cmd := exec.Command("git", "-C", repoDir, "push", "origin", "main")
		out, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "push: %s", out)

		By("verifying the new revision rolls out")
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "configmap", "e2e-git-marker",
				"-o", "jsonpath={.data.marker}"))
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("v2"))
		}).Should(Succeed())

		By("verifying the application converges Healthy again")
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "application", gitE2EAppName,
				"-o", "jsonpath={.status.phase}"))
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("Healthy"))
		}).Should(Succeed())
	})

	It("reconverges cleanly after the manager is killed mid-apply", func() {
		repoDir := filepath.Join(workDir, "repo")

		By("recording the current manager pod")
		out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
			"get", "pods", "-l", "control-plane=controller-manager",
			"-o", "jsonpath={.items[0].metadata.name}"))
		Expect(err).NotTo(HaveOccurred())
		oldPod := strings.TrimSpace(out)
		Expect(oldPod).NotTo(BeEmpty(), "no manager pod found")

		By("pushing a third revision to trigger a new release")
		pushGitChart(repoDir, "v3")
		cmd := exec.Command("git", "-C", repoDir, "push", "origin", "main")
		out, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "push: %s", out)

		By("killing the manager the moment the new release flow starts")
		// The apply itself is ms-scale — force-killing the pod as soon as the
		// app leaves Healthy is the practical approximation of a mid-apply
		// crash. The assertion is what matters: nothing may corrupt.
		deadline := time.Now().Add(2 * time.Minute)
		for time.Now().Before(deadline) {
			out, _ := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "application", gitE2EAppName,
				"-o", "jsonpath={.status.phase}"))
			if strings.TrimSpace(out) != "Healthy" {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		cmd = exec.Command("kubectl", "-n", "paprika-system", "delete", "pod", oldPod,
			"--force", "--grace-period=0")
		out, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "kill manager pod: %s", out)

		By("waiting for the manager to come back")
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "deployment", "paprika-controller-manager",
				"-o", "jsonpath={.status.availableReplicas}"))
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(out)).To(Equal("1"))
		}).WithTimeout(3 * time.Minute).Should(Succeed())

		By("verifying the app converges Healthy with the new marker")
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "configmap", "e2e-git-marker",
				"-o", "jsonpath={.data.marker}"))
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("v3"))
		}).WithTimeout(3 * time.Minute).Should(Succeed())

		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("kubectl", "-n", "paprika-system",
				"get", "application", gitE2EAppName,
				"-o", "jsonpath={.status.phase}"))
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("Healthy"))
		}).WithTimeout(2 * time.Minute).Should(Succeed())

		By("verifying no resources were duplicated or orphaned")
		out, err = utils.Run(exec.Command("kubectl", "-n", "paprika-system",
			"get", "configmaps", "-l", "e2e=git-source",
			"-o", "jsonpath={.items[*].metadata.name}"))
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.Fields(out)).To(HaveLen(1), "expected exactly one marker configmap, got: %s", out)
	})
})

// pushGitChart writes a minimal chart whose ConfigMap carries a version
// marker, then commits it (uncommitted until the caller pushes).
func pushGitChart(repoDir, marker string) {
	chartDir := filepath.Join(repoDir, "charts", "e2e-git-app")
	Expect(os.MkdirAll(filepath.Join(chartDir, "templates"), 0o755)).To(Succeed())

	chartYAML := "apiVersion: v2\nname: e2e-git-app\nversion: 0.0.1\n"
	Expect(os.WriteFile(filepath.Join(chartDir, "Chart.yaml"),
		[]byte(chartYAML), 0o644)).To(Succeed())

	cm := fmt.Sprintf(`apiVersion: v1
kind: ConfigMap
metadata:
  name: e2e-git-marker
  labels:
    e2e: git-source
data:
  marker: "%s"
`, marker)
	Expect(os.WriteFile(filepath.Join(chartDir, "templates", "configmap.yaml"),
		[]byte(cm), 0o644)).To(Succeed())

	cmd := exec.Command("git", "-C", repoDir, "add", "charts/e2e-git-app")
	out, err := utils.Run(cmd)
	Expect(err).NotTo(HaveOccurred(), "git add: %s", out)

	cmd = exec.Command("git", "-C", repoDir,
		"-c", "user.email=e2e@test", "-c", "user.name=e2e",
		"commit", "-m", "marker "+marker)
	out, err = utils.Run(cmd)
	if err != nil && !strings.Contains(out, "nothing to commit") {
		Expect(err).NotTo(HaveOccurred(), "git commit: %s", out)
	}
}
