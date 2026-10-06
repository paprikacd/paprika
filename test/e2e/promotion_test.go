//go:build e2e
// +build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/test/utils"
)

const (
	promotionDevNS     = "e2e-promotion-dev"
	promotionStgNS     = "e2e-promotion-stg"
	promotionProdNS    = "e2e-promotion-prod"
	promotionFailedNS  = "e2e-promotion-failed"
	promotionDevApp    = "promotion-dev"
	promotionStgApp    = "promotion-stg"
	promotionProdApp   = "promotion-prod"
	promotionTestFail  = "promotion-test-failed"
	promotionGateFail  = "promotion-gate-failed"
	promotionBackend   = "e2e-promotion-git"
	promotionGitURL    = "http://e2e-promotion-git.paprika-system.svc:3000/test-repo.git"
	promotionGitPort   = "19001"
	promotionRemoteCR  = "e2e-promotion-remote"
	promotionMarker    = "e2e-promotion-marker"
	promotionProbeName = "e2e-promotion-app"
)

// Application refs are on the management cluster, while the registered direct
// Cluster routes staging/production manifests to another physical cluster.
// Set E2E_PROMOTION_REMOTE_KUBECONFIG to its internal kubeconfig for the manager,
// and E2E_PROMOTION_REMOTE_KUBECTL_KUBECONFIG to a host-reachable kubeconfig.
// Without these variables the same behavioral coverage runs on one Kind cluster.
var _ = Describe("ApplicationPromotion", Ordered, func() {
	var (
		fx             Fixture
		repoDir        string
		initialSHA     string
		secondSHA      string
		initialProdUID string
		failedPipeline string
		remoteConfig   string
		remote         bool
		devURL         string
		stgURL         string
		prodURL        string
	)

	BeforeAll(func() {
		By("confirming the management Kind context")
		current, err := utils.Kubectl("config", "current-context")
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(current)).To(Equal("kind-" + kindClusterName))

		remoteSecretConfig := os.Getenv("E2E_PROMOTION_REMOTE_KUBECONFIG")
		remote = remoteSecretConfig != ""
		remoteConfig = os.Getenv("E2E_PROMOTION_REMOTE_KUBECTL_KUBECONFIG")
		if remoteConfig == "" {
			remoteConfig = remoteSecretConfig
		}
		devURL = "http://" + promotionProbeName + "." + promotionDevNS + ".svc:8080/health"
		stgURL = "http://" + promotionProbeName + "." + promotionStgNS + ".svc:8080/health"
		prodURL = "http://" + promotionProbeName + "." + promotionProdNS + ".svc:8080/health"

		By("creating separate management namespaces and their default projects")
		for _, ns := range []string{promotionDevNS, promotionStgNS, promotionProdNS, promotionFailedNS} {
			fx.Apply(promotionJSON(map[string]any{
				"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": ns},
			}))
			fx.Apply(promotionJSON(map[string]any{
				"apiVersion": "core.paprika.io/v1alpha1", "kind": "AppProject",
				"metadata": map[string]any{"name": "default", "namespace": ns},
				"spec": map[string]any{"sourceRepos": []string{"*"}, "kinds": []string{"*"},
					"destinations": []map[string]string{{"server": "*", "namespace": "*"}}},
			}))
		}

		if remote {
			By("registering a second physical Kind cluster for staging and production")
			localUID, err := utils.Kubectl("get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}")
			Expect(err).NotTo(HaveOccurred())
			remoteUID, err := promotionTargetKubectl(remoteConfig, "get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}")
			Expect(err).NotTo(HaveOccurred())
			Expect(remoteUID).NotTo(BeEmpty())
			Expect(remoteUID).NotTo(Equal(localUID), "promotion target must be another physical cluster")
			for _, ns := range []string{promotionStgNS, promotionProdNS} {
				manifest := promotionJSON(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": ns}})
				out, err := promotionTargetApply(remoteConfig, manifest)
				Expect(err).NotTo(HaveOccurred(), "%s", out)
			}
			kubeconfig, err := os.ReadFile(remoteSecretConfig)
			Expect(err).NotTo(HaveOccurred())
			fx.Apply(promotionJSON(map[string]any{
				"apiVersion": "v1", "kind": "Secret",
				"metadata":   map[string]any{"name": promotionRemoteCR, "namespace": "paprika-system"},
				"stringData": map[string]string{"kubeconfig": string(kubeconfig)},
			}))
			fx.Apply(promotionJSON(map[string]any{
				"apiVersion": "clusters.paprika.io/v1alpha1", "kind": "Cluster",
				"metadata": map[string]any{"name": promotionRemoteCR, "namespace": "paprika-system"},
				"spec": map[string]any{"mode": "direct", "kubeconfigSecretRef": map[string]string{"name": promotionRemoteCR, "key": "kubeconfig"},
					"healthCheck": map[string]string{"interval": "5s", "timeout": "5s"}},
			}))
			ExpectPhaseEventually("paprika-system", "clusters.clusters.paprika.io", promotionRemoteCR, "{.status.phase}", "Healthy", 2*time.Minute)
			ip, err := promotionTargetKubectl(remoteConfig, "get", "nodes", "-o", `jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}`)
			Expect(err).NotTo(HaveOccurred())
			Expect(strings.TrimSpace(ip)).NotTo(BeEmpty())
			stgURL = "http://" + strings.TrimSpace(ip) + ":30587/health"
			prodURL = "http://" + strings.TrimSpace(ip) + ":30588/health"
			if override := os.Getenv("E2E_PROMOTION_REMOTE_PROBE_URL"); override != "" {
				stgURL = override
			}
		}

		By("loading an isolated Git backend into the management cluster")
		archive := filepath.Join(GinkgoT().TempDir(), "promotion-git-backend.tar")
		platform := "linux/arm64"
		if runtime.GOARCH == "amd64" {
			platform = "linux/amd64"
		}
		out, err := utils.Run(exec.Command("docker", "save", "--platform", platform, gitBackendImage, "-o", archive))
		Expect(err).NotTo(HaveOccurred(), "%s", out)
		out, err = utils.Run(exec.Command("kind", "load", "image-archive", archive, "--name", kindClusterName))
		Expect(err).NotTo(HaveOccurred(), "%s", out)
		fx.Apply(fmt.Sprintf(gitBackendDeployManifest, promotionBackend, promotionBackend, promotionBackend, gitBackendImage),
			fmt.Sprintf(gitBackendSvcManifest, promotionBackend, promotionBackend))
		Expect(utils.WaitAvailable("paprika-system", "deployment", promotionBackend, 3*time.Minute)).To(Succeed())
		pf, err := utils.StartPortForward("paprika-system", "svc/"+promotionBackend, promotionGitPort+":3000")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() { GinkgoWriter.Printf("promotion git port-forward: %s\n", pf.Stop()) })

		By("pushing environment Helm charts with a deployed HTTP version marker")
		repoDir = filepath.Join(GinkgoT().TempDir(), "repo")
		credURL := fmt.Sprintf("http://%s:%s@127.0.0.1:%s/test-repo.git", gitBackendUser, gitBackendPass, promotionGitPort)
		Eventually(func(g Gomega) {
			out, err := utils.Run(exec.Command("git", "ls-remote", credURL))
			g.Expect(err).NotTo(HaveOccurred(), "Git port-forward not ready: %s", out)
		}, 30*time.Second, 500*time.Millisecond).Should(Succeed())
		promotionGit("clone", credURL, repoDir)
		promotionGit("-C", repoDir, "checkout", "-B", "main")
		for _, env := range []string{"dev", "stg", "prod"} {
			promotionWriteChart(repoDir, env, "v1", remote)
		}
		initialSHA = promotionCommitAndPush(repoDir, "initial environments")

		for _, ns := range []string{promotionDevNS, promotionStgNS, promotionProdNS, promotionFailedNS} {
			fx.Apply(promotionJSON(map[string]any{
				"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": "promotion-creds", "namespace": ns},
				"stringData": map[string]string{"username": gitBackendUser, "password": gitBackendPass},
			}), promotionJSON(map[string]any{
				"apiVersion": "core.paprika.io/v1alpha1", "kind": "Repository", "metadata": map[string]any{"name": "promotion-source", "namespace": ns},
				"spec": map[string]any{"type": "git", "url": promotionGitURL, "secretRef": map[string]string{"name": "promotion-creds"}},
			}))
		}

		cluster := map[string]string{}
		if remote {
			cluster = map[string]string{"name": promotionRemoteCR, "namespace": "paprika-system"}
		}
		// Each source's own health probe follows its deployment cluster, while
		// trigger tests/gates probe the upstream environment being promoted.
		fx.Apply(promotionAppManifest(promotionDevNS, promotionDevApp, "dev", nil, false, nil, devURL, devURL, initialSHA, ""))
		fx.Apply(promotionAppManifest(promotionStgNS, promotionStgApp, "stg", &paprikav1.ApplicationReference{Name: promotionDevApp, Namespace: promotionDevNS}, false, cluster, devURL, stgURL, initialSHA, ""))
		fx.Apply(promotionAppManifest(promotionProdNS, promotionProdApp, "prod", &paprikav1.ApplicationReference{Name: promotionStgApp, Namespace: promotionStgNS}, true, cluster, stgURL, prodURL, initialSHA, ""))
		fx.Apply(promotionAppManifest(promotionFailedNS, promotionTestFail, "stg", &paprikav1.ApplicationReference{Name: promotionDevApp, Namespace: promotionDevNS}, false, nil, devURL, devURL, initialSHA, "tests"))
		fx.Apply(promotionAppManifest(promotionFailedNS, promotionGateFail, "stg", &paprikav1.ApplicationReference{Name: promotionDevApp, Namespace: promotionDevNS}, false, nil, devURL, devURL, initialSHA, "gate"))
	})

	AfterAll(func() {
		for _, app := range []struct{ ns, name string }{
			{promotionProdNS, promotionProdApp}, {promotionStgNS, promotionStgApp},
			{promotionFailedNS, promotionTestFail}, {promotionFailedNS, promotionGateFail}, {promotionDevNS, promotionDevApp},
		} {
			if CurrentSpecReport().Failed() {
				if current, err := promotionGetApp(app.ns, app.name); err == nil {
					GinkgoWriter.Printf("promotion failure status %s/%s: %s\n", app.ns, app.name, promotionJSON(current.Status))
				}
			}
			// Jobs execute in the operator namespace, even when their Pipeline is
			// owned by an Application in a different management namespace.
			out, err := utils.Kubectl("-n", app.ns, "get", "pipelines", "-l", "app.paprika.io/name="+app.name, "-o", "jsonpath={.items[*].metadata.name}")
			if err == nil {
				for _, name := range strings.Fields(out) {
					DeleteByLabel("paprika-system", "paprika.io/pipeline="+name, "jobs", "pods")
				}
			}
			promotionCleanupApp(app.ns, app.name)
		}
		fx.Teardown()
		if remote && remoteConfig != "" {
			for _, ns := range []string{promotionStgNS, promotionProdNS} {
				_, _ = promotionTargetKubectl(remoteConfig, "delete", "namespace", ns, "--ignore-not-found", "--wait=false")
			}
		}
	})

	It("promotes a healthy deployed SHA across namespaces and clusters after real verification jobs", func() {
		dev := promotionWaitHealthy(promotionDevNS, promotionDevApp, initialSHA)
		stg := promotionWaitHealthy(promotionStgNS, promotionStgApp, initialSHA)
		Expect(stg.Status.Promotion).NotTo(BeNil())
		Expect(stg.Status.Promotion.Phase).To(Equal("Complete"))
		promotionExpectProvenance(stg, dev)
		promotionExpectPipeline(stg, paprikav1.PipelineSucceeded)
		promotionExpectMarker("", promotionDevNS, "v1")
		promotionExpectMarker(remoteConfig, promotionStgNS, "v1")
		if remote {
			_, err := utils.Kubectl("-n", promotionStgNS, "get", "configmap", promotionMarker)
			Expect(err).To(HaveOccurred(), "staging resources must exist only on the remote cluster")
		}
		prod := promotionWaitCandidate(promotionProdNS, promotionProdApp, initialSHA, "AwaitingApproval")
		Expect(prod.Status.ReleaseRef).To(BeEmpty())
		Expect(prod.Status.SourceRevision).To(BeEmpty())
		initialProdUID = prod.Status.Promotion.SourceReleaseUID
		promotionExpectPipeline(prod, paprikav1.PipelineSucceeded)
	})

	It("requires approval of the exact upstream release and rejects manual-sync bypass", func() {
		promotionAnnotate(promotionProdNS, promotionProdApp, "paprika.io/promote=wrong-release", "paprika.io/manual-sync=attempt-initial", "paprika.io/sync=attempt-initial")
		Consistently(func(g Gomega) {
			prod, err := promotionGetApp(promotionProdNS, promotionProdApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(prod.Status.ReleaseRef).To(BeEmpty())
			g.Expect(prod.Status.SourceRevision).To(BeEmpty())
			g.Expect(prod.Status.Promotion).NotTo(BeNil())
			g.Expect(prod.Status.Promotion.Phase).To(BeElementOf("AwaitingApproval", "Verifying"))
			g.Expect(prod.Status.Promotion.SourceReleaseUID).To(Equal(initialProdUID))
			g.Expect(prod.Status.Promotion.Revision).To(Equal(initialSHA))
			_, err = promotionTargetKubectl(remoteConfig, "-n", promotionProdNS, "get", "configmap", promotionMarker)
			g.Expect(err).To(HaveOccurred())
		}, 12*time.Second, 2*time.Second).Should(Succeed())
		promotionWaitCandidate(promotionProdNS, promotionProdApp, initialSHA, "AwaitingApproval")
		promotionAnnotate(promotionProdNS, promotionProdApp, "paprika.io/promote="+initialProdUID)
		prod := promotionWaitHealthy(promotionProdNS, promotionProdApp, initialSHA)
		stg, err := promotionGetApp(promotionStgNS, promotionStgApp)
		Expect(err).NotTo(HaveOccurred())
		promotionExpectProvenance(prod, stg)
		Expect(prod.Annotations).NotTo(HaveKey("paprika.io/promote"))
		promotionExpectMarker(remoteConfig, promotionProdNS, "v1")
		if remote {
			_, err := utils.Kubectl("-n", promotionProdNS, "get", "configmap", promotionMarker)
			Expect(err).To(HaveOccurred(), "production resources must exist only on the remote cluster")
		}
	})

	It("latches failed tests and failed HTTP gates without creating releases", func() {
		failed := promotionWaitCandidate(promotionFailedNS, promotionTestFail, initialSHA, "Failed")
		Expect(failed.Status.ReleaseRef).To(BeEmpty())
		Expect(failed.Status.SourceRevision).To(BeEmpty())
		failedPipeline = failed.Status.Promotion.VerificationPipelineRef
		promotionExpectPipeline(failed, paprikav1.PipelineFailed)
		gateFailed := promotionWaitCandidate(promotionFailedNS, promotionGateFail, initialSHA, "Failed")
		Expect(gateFailed.Status.ReleaseRef).To(BeEmpty())
		promotionExpectPipeline(gateFailed, paprikav1.PipelineSucceeded)
		promotionAnnotate(promotionFailedNS, promotionTestFail, "paprika.io/manual-sync=retry-failed", "paprika.io/sync=retry-failed")
		Consistently(func(g Gomega) {
			app, err := promotionGetApp(promotionFailedNS, promotionTestFail)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(app.Status.ReleaseRef).To(BeEmpty())
			g.Expect(app.Status.Promotion.Phase).To(Equal("Failed"))
			g.Expect(app.Status.Promotion.VerificationPipelineRef).To(Equal(failedPipeline))
		}, 12*time.Second, 2*time.Second).Should(Succeed())
	})

	It("keeps downstream renders pinned when only their Git paths change", func() {
		By("changing production at Git HEAD without changing development's content")
		promotionWriteChart(repoDir, "prod", "git-only", remote)
		unpromotedSHA := promotionCommitAndPush(repoDir, "unpromoted production-only change")
		Expect(unpromotedSHA).NotTo(Equal(initialSHA))
		promotionAnnotate(promotionProdNS, promotionProdApp, "paprika.io/manual-sync=reapply-accepted", "paprika.io/sync=reapply-accepted")
		Consistently(func(g Gomega) {
			for _, app := range []struct{ ns, name string }{{promotionDevNS, promotionDevApp}, {promotionStgNS, promotionStgApp}, {promotionProdNS, promotionProdApp}} {
				current, err := promotionGetApp(app.ns, app.name)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(current.Status.SourceRevision).To(Equal(initialSHA))
				g.Expect(current.Status.Revision).To(Equal(initialSHA))
			}
			marker, err := promotionTargetKubectl(remoteConfig, "-n", promotionProdNS, "get", "configmap", promotionMarker, "-o", "jsonpath={.data.marker}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(marker).To(Equal("v1"))
		}, 25*time.Second, 2*time.Second).Should(Succeed())
	})

	It("verifies each new upstream release and keeps production on its previous approved SHA", func() {
		By("pushing a second version through the GitOps entry environment")
		for _, env := range []string{"dev", "stg", "prod"} {
			promotionWriteChart(repoDir, env, "v2", remote)
		}
		secondSHA = promotionCommitAndPush(repoDir, "second promoted environments")
		dev := promotionWaitHealthy(promotionDevNS, promotionDevApp, secondSHA)
		stg := promotionWaitHealthy(promotionStgNS, promotionStgApp, secondSHA)
		promotionExpectProvenance(stg, dev)
		promotionExpectPipeline(stg, paprikav1.PipelineSucceeded)
		promotionExpectMarker(remoteConfig, promotionStgNS, "v2")
		prod := promotionWaitCandidate(promotionProdNS, promotionProdApp, secondSHA, "AwaitingApproval")
		previousRelease := prod.Status.ReleaseRef
		currentCandidateUID := prod.Status.Promotion.SourceReleaseUID
		Expect(prod.Status.SourceRevision).To(Equal(initialSHA))
		Expect(prod.Status.Revision).To(Equal(initialSHA))
		Expect(prod.Status.Promotion.SourceReleaseUID).NotTo(Equal(initialProdUID))
		promotionAnnotate(promotionProdNS, promotionProdApp, "paprika.io/promote="+initialProdUID, "paprika.io/manual-sync=old-approval", "paprika.io/sync=old-approval")
		Consistently(func(g Gomega) {
			current, err := promotionGetApp(promotionProdNS, promotionProdApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.Promotion).NotTo(BeNil())
			g.Expect(current.Status.Promotion.Phase).To(BeElementOf("AwaitingApproval", "Verifying"))
			g.Expect(current.Status.Promotion.Revision).To(Equal(secondSHA))
			g.Expect(current.Status.Promotion.SourceReleaseUID).To(Equal(currentCandidateUID))
			g.Expect(current.Status.ReleaseRef).To(Equal(previousRelease))
			g.Expect(current.Status.SourceRevision).To(Equal(initialSHA))
			g.Expect(current.Status.Revision).To(Equal(initialSHA))
			marker, err := promotionTargetKubectl(remoteConfig, "-n", promotionProdNS, "get", "configmap", promotionMarker, "-o", "jsonpath={.data.marker}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(marker).To(Equal("v1"))
		}, 12*time.Second, 2*time.Second).Should(Succeed())
		promotionWaitCandidate(promotionProdNS, promotionProdApp, secondSHA, "AwaitingApproval")
		failed := promotionWaitCandidate(promotionFailedNS, promotionTestFail, secondSHA, "Failed")
		Expect(failed.Status.Promotion.VerificationPipelineRef).NotTo(Equal(failedPipeline))
		Expect(failed.Status.ReleaseRef).To(BeEmpty())
		promotionExpectPipeline(failed, paprikav1.PipelineFailed)
		promotionAnnotate(promotionProdNS, promotionProdApp, "paprika.io/promote="+prod.Status.Promotion.SourceReleaseUID)
		approved := promotionWaitHealthy(promotionProdNS, promotionProdApp, secondSHA)
		promotionExpectProvenance(approved, stg)
		promotionExpectPipeline(approved, paprikav1.PipelineSucceeded)
		promotionExpectMarker(remoteConfig, promotionProdNS, "v2")
	})

	It("drains production releases and remote resources on normal Application deletion", func() {
		prod := promotionWaitHealthy(promotionProdNS, promotionProdApp, secondSHA)
		Expect(prod.UID).NotTo(BeEmpty())
		out, err := utils.Kubectl("-n", promotionProdNS, "get", "releases", "-o", "json")
		Expect(err).NotTo(HaveOccurred())
		var releases paprikav1.ReleaseList
		Expect(json.Unmarshal([]byte(out), &releases)).To(Succeed())
		owned := []string{}
		for _, release := range releases.Items {
			for _, owner := range release.OwnerReferences {
				if owner.UID == prod.UID && owner.Kind == "Application" {
					owned = append(owned, release.Name)
				}
			}
		}
		Expect(owned).To(ContainElement(prod.Status.ReleaseRef), "the assertion must delete a real UID-owned deployed Release")
		// Pipeline CRs disappear with normal Application garbage collection;
		// retain their names so fixture teardown can remove operator-side Jobs.
		pipelines, err := utils.Kubectl("-n", promotionProdNS, "get", "pipelines", "-l", "app.paprika.io/name="+promotionProdApp, "-o", "jsonpath={.items[*].metadata.name}")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() {
			for _, name := range strings.Fields(pipelines) {
				DeleteByLabel("paprika-system", "paprika.io/pipeline="+name, "jobs", "pods")
			}
		})

		By("deleting production with ordinary background garbage collection")
		out, err = utils.Kubectl("-n", promotionProdNS, "delete", "application", promotionProdApp, "--cascade=background", "--wait=false")
		Expect(err).NotTo(HaveOccurred(), "%s", out)
		Eventually(func(g Gomega) {
			remaining, err := utils.Kubectl("-n", promotionProdNS, "get", "application", promotionProdApp, "--ignore-not-found", "-o", "name")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(remaining)).To(BeEmpty(), "Application finalizer must drain remote Releases")
			out, err := utils.Kubectl("-n", promotionProdNS, "get", "releases", "-o", "json")
			g.Expect(err).NotTo(HaveOccurred())
			var current paprikav1.ReleaseList
			g.Expect(json.Unmarshal([]byte(out), &current)).To(Succeed())
			for _, release := range current.Items {
				g.Expect(owned).NotTo(ContainElement(release.Name), "previous UID-owned Release must finish cleanup")
				for _, owner := range release.OwnerReferences {
					g.Expect(owner.UID).NotTo(Equal(prod.UID))
				}
			}
			for _, object := range []string{"configmap/" + promotionMarker, "deployment/" + promotionProbeName, "service/" + promotionProbeName} {
				remaining, err := promotionTargetKubectl(remoteConfig, "-n", promotionProdNS, "get", object, "--ignore-not-found", "-o", "name")
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(strings.TrimSpace(remaining)).To(BeEmpty(), "%s must be deleted on the deployment cluster", object)
			}
		}, 2*time.Minute, 2*time.Second).Should(Succeed())
		if remote {
			// The fixture still owns the transport; deleting the Application must
			// perform release cleanup before any remote credentials are removed.
			_, err := utils.Kubectl("-n", "paprika-system", "get", "clusters.clusters.paprika.io", promotionRemoteCR)
			Expect(err).NotTo(HaveOccurred())
			_, err = utils.Kubectl("-n", "paprika-system", "get", "secret", promotionRemoteCR, "-o", "name")
			Expect(err).NotTo(HaveOccurred())
		}
	})
})

func promotionJSON(value any) string {
	data, err := json.Marshal(value)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	return string(data)
}

func promotionTargetKubectl(kubeconfig string, args ...string) (string, error) {
	if kubeconfig != "" {
		args = append([]string{"--kubeconfig", kubeconfig}, args...)
	}
	return utils.Kubectl(args...)
}

func promotionTargetApply(kubeconfig, manifest string) (string, error) {
	cmd := exec.Command("kubectl", "--kubeconfig", kubeconfig, "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	return utils.Run(cmd)
}

// Orphan the derived CRs when stopping the Application, so its Stage and remote
// credentials remain available while Release finalizers delete live resources.
// Only leftovers carrying this fixture's app label have finalizers stripped.
func promotionCleanupApp(namespace, name string) {
	selector := "app.paprika.io/name=" + name
	_, _ = utils.Kubectl("-n", namespace, "delete", "application", name, "--cascade=orphan", "--ignore-not-found", "--wait=false")
	_, _ = utils.Kubectl("-n", namespace, "delete", "releases", "-l", selector, "--ignore-not-found", "--wait=false")
	_, _ = utils.Kubectl("-n", namespace, "wait", "--for=delete", "releases", "-l", selector, "--timeout=20s")
	for _, kind := range []string{"releases", "pipelines", "stages", "templates"} {
		out, err := utils.Kubectl("-n", namespace, "get", kind, "-l", selector, "-o", "name")
		if err == nil {
			for _, object := range strings.Fields(out) {
				_, _ = utils.Kubectl("-n", namespace, "patch", object, "--type=merge", "-p", `{"metadata":{"finalizers":[]}}`)
			}
		}
	}
	DeleteByLabel(namespace, selector, "releases", "pipelines", "stages", "templates", "deployments", "services", "ingresses", "configmaps", "jobs", "pods")
}

func promotionGit(args ...string) string {
	out, err := utils.Run(exec.Command("git", args...))
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "%s", out)
	return strings.TrimSpace(out)
}

func promotionCommitAndPush(repoDir, message string) string {
	promotionGit("-C", repoDir, "add", "charts")
	promotionGit("-C", repoDir, "-c", "user.name=promotion-e2e", "-c", "user.email=promotion@e2e.test", "commit", "-m", message)
	promotionGit("-C", repoDir, "push", "origin", "main")
	sha := promotionGit("-C", repoDir, "rev-parse", "HEAD")
	ExpectWithOffset(1, sha).To(MatchRegexp("^[a-f0-9]{40}$"))
	return sha
}

func promotionWriteChart(repoDir, environment, marker string, remote bool) {
	dir := filepath.Join(repoDir, "charts", environment)
	ExpectWithOffset(1, os.MkdirAll(filepath.Join(dir, "templates"), 0o755)).To(Succeed())
	ExpectWithOffset(1, os.WriteFile(filepath.Join(dir, "Chart.yaml"), []byte("apiVersion: v2\nname: promotion-"+environment+"\nversion: 0.1.0\n"), 0o600)).To(Succeed())
	nodePort := 0
	if remote && environment == "stg" {
		nodePort = 30587
	}
	if remote && environment == "prod" {
		nodePort = 30588
	}
	values := fmt.Sprintf("marker: %q\nimage: %q\nnodePort: %d\n", marker, demoImage, nodePort)
	ExpectWithOffset(1, os.WriteFile(filepath.Join(dir, "values.yaml"), []byte(values), 0o600)).To(Succeed())
	ExpectWithOffset(1, os.WriteFile(filepath.Join(dir, "templates", "app.yaml"), []byte(promotionChart), 0o600)).To(Succeed())
}

func promotionHealthChecks(url string) []map[string]any {
	return []map[string]any{{"name": "deployed-http", "expression": "http.statusCode == 200", "interval": "2s",
		"httpProbe": map[string]any{"url": url, "timeout": 5, "expectedStatus": 200}}}
}

func promotionAppManifest(namespace, name, environment string, from *paprikav1.ApplicationReference, manual bool, cluster map[string]string, upstreamURL, healthURL, initialSHA, failure string) string {
	stage := map[string]any{"name": environment, "ring": 1}
	if len(cluster) > 0 {
		stage["cluster"] = cluster
	}
	spec := map[string]any{
		"project": "default", "source": map[string]any{"type": "git", "repoRef": "promotion-source", "revision": "main", "path": "charts/" + environment,
			"targetNamespace": namespace, "pollInterval": "5s"},
		"stages": []map[string]any{stage}, "syncPolicy": "Auto", "healthChecks": promotionHealthChecks(healthURL),
		"trigger": map[string]any{"type": "GitOps"},
	}
	if manual {
		spec["syncPolicy"] = "Manual"
	}
	if from != nil {
		// The fixture's only two accepted deployment versions are v1 and v2.
		// This checks the real upstream body against the immutable candidate SHA,
		// so a healthy endpoint serving the wrong version fails verification.
		script := fmt.Sprintf(`set -eu
test "${#PAPRIKA_PROMOTION_REVISION}" -eq 40
test "$PAPRIKA_PROMOTION_SOURCE_APPLICATION" = '%s'
test "$PAPRIKA_PROMOTION_SOURCE_NAMESPACE" = '%s'
test -n "$PAPRIKA_PROMOTION_SOURCE_RELEASE"
case "$PAPRIKA_PROMOTION_REVISION" in '%s') expected=v1 ;; *) expected=v2 ;; esac
actual="$(wget -qO- -T 5 '%s')"
test "$actual" = "$expected"
`, from.Name, from.Namespace, initialSHA, upstreamURL)
		if failure == "tests" {
			script += "echo intentionally-rejected-promotion\nexit 9\n"
		}
		gates := []map[string]any{{"type": "smoke-test", "endpoint": upstreamURL, "timeout": 5}, {"type": "duration", "timeout": 1}}
		if failure == "gate" {
			gates[0]["endpoint"] = "http://" + promotionProbeName + "." + promotionDevNS + ".svc:1/health"
		}
		spec["trigger"] = map[string]any{"type": "Promotion", "from": from,
			"tests": map[string]any{"steps": []map[string]any{{"name": "verify-upstream", "image": "alpine:3.19", "script": script, "timeout": 30}}}, "gates": gates}
	}
	return promotionJSON(map[string]any{"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Application", "metadata": map[string]any{"name": name, "namespace": namespace}, "spec": spec})
}

func promotionGetApp(namespace, name string) (*paprikav1.Application, error) {
	out, err := utils.Kubectl("-n", namespace, "get", "application", name, "-o", "json")
	if err != nil {
		return nil, err
	}
	var app paprikav1.Application
	if err := json.Unmarshal([]byte(out), &app); err != nil {
		return nil, err
	}
	return &app, nil
}

func promotionWaitHealthy(namespace, name, sha string) *paprikav1.Application {
	var app *paprikav1.Application
	EventuallyWithOffset(1, func(g Gomega) {
		current, err := promotionGetApp(namespace, name)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(current.Status.Phase).To(Equal(paprikav1.ApplicationHealthy), "status: %s", promotionJSON(current.Status))
		g.Expect(current.Status.Revision).To(Equal(sha))
		g.Expect(current.Status.SourceRevision).To(Equal(sha))
		g.Expect(current.Status.OutOfSync).To(BeZero())
		g.Expect(current.Status.DeploymentObservation).NotTo(BeNil())
		g.Expect(current.Status.DeploymentObservation.Revision).To(Equal(sha))
		app = current
	}, 5*time.Minute, 3*time.Second).Should(Succeed())
	return app
}

func promotionWaitCandidate(namespace, name, sha, phase string) *paprikav1.Application {
	var app *paprikav1.Application
	EventuallyWithOffset(1, func(g Gomega) {
		current, err := promotionGetApp(namespace, name)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(current.Status.Promotion).NotTo(BeNil(), "status: %s", promotionJSON(current.Status))
		g.Expect(current.Status.Promotion.Revision).To(Equal(sha))
		g.Expect(current.Status.Promotion.Phase).To(Equal(phase), "status: %s", promotionJSON(current.Status))
		app = current
	}, 5*time.Minute, 3*time.Second).Should(Succeed())
	return app
}

func promotionAnnotate(namespace, name string, values ...string) {
	args := append([]string{"-n", namespace, "annotate", "application", name, "--overwrite"}, values...)
	out, err := utils.Kubectl(args...)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "%s", out)
}

func promotionExpectMarker(kubeconfig, namespace, marker string) {
	EventuallyWithOffset(1, func(g Gomega) {
		actual, err := promotionTargetKubectl(kubeconfig, "-n", namespace, "get", "configmap", promotionMarker, "-o", "jsonpath={.data.marker}")
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(actual).To(Equal(marker))
	}, 2*time.Minute, time.Second).Should(Succeed())
}

func promotionExpectProvenance(app, source *paprikav1.Application) {
	ExpectWithOffset(1, app.Status.Promotion).NotTo(BeNil())
	ExpectWithOffset(1, app.Status.Promotion.SourceApplication).To(Equal(paprikav1.ApplicationReference{Name: source.Name, Namespace: source.Namespace}))
	ExpectWithOffset(1, app.Status.Promotion.SourceApplicationUID).To(Equal(string(source.UID)))
	ExpectWithOffset(1, app.Status.Promotion.SourceRelease).To(Equal(source.Status.ReleaseRef))
	ExpectWithOffset(1, app.Status.Promotion.Revision).To(Equal(source.Status.Revision))
	out, err := utils.Kubectl("-n", app.Namespace, "get", "release", app.Status.ReleaseRef, "-o", "json")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	var release paprikav1.Release
	ExpectWithOffset(1, json.Unmarshal([]byte(out), &release)).To(Succeed())
	ExpectWithOffset(1, release.Status.Phase).To(Equal(paprikav1.ReleaseComplete))
	ExpectWithOffset(1, release.Annotations["paprika.io/source-revision"]).To(Equal(source.Status.Revision))
	ExpectWithOffset(1, release.Annotations["paprika.io/promotion-source-application"]).To(Equal(source.Name))
	ExpectWithOffset(1, release.Annotations["paprika.io/promotion-source-namespace"]).To(Equal(source.Namespace))
	ExpectWithOffset(1, release.Annotations["paprika.io/promotion-source-uid"]).To(Equal(string(source.UID)))
	ExpectWithOffset(1, release.Annotations["paprika.io/promotion-release-uid"]).To(Equal(app.Status.Promotion.SourceReleaseUID))
	ExpectWithOffset(1, release.Annotations["paprika.io/promotion-verification-config"]).To(Equal(app.Status.Promotion.VerificationConfigHash))
	uid, err := utils.Kubectl("-n", source.Namespace, "get", "release", source.Status.ReleaseRef, "-o", "jsonpath={.metadata.uid}")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, app.Status.Promotion.SourceReleaseUID).To(Equal(strings.TrimSpace(uid)))
}

func promotionExpectPipeline(app *paprikav1.Application, phase paprikav1.PipelinePhase) {
	ExpectWithOffset(1, app.Status.Promotion.VerificationPipelineRef).NotTo(BeEmpty())
	out, err := utils.Kubectl("-n", app.Namespace, "get", "pipeline", app.Status.Promotion.VerificationPipelineRef, "-o", "json")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	var pipeline paprikav1.Pipeline
	ExpectWithOffset(1, json.Unmarshal([]byte(out), &pipeline)).To(Succeed())
	ExpectWithOffset(1, pipeline.Status.Phase).To(Equal(phase))
	ExpectWithOffset(1, pipeline.Annotations["paprika.io/source-revision"]).To(Equal(app.Status.Promotion.Revision))
	ExpectWithOffset(1, pipeline.Annotations["paprika.io/promotion-source-uid"]).To(Equal(app.Status.Promotion.SourceApplicationUID))
	ExpectWithOffset(1, pipeline.Annotations["paprika.io/promotion-release-uid"]).To(Equal(app.Status.Promotion.SourceReleaseUID))
	ExpectWithOffset(1, pipeline.OwnerReferences).To(HaveLen(1))
	ExpectWithOffset(1, pipeline.OwnerReferences[0].UID).To(Equal(app.UID))
	// A terminal Pipeline must correspond to an actual Job on the management
	// cluster, rather than mocked status or a job created on the target cluster.
	jobs, err := utils.Kubectl("-n", "paprika-system", "get", "jobs", "-l", "paprika.io/pipeline="+pipeline.Name, "-o", "jsonpath={.items[*].metadata.name}")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, strings.TrimSpace(jobs)).NotTo(BeEmpty())
}

const promotionChart = `apiVersion: v1
kind: ConfigMap
metadata:
  name: e2e-promotion-marker
  namespace: {{ .Release.Namespace }}
data:
  marker: {{ .Values.marker | quote }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: e2e-promotion-app
  namespace: {{ .Release.Namespace }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: e2e-promotion-app
  template:
    metadata:
      labels:
        app: e2e-promotion-app
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          image: {{ .Values.image | quote }}
          imagePullPolicy: Never
          args:
            - --app-version={{ .Values.marker }}
            - --health-body={{ .Values.marker }}
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
---
apiVersion: v1
kind: Service
metadata:
  name: e2e-promotion-app
  namespace: {{ .Release.Namespace }}
spec:
  selector:
    app: e2e-promotion-app
{{- if .Values.nodePort }}
  type: NodePort
{{- end }}
  ports:
    - port: 8080
      targetPort: 8080
{{- if .Values.nodePort }}
      nodePort: {{ .Values.nodePort }}
{{- end }}
`
