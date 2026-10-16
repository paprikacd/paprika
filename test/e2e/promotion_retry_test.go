//go:build e2e

package e2e

import (
	"encoding/json"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	batchv1 "k8s.io/api/batch/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/test/utils"
)

func inlinePromotionRetrySpecs(fx *Fixture) {
	It("retries the same failed upstream candidate with fresh real Jobs and a fresh approval", func() {
		const token = "c642eb26-ff51-4f55-80d9-c4e5e43d10ab"
		fx.Apply(inlinePromotionSnapshot(inlineRetryNS, "bundle-v1", inlinePromotionPayload(inlineRetryNS, "retry", "retry.example.test", inlineArtifactImage)))
		var app api.Application
		Expect(json.Unmarshal([]byte(inlinePromotionApp(inlineRetryNS, inlineTargetApp, "bundle-v1", inlineRevision, "retry.example.test", true)), &app)).To(Succeed())
		app.Spec.SyncPolicy = api.SyncManual
		// The identical test still checks the live upstream on both attempts. Its
		// deliberate first-attempt failure needs the explicit retry identity.
		app.Spec.Trigger.Tests.Steps[0].Script += "test -n \"${PAPRIKA_PROMOTION_ATTEMPT:-}\"\n"
		fx.Apply(promotionJSON(app))
		inlinePromotionOwnSnapshot(inlineRetryNS, inlineTargetApp, "bundle-v1")
		failed := promotionWaitCandidate(inlineRetryNS, inlineTargetApp, inlineRevision, "Failed")
		oldPipeline := failed.Status.Promotion.VerificationPipelineRef
		uid := failed.Status.Promotion.SourceReleaseUID
		promotionExpectPipeline(failed, api.PipelineFailed)
		oldJobs := promotionRetryJobs(oldPipeline)
		Expect(oldJobs.Items).NotTo(BeEmpty())
		promotionAnnotate(inlineRetryNS, inlineTargetApp, "paprika.io/promote="+uid, "paprika.io/manual-sync=retry", "paprika.io/sync=retry", "paprika.io/promotion-retry=wrong-release:"+token)
		Consistently(func(g Gomega) {
			current, err := promotionGetApp(inlineRetryNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.Promotion.Phase).To(Equal("Failed"))
			g.Expect(current.Status.ReleaseRef).To(BeEmpty())
			g.Expect(current.Status.Promotion.VerificationPipelineRef).To(Equal(oldPipeline))
		}, 8*time.Second, time.Second).Should(Succeed())
		promotionAnnotate(inlineRetryNS, inlineTargetApp, "paprika.io/promotion-retry="+uid+":"+token)
		verified := promotionWaitCandidate(inlineRetryNS, inlineTargetApp, inlineRevision, "AwaitingApproval")
		Expect(verified.Status.Promotion.SourceReleaseUID).To(Equal(uid))
		Expect(verified.Status.Promotion.VerificationAttempt).To(Equal(token))
		Expect(verified.Status.Promotion.VerificationPipelineRef).NotTo(Equal(oldPipeline))
		Expect(verified.Annotations["paprika.io/promote"]).To(BeEmpty())
		Expect(verified.Annotations["paprika.io/promotion-retry"]).To(BeEmpty())
		Expect(verified.Status.ReleaseRef).To(BeEmpty())
		promotionExpectPipeline(verified, api.PipelineSucceeded)
		newJobs := promotionRetryJobs(verified.Status.Promotion.VerificationPipelineRef)
		Expect(newJobs.Items).NotTo(BeEmpty())
		for _, job := range newJobs.Items {
			Expect(job.Status.Succeeded).To(Equal(int32(1)))
			for _, old := range oldJobs.Items {
				Expect(job.UID).NotTo(Equal(old.UID))
				Expect(job.Name).NotTo(Equal(old.Name))
			}
		}
		// Replaying the token cannot reset successful verification or approve it.
		promotionAnnotate(inlineRetryNS, inlineTargetApp, "paprika.io/promotion-retry="+uid+":"+token)
		Consistently(func(g Gomega) {
			current, err := promotionGetApp(inlineRetryNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.Promotion.Phase).To(Equal("AwaitingApproval"))
			g.Expect(current.Status.Promotion.VerificationPipelineRef).To(Equal(verified.Status.Promotion.VerificationPipelineRef))
			g.Expect(current.Status.ReleaseRef).To(BeEmpty())
		}, 8*time.Second, time.Second).Should(Succeed())
		promotionAnnotate(inlineRetryNS, inlineTargetApp, "paprika.io/promote="+uid)
		promoted := inlinePromotionWaitHealthy(inlineRetryNS, inlineTargetApp)
		Expect(promoted.Status.Promotion.SourceReleaseUID).To(Equal(uid))
		Expect(promoted.Status.AcceptedDeployment.Source.Inline.ConfigMapRef).To(Equal("bundle-v1"))
	})

	It("restarts the upstream duration after a real service health interruption", func() {
		fx.Apply(inlinePromotionSnapshot(inlineWindowNS, "bundle-v1", inlinePromotionPayload(inlineWindowNS, "window", "window.example.test", inlineArtifactImage)))
		var app api.Application
		Expect(json.Unmarshal([]byte(inlinePromotionApp(inlineWindowNS, inlineTargetApp, "bundle-v1", inlineRevision, "window.example.test", true)), &app)).To(Succeed())
		app.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 30}}
		fx.Apply(promotionJSON(app))
		inlinePromotionOwnSnapshot(inlineWindowNS, inlineTargetApp, "bundle-v1")
		var original time.Time
		Eventually(func(g Gomega) {
			current, err := promotionGetApp(inlineWindowNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.Promotion).NotTo(BeNil())
			g.Expect(current.Status.Promotion.VerificationStartedAt).NotTo(BeNil())
			original = current.Status.Promotion.VerificationStartedAt.Time
		}, 2*time.Minute, time.Second).Should(Succeed())
		restore := func() {
			_, err := utils.Kubectl("-n", inlineSourceNS, "patch", "service", "artifact-app", "--type=merge", "-p", `{"spec":{"selector":{"app":"artifact-app"}}}`)
			Expect(err).NotTo(HaveOccurred())
		}
		DeferCleanup(restore)
		_, err := utils.Kubectl("-n", inlineSourceNS, "patch", "service", "artifact-app", "--type=merge", "-p", `{"spec":{"selector":{"app":"no-serving-pods"}}}`)
		Expect(err).NotTo(HaveOccurred())
		Eventually(func(g Gomega) {
			current, err := promotionGetApp(inlineWindowNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.Promotion.VerificationStartedAt).To(BeNil())
			g.Expect(current.Status.ReleaseRef).To(BeEmpty())
		}, 30*time.Second, time.Second).Should(Succeed())
		restore()
		inlinePromotionWaitHealthy(inlineSourceNS, inlineSourceApp)
		var restarted time.Time
		Eventually(func(g Gomega) {
			current, err := promotionGetApp(inlineWindowNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.Promotion.VerificationStartedAt).NotTo(BeNil())
			restarted = current.Status.Promotion.VerificationStartedAt.Time
			g.Expect(restarted.After(original)).To(BeTrue())
		}, 30*time.Second, time.Second).Should(Succeed())
		Consistently(func(g Gomega) {
			current, err := promotionGetApp(inlineWindowNS, inlineTargetApp)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(current.Status.ReleaseRef).To(BeEmpty())
		}, 10*time.Second, time.Second).Should(Succeed())
		inlinePromotionWaitHealthy(inlineWindowNS, inlineTargetApp)
	})
}

func promotionRetryJobs(pipeline string) batchv1.JobList {
	raw, err := utils.Kubectl("-n", "paprika-system", "get", "jobs", "-l", "paprika.io/pipeline="+pipeline, "-o", "json")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	var jobs batchv1.JobList
	ExpectWithOffset(1, json.Unmarshal([]byte(raw), &jobs)).To(Succeed())
	return jobs
}
