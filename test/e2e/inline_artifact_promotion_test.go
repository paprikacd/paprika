//go:build e2e
// +build e2e

package e2e

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/test/utils"
)

const (
	inlineSourceNS      = "e2e-inline-source"
	inlineTargetNS      = "e2e-inline-tenant"
	inlineBadImageNS    = "e2e-inline-bad-image"
	inlineBadRevisionNS = "e2e-inline-bad-revision"
	inlinePendingNS     = "e2e-inline-pending"
	inlineDuplicateNS   = "e2e-inline-duplicate"
	inlineRetryNS       = "e2e-inline-retry"
	inlineWindowNS      = "e2e-inline-window"
	inlineSourceApp     = "artifact-source"
	inlineTargetApp     = "artifact-tenant"
	inlineRevision      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	// BusyBox 1.37.0 multiarch index; both amd64 and arm64 kind workers use this exact ref.
	inlineArtifactImage = "docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
)

var _ = Describe("InlineArtifactPromotion", Ordered, func() {
	var fx Fixture
	var source *api.Application
	var acceptedUID string

	BeforeAll(func() {
		current, err := utils.Kubectl("config", "current-context")
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(current)).To(Equal("kind-" + kindClusterName))
		for _, ns := range []string{inlineSourceNS, inlineTargetNS, inlineBadImageNS, inlineBadRevisionNS, inlinePendingNS, inlineDuplicateNS, inlineRetryNS, inlineWindowNS} {
			fx.Apply(promotionJSON(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": ns}}))
			fx.Apply(promotionJSON(map[string]any{"apiVersion": "core.paprika.io/v1alpha1", "kind": "AppProject", "metadata": map[string]any{"name": "default", "namespace": ns}, "spec": map[string]any{"sourceRepos": []string{"https://example.test/sfh.git"}, "kinds": []string{"*"}, "destinations": []map[string]string{{"server": "*", "namespace": "*"}}}}))
		}
		By("publishing the upstream's own immutable reviewed bundle through the external-publisher flow")
		payload := inlinePromotionPayload(inlineSourceNS, "dev", "next.example.test", inlineArtifactImage)
		fx.Apply(inlinePromotionSnapshot(inlineSourceNS, "bundle-v1", payload))
		fx.Apply(inlinePromotionApp(inlineSourceNS, inlineSourceApp, "bundle-v1", inlineRevision, "next.example.test", false))
		inlinePromotionOwnSnapshot(inlineSourceNS, inlineSourceApp, "bundle-v1")
		Eventually(func(g Gomega) {
			_, err := utils.Kubectl("-n", inlineSourceNS, "get", "stages.pipelines.paprika.io", inlineSourceApp+"-development")
			g.Expect(err).NotTo(HaveOccurred())
		}, time.Minute, time.Second).Should(Succeed())
		source, err = promotionGetApp(inlineSourceNS, inlineSourceApp)
		Expect(err).NotTo(HaveOccurred())
		hash := sha256.Sum256([]byte(payload))
		releaseName := "artifact-source-release-v1"
		fx.Apply(promotionJSON(map[string]any{
			"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Release",
			"metadata": map[string]any{"name": releaseName, "namespace": inlineSourceNS,
				"labels":          map[string]string{"app.paprika.io/name": inlineSourceApp, "app.paprika.io/managed-by": "paprika"},
				"annotations":     map[string]string{"paprika.io/source-revision": inlineRevision, "paprika.io/source-hash": hex.EncodeToString(hash[:])},
				"ownerReferences": []map[string]any{{"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Application", "name": source.Name, "uid": string(source.UID), "controller": true}}},
			"spec": map[string]any{"pipeline": "", "target": inlineSourceApp + "-development", "manifestSource": map[string]any{"configMapRef": "bundle-v1", "artifact": inlinePromotionArtifact(inlineRevision)},
				"verify": []map[string]any{{"type": "duration", "timeout": 10}, {"type": "smoke-test", "endpoint": inlinePromotionURL(inlineSourceNS) + "/health", "timeout": 5}}},
		}))
		// The normal external publisher selects its owned ReleaseRef; it never
		// fabricates sourceRevision, health, promotion or deployment observations.
		_, err = utils.Kubectl("-n", inlineSourceNS, "patch", "applications.pipelines.paprika.io", inlineSourceApp, "--subresource=status", "--type=merge", "-p", `{"status":{"releaseRef":"`+releaseName+`"}}`)
		Expect(err).NotTo(HaveOccurred())
		source = inlinePromotionWaitHealthy(inlineSourceNS, inlineSourceApp)
		Expect(source.Status.SourceRevision).To(Equal(inlineRevision))
		Expect(source.Status.DeploymentObservation.Revision).To(Equal(inlineRevision))
	})

	AfterAll(func() {
		for _, target := range []struct{ namespace, name string }{{inlineTargetNS, inlineTargetApp}, {inlineBadImageNS, inlineTargetApp}, {inlineBadRevisionNS, inlineTargetApp}, {inlinePendingNS, inlineTargetApp}, {inlineDuplicateNS, inlineTargetApp}, {inlineRetryNS, inlineTargetApp}, {inlineWindowNS, inlineTargetApp}, {inlineSourceNS, inlineSourceApp}} {
			promotionCleanupApp(target.namespace, target.name)
		}
		fx.Teardown()
	})

	It("converges an already healthy external publisher's missing or stale deployed revision without rollout", func() {
		// Reproduce an upgrade from a controller that never populated this legacy
		// display field. All health, provenance and observations come from the real
		// completed source deployment; only status.revision is changed by the test.
		original := source.DeepCopy()
		before, err := inlinePromotionSourceRuntimeIdentity()
		Expect(err).NotTo(HaveOccurred())
		Expect(before).NotTo(BeEmpty())
		for _, legacyRevision := range []string{"", strings.Repeat("b", 40)} {
			By(fmt.Sprintf("emulating the legacy deployed revision %q on the already healthy source", legacyRevision))
			var patched api.Application
			Eventually(func() error {
				current, err := promotionGetApp(inlineSourceNS, inlineSourceApp)
				if err != nil {
					return err
				}
				operation := map[string]any{"op": "remove", "path": "/status/revision"}
				if legacyRevision != "" {
					operation["op"], operation["value"] = "replace", legacyRevision
				}
				patch := promotionJSON([]map[string]any{
					{"op": "test", "path": "/metadata/uid", "value": string(original.UID)},
					{"op": "test", "path": "/metadata/generation", "value": original.Generation},
					{"op": "test", "path": "/metadata/resourceVersion", "value": current.ResourceVersion},
					{"op": "test", "path": "/status/phase", "value": api.ApplicationHealthy},
					{"op": "test", "path": "/status/releaseRef", "value": original.Status.ReleaseRef},
					{"op": "test", "path": "/status/revision", "value": inlineRevision},
					operation,
				})
				raw, err := utils.Kubectl("-n", inlineSourceNS, "patch", "applications.pipelines.paprika.io", inlineSourceApp, "--subresource=status", "--type=json", "-p", patch, "-o", "json")
				if err != nil {
					return err
				}
				return json.Unmarshal([]byte(raw), &patched)
			}, 20*time.Second, time.Second).Should(Succeed())
			Expect(patched.Status.Revision).To(Equal(legacyRevision))
			Expect(patched.Spec).To(Equal(original.Spec))
			Expect(patched.Status.Phase).To(Equal(api.ApplicationHealthy))
			Expect(patched.Status.SourceRevision).To(Equal(inlineRevision))
			Expect(patched.Status.SourceHash).To(Equal(original.Status.SourceHash))
			Expect(patched.Status.DeploymentObservation).NotTo(BeNil())
			Expect(patched.Status.DeploymentObservation.ReleaseUID).To(Equal(original.Status.DeploymentObservation.ReleaseUID))
			Eventually(func(g Gomega) {
				current, err := promotionGetApp(inlineSourceNS, inlineSourceApp)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(current.UID).To(Equal(original.UID))
				g.Expect(current.Generation).To(Equal(original.Generation))
				g.Expect(current.Spec).To(Equal(original.Spec))
				g.Expect(current.Status.Phase).To(Equal(api.ApplicationHealthy))
				g.Expect(current.Status.ObservedGeneration).To(Equal(current.Generation))
				g.Expect(current.Status.Revision).To(Equal(inlineRevision))
				g.Expect(current.Status.SourceRevision).To(Equal(inlineRevision))
				g.Expect(current.Status.SourceHash).To(Equal(original.Status.SourceHash))
				g.Expect(current.Status.ReleaseRef).To(Equal(original.Status.ReleaseRef))
				g.Expect(current.Status.DeploymentObservation).NotTo(BeNil())
				g.Expect(current.Status.DeploymentObservation.ReleaseUID).To(Equal(original.Status.DeploymentObservation.ReleaseUID))
				g.Expect(current.Status.DeploymentObservation.ObservedGeneration).To(Equal(current.Generation))
				source = current
			}, 90*time.Second, time.Second).Should(Succeed())
			after, err := inlinePromotionSourceRuntimeIdentity()
			Expect(err).NotTo(HaveOccurred())
			Expect(after).To(Equal(before), "revision convergence must retain source Releases, workload generation, ReplicaSets and Pods")
		}
	})

	It("promotes exact source images through real HTTP Jobs while retaining tenant configuration", func() {
		fx.Apply(inlinePromotionSnapshot(inlineTargetNS, "bundle-v1", inlinePromotionPayload(inlineTargetNS, "vocus", "vocus.example.test", inlineArtifactImage)))
		fx.Apply(inlinePromotionApp(inlineTargetNS, inlineTargetApp, "bundle-v1", inlineRevision, "vocus.example.test", true))
		inlinePromotionOwnSnapshot(inlineTargetNS, inlineTargetApp, "bundle-v1")
		target := inlinePromotionWaitHealthy(inlineTargetNS, inlineTargetApp)
		promotionExpectProvenance(target, source)
		promotionExpectPipeline(target, api.PipelineSucceeded)
		pods, err := utils.Kubectl("-n", "paprika-system", "get", "pods", "-l", "paprika.io/pipeline="+target.Status.Promotion.VerificationPipelineRef, "-o", "jsonpath={.items[*].metadata.labels.paprika\\.io/step}")
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(pods)).To(Equal("source-http"))
		acceptedUID = target.Status.Promotion.SourceReleaseUID
		Expect(target.Status.AcceptedDeployment.Source.Inline.ConfigMapRef).To(Equal("bundle-v1"))
		var release api.Release
		raw, err := utils.Kubectl("-n", inlineTargetNS, "get", "releases.pipelines.paprika.io", target.Status.ReleaseRef, "-o", "json")
		Expect(err).NotTo(HaveOccurred())
		Expect(json.Unmarshal([]byte(raw), &release)).To(Succeed())
		Expect(release.Spec.ManifestSource.ConfigMapRef).To(Equal("bundle-v1"))
		Expect(string(release.Spec.ManifestSource.Artifact.Images["backend"])).To(Equal(inlineArtifactImage))
		for ns, domain := range map[string]string{inlineSourceNS: "next.example.test", inlineTargetNS: "vocus.example.test"} {
			actual, err := utils.Kubectl("-n", ns, "get", "configmap", "artifact-settings", "-o", "jsonpath={.data.domain}")
			Expect(err).NotTo(HaveOccurred())
			Expect(actual).To(Equal(domain))
			image, err := utils.Kubectl("-n", ns, "get", "deployment", "artifact-app", "-o", "jsonpath={.spec.template.spec.containers[0].image}")
			Expect(err).NotTo(HaveOccurred())
			Expect(image).To(Equal(inlineArtifactImage))
		}
	})

	It("rejects substituted primary images, duplicate resources and a different source revision before deployment", func() {
		badImage := "docker.io/library/busybox@sha256:" + strings.Repeat("b", 64)
		fx.Apply(inlinePromotionSnapshot(inlineBadImageNS, "bundle-v1", inlinePromotionPayload(inlineBadImageNS, "vocus", "vocus.example.test", badImage)))
		fx.Apply(inlinePromotionApp(inlineBadImageNS, inlineTargetApp, "bundle-v1", inlineRevision, "vocus.example.test", true))
		inlinePromotionOwnSnapshot(inlineBadImageNS, inlineTargetApp, "bundle-v1")
		fx.Apply(inlinePromotionSnapshot(inlineBadRevisionNS, "bundle-v1", inlinePromotionPayload(inlineBadRevisionNS, "vocus", "vocus.example.test", inlineArtifactImage)))
		fx.Apply(inlinePromotionApp(inlineBadRevisionNS, inlineTargetApp, "bundle-v1", strings.Repeat("b", 40), "vocus.example.test", true))
		inlinePromotionOwnSnapshot(inlineBadRevisionNS, inlineTargetApp, "bundle-v1")
		valid := inlinePromotionPayload(inlineDuplicateNS, "vocus", "vocus.example.test", inlineArtifactImage)
		duplicate := strings.Split(inlinePromotionPayload(inlineDuplicateNS, "vocus", "vocus.example.test", "ghcr.io/other/dependency@sha256:"+strings.Repeat("b", 64)), "\n---\n")[1]
		duplicate = strings.ReplaceAll(duplicate, `"app.kubernetes.io/component":"backend"`, `"app.kubernetes.io/component":"dependency"`)
		duplicate = strings.ReplaceAll(duplicate, `"name":"backend"`, `"name":"dependency"`)
		fx.Apply(inlinePromotionSnapshot(inlineDuplicateNS, "bundle-v1", valid+"\n---\n"+duplicate))
		fx.Apply(inlinePromotionApp(inlineDuplicateNS, inlineTargetApp, "bundle-v1", inlineRevision, "vocus.example.test", true))
		inlinePromotionOwnSnapshot(inlineDuplicateNS, inlineTargetApp, "bundle-v1")
		Consistently(func(g Gomega) {
			for _, ns := range []string{inlineBadImageNS, inlineBadRevisionNS, inlineDuplicateNS} {
				app, err := promotionGetApp(ns, inlineTargetApp)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(app.Status.ReleaseRef).To(BeEmpty())
				g.Expect(app.Status.SourceRevision).To(BeEmpty())
				objects, err := utils.Kubectl("-n", ns, "get", "deployments", "-o", "jsonpath={.items[*].metadata.name}")
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(objects).To(BeEmpty())
			}
		}, 12*time.Second, 2*time.Second).Should(Succeed())
	})

	It("admits the same upstream UID after its independently staged target artifact becomes compatible", func() {
		fx.Apply(inlinePromotionApp(inlineBadRevisionNS, inlineTargetApp, "bundle-v1", inlineRevision, "vocus.example.test", true))
		target := inlinePromotionWaitHealthy(inlineBadRevisionNS, inlineTargetApp)
		Expect(target.Status.Promotion.SourceReleaseUID).To(Equal(acceptedUID))
		promotionExpectPipeline(target, api.PipelineSucceeded)
	})

	It("binds manual approval to staged bytes before and after a same-name snapshot replacement", func() {
		const domain = "reviewed.example.test"
		payload := inlinePromotionPayload(inlinePendingNS, "reviewed", domain, inlineArtifactImage)
		fx.Apply(inlinePromotionSnapshot(inlinePendingNS, "bundle-v1", payload))
		manualApp := strings.Replace(inlinePromotionApp(inlinePendingNS, inlineTargetApp, "bundle-v1", inlineRevision, domain, true), `"syncPolicy":"Auto"`, `"syncPolicy":"Manual"`, 1)
		fx.Apply(manualApp)
		inlinePromotionOwnSnapshot(inlinePendingNS, inlineTargetApp, "bundle-v1")
		candidate := promotionWaitCandidate(inlinePendingNS, inlineTargetApp, inlineRevision, "AwaitingApproval")
		verifiedHash := candidate.Status.Promotion.VerificationConfigHash
		// Recreate the immutable input under its original name with unchanged
		// application images but substituted tenant configuration.
		_, err := utils.Kubectl("-n", inlinePendingNS, "delete", "configmap", "bundle-v1", "--wait=true")
		Expect(err).NotTo(HaveOccurred())
		fx.Apply(inlinePromotionSnapshot(inlinePendingNS, "bundle-v1", inlinePromotionPayload(inlinePendingNS, "substituted", "substituted.example.test", inlineArtifactImage)))
		inlinePromotionOwnSnapshot(inlinePendingNS, inlineTargetApp, "bundle-v1")
		promotionAnnotate(inlinePendingNS, inlineTargetApp, "paprika.io/promote="+candidate.Status.Promotion.SourceReleaseUID)
		Consistently(func(g Gomega) {
			app, err := promotionGetApp(inlinePendingNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(app.Status.ReleaseRef).To(BeEmpty())
			g.Expect(app.Status.AcceptedDeployment).To(BeNil())
		}, 12*time.Second, 2*time.Second).Should(Succeed())
		// An explicit hash change is a target spec edit. The old approval token
		// must be consumed and this source UID must await a fresh approval.
		manualApp = strings.Replace(inlinePromotionApp(inlinePendingNS, inlineTargetApp, "bundle-v1", inlineRevision, "substituted.example.test", true), `"syncPolicy":"Auto"`, `"syncPolicy":"Manual"`, 1)
		fx.Apply(manualApp)
		Eventually(func(g Gomega) {
			app, err := promotionGetApp(inlinePendingNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(app.Status.Promotion.Phase).To(Equal("AwaitingApproval"))
			g.Expect(app.Status.Promotion.VerificationConfigHash).NotTo(Equal(verifiedHash))
			g.Expect(app.Annotations["paprika.io/promote"]).To(BeEmpty())
			g.Expect(app.Status.ReleaseRef).To(BeEmpty())
		}, time.Minute, time.Second).Should(Succeed())
		promotionAnnotate(inlinePendingNS, inlineTargetApp, "paprika.io/promote="+candidate.Status.Promotion.SourceReleaseUID)
		inlinePromotionWaitHealthy(inlinePendingNS, inlineTargetApp)
	})

	inlinePromotionRetrySpecs(&fx)

	It("keeps accepted target manifests pinned while a different desired revision and domain wait", func() {
		fx.Apply(inlinePromotionSnapshot(inlineTargetNS, "bundle-v2", inlinePromotionPayload(inlineTargetNS, "pending", "pending.example.test", inlineArtifactImage)))
		fx.Apply(inlinePromotionApp(inlineTargetNS, inlineTargetApp, "bundle-v2", strings.Repeat("b", 40), "pending.example.test", true))
		inlinePromotionOwnSnapshot(inlineTargetNS, inlineTargetApp, "bundle-v2")
		promotionAnnotate(inlineTargetNS, inlineTargetApp, "paprika.io/manual-sync=repair-accepted", "paprika.io/sync=repair-accepted")
		Consistently(func(g Gomega) {
			target, err := promotionGetApp(inlineTargetNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(target.Status.SourceRevision).To(Equal(inlineRevision))
			g.Expect(target.Status.AcceptedDeployment.Source.Inline.ConfigMapRef).To(Equal("bundle-v1"))
			g.Expect(target.Status.Promotion.SourceReleaseUID).To(Equal(acceptedUID))
			actual, err := utils.Kubectl("-n", inlineTargetNS, "get", "configmap", "artifact-settings", "-o", "jsonpath={.data.domain}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(actual).To(Equal("vocus.example.test"))
		}, 15*time.Second, 2*time.Second).Should(Succeed())
		inlinePromotionWaitHealthy(inlineTargetNS, inlineTargetApp)
	})
})

func inlinePromotionArtifact(revision string) map[string]any {
	return map[string]any{"repository": "https://example.test/sfh.git", "revision": revision, "images": map[string]string{"backend": inlineArtifactImage}}
}

func inlinePromotionURL(namespace string) string {
	return "http://artifact-app." + namespace + ".svc:8080"
}

func inlinePromotionSnapshot(namespace, name, payload string) string {
	appName := inlineTargetApp
	if namespace == inlineSourceNS {
		appName = inlineSourceApp
	}
	return promotionJSON(map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": name, "namespace": namespace, "labels": map[string]string{"app.paprika.io/managed-by": "paprika", "app.paprika.io/name": appName}}, "immutable": true, "data": map[string]string{"manifests.yaml": payload}})
}

func inlinePromotionApp(namespace, name, snapshot, revision, domain string, promote bool) string {
	raw, err := utils.Kubectl("-n", namespace, "get", "configmap", snapshot, "-o", "json")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	var bundle corev1.ConfigMap
	ExpectWithOffset(1, json.Unmarshal([]byte(raw), &bundle)).To(Succeed())
	digest := sha256.Sum256([]byte(bundle.Data["manifests.yaml"]))
	spec := map[string]any{
		"project": "default", "source": map[string]any{"type": "inline", "targetNamespace": namespace, "inline": map[string]any{"configMapRef": snapshot, "manifestHash": hex.EncodeToString(digest[:]), "artifact": inlinePromotionArtifact(revision)}},
		"syncPolicy": "Manual", "parameters": map[string]string{"release-name": "artifact-app"},
		"stages":       []map[string]any{{"name": "development", "ring": 0, "gates": []map[string]any{{"type": "duration", "timeout": 10}, {"type": "smoke-test", "endpoint": inlinePromotionURL(namespace) + "/health", "timeout": 5}}}},
		"healthChecks": []map[string]any{{"name": "tenant-domain", "interval": "5s", "httpProbe": map[string]any{"url": inlinePromotionURL(namespace) + "/domain", "method": "GET", "timeout": 5, "expectedStatus": 200}, "expression": fmt.Sprintf("http.statusCode == 200 && http.body == %q", domain)}},
	}
	if promote {
		spec["syncPolicy"] = "Auto"
		spec["trigger"] = map[string]any{"type": "Promotion", "from": map[string]string{"name": inlineSourceApp, "namespace": inlineSourceNS}, "tests": map[string]any{"maxParallel": 1, "steps": []map[string]any{{"name": "source-http", "image": inlineArtifactImage, "script": "set -eu\ntest \"$PAPRIKA_PROMOTION_REVISION\" = " + inlineRevision + "\ntest \"$(wget -qO- -T 5 " + inlinePromotionURL(inlineSourceNS) + "/domain)\" = next.example.test\ntest \"$(wget -qO- -T 5 " + inlinePromotionURL(inlineSourceNS) + "/environment)\" = dev\n", "timeout": 30, "retry": 1}}}}
	}
	return promotionJSON(map[string]any{"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Application", "metadata": map[string]any{"name": name, "namespace": namespace}, "spec": spec})
}

func inlinePromotionPayload(namespace, environment, domain, image string) string {
	settings := map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "artifact-settings", "namespace": namespace}, "data": map[string]string{"health": "ok", "environment": environment, "domain": domain}}
	deployment := map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": "artifact-app", "namespace": namespace, "labels": map[string]string{"app.kubernetes.io/component": "backend"}}, "spec": map[string]any{"replicas": 1, "selector": map[string]any{"matchLabels": map[string]string{"app": "artifact-app"}}, "template": map[string]any{"metadata": map[string]any{"labels": map[string]string{"app": "artifact-app"}}, "spec": map[string]any{"securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": 1000}, "containers": []map[string]any{{"name": "backend", "image": image, "command": []string{"httpd", "-f", "-p", "8080", "-h", "/www"}, "ports": []map[string]any{{"containerPort": 8080}}, "readinessProbe": map[string]any{"httpGet": map[string]any{"path": "/health", "port": 8080}, "initialDelaySeconds": 1, "periodSeconds": 2}, "volumeMounts": []map[string]any{{"name": "settings", "mountPath": "/www", "readOnly": true}}}}, "volumes": []map[string]any{{"name": "settings", "configMap": map[string]string{"name": "artifact-settings"}}}}}}}
	service := map[string]any{"apiVersion": "v1", "kind": "Service", "metadata": map[string]any{"name": "artifact-app", "namespace": namespace}, "spec": map[string]any{"selector": map[string]string{"app": "artifact-app"}, "ports": []map[string]any{{"port": 8080, "targetPort": 8080}}}}
	return promotionJSON(settings) + "\n---\n" + promotionJSON(deployment) + "\n---\n" + promotionJSON(service)
}

func inlinePromotionOwnSnapshot(namespace, application, snapshot string) {
	app, err := promotionGetApp(namespace, application)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	patch := promotionJSON(map[string]any{"metadata": map[string]any{"ownerReferences": []map[string]any{{"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Application", "name": application, "uid": string(app.UID), "controller": true}}}})
	_, err = utils.Kubectl("-n", namespace, "patch", "configmap", snapshot, "--type=merge", "-p", patch)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
}

func inlinePromotionWaitHealthy(namespace, application string) *api.Application {
	promotionWaitHealthy(namespace, application, inlineRevision)
	var app *api.Application
	EventuallyWithOffset(1, func(g Gomega) {
		current, err := promotionGetApp(namespace, application)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(current.Status.Health).To(Equal(api.HealthHealthy), "status: %s", promotionJSON(current.Status))
		g.Expect(current.Status.Synced).To(BeTrue())
		g.Expect(current.Status.Resources).To(HaveLen(3))
		for _, resource := range current.Status.Resources {
			g.Expect(resource.Status).To(Equal("Synced"))
		}
		g.Expect(current.Status.ResourceHealth).To(HaveLen(3))
		for _, resource := range current.Status.ResourceHealth {
			g.Expect(resource.Health).To(Equal("Healthy"))
		}
		app = current
	}, time.Minute, time.Second).Should(Succeed())
	return app
}

// Capture immutable identities and desired workload generation separately from
// changing health timestamps. The dedicated source namespace contains only this
// external publisher's resources, so additional Releases or rollout Pods count.
func inlinePromotionSourceRuntimeIdentity() (map[string]string, error) {
	raw, err := utils.Kubectl("-n", inlineSourceNS, "get", "releases.pipelines.paprika.io,deployments.apps,replicasets.apps,pods", "-o", "json")
	if err != nil {
		return nil, err
	}
	var objects corev1.List
	if err := json.Unmarshal([]byte(raw), &objects); err != nil {
		return nil, err
	}
	identities := make(map[string]string, len(objects.Items))
	counts := make(map[string]int, 4)
	for _, object := range objects.Items {
		var resource struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name       string `json:"name"`
				UID        string `json:"uid"`
				Generation int64  `json:"generation"`
			} `json:"metadata"`
			Spec json.RawMessage `json:"spec"`
		}
		if err := json.Unmarshal(object.Raw, &resource); err != nil {
			return nil, err
		}
		counts[resource.Kind]++
		key := resource.Kind + "/" + resource.Metadata.Name
		identities[key] = fmt.Sprintf("%s:%d", resource.Metadata.UID, resource.Metadata.Generation)
		if resource.Kind == "Deployment" {
			var spec any
			if err := json.Unmarshal(resource.Spec, &spec); err != nil {
				return nil, err
			}
			canonical, err := json.Marshal(spec)
			if err != nil {
				return nil, err
			}
			digest := sha256.Sum256(canonical)
			identities[key+"/spec"] = hex.EncodeToString(digest[:])
		}
	}
	for _, kind := range []string{"Release", "Deployment", "ReplicaSet", "Pod"} {
		if counts[kind] == 0 {
			return nil, fmt.Errorf("source runtime identity has no %s", kind)
		}
	}
	return identities, nil
}
