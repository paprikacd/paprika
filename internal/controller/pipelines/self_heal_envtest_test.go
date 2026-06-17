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

package controller

import (
	"context"
	"strconv"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var _ = ginkgo.Describe("Application Controller Self-Heal Envtest", ginkgo.Serial, func() {
	ctx := context.Background()
	const (
		appName     = "self-heal-app"
		releaseName = appName + "-release"
	)
	var (
		appKey     = types.NamespacedName{Name: appName, Namespace: "default"}
		releaseKey = types.NamespacedName{Name: releaseName, Namespace: "default"}
		fixedNow   = time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC)
	)

	ginkgo.BeforeEach(func() {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source:     pipelinesv1alpha1.ApplicationSource{Type: "inline"},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SelfHeal: &pipelinesv1alpha1.SelfHealConfig{
					AutoSyncOnDrift:           true,
					AutoRevertOnHealthFailure: true,
					Cooldown:                  "1m",
				},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())
	})

	ginkgo.AfterEach(func() {
		app := &pipelinesv1alpha1.Application{}
		if err := k8sClient.Get(ctx, appKey, app); err == nil {
			gomega.Expect(k8sClient.Delete(ctx, app)).To(gomega.Succeed())
		}
		release := &pipelinesv1alpha1.Release{}
		if err := k8sClient.Get(ctx, releaseKey, release); err == nil {
			gomega.Expect(k8sClient.Delete(ctx, release)).To(gomega.Succeed())
		}

		gomega.Eventually(func() error {
			return client.IgnoreNotFound(k8sClient.Get(ctx, appKey, &pipelinesv1alpha1.Application{}))
		}, 10*time.Second, 500*time.Millisecond).Should(gomega.Succeed())
		gomega.Eventually(func() error {
			return client.IgnoreNotFound(k8sClient.Get(ctx, releaseKey, &pipelinesv1alpha1.Release{}))
		}, 10*time.Second, 500*time.Millisecond).Should(gomega.Succeed())
	})

	createCompleteRelease := func(onFailure *pipelinesv1alpha1.FailureAction) *pipelinesv1alpha1.Release {
		release := &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ReleaseSpec{
				Pipeline:  "test-pipeline",
				Target:    "test-target",
				OnFailure: onFailure,
			},
		}
		gomega.Expect(k8sClient.Create(ctx, release)).To(gomega.Succeed())

		var fresh pipelinesv1alpha1.Release
		gomega.Expect(k8sClient.Get(ctx, releaseKey, &fresh)).To(gomega.Succeed())
		fresh.Status.Phase = pipelinesv1alpha1.ReleaseComplete
		gomega.Expect(k8sClient.Status().Update(ctx, &fresh)).To(gomega.Succeed())
		return release
	}

	assertLastSelfHealTime := func(app *pipelinesv1alpha1.Application) {
		gomega.Expect(app.Status.LastSelfHealTime).NotTo(gomega.BeNil())
		gomega.Expect(app.Status.LastSelfHealTime.Time).To(gomega.BeTemporally("==", fixedNow))
	}

	ginkgo.It("should annotate the release for resync when drift is detected", func() {
		release := createCompleteRelease(nil)

		app := &pipelinesv1alpha1.Application{}
		gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
		app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
		app.Status.ReleaseRef = release.Name
		app.Status.OutOfSync = 1
		gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
			now:    func() time.Time { return fixedNow },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Release
		gomega.Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(gomega.Succeed())
		gomega.Expect(updated.Annotations[resyncAnnotation]).NotTo(gomega.BeEmpty())
		gomega.Expect(updated.Annotations[resyncAnnotation]).To(gomega.Equal(strconv.FormatInt(fixedNow.Unix(), 10)))

		gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
		assertLastSelfHealTime(app)
		cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Reason).To(gomega.Equal("DriftDetected"))
	})

	ginkgo.It("should annotate the release for rollback when health is degraded", func() {
		release := createCompleteRelease(&pipelinesv1alpha1.FailureAction{Action: "rollback"})

		app := &pipelinesv1alpha1.Application{}
		gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
		app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
		app.Status.ReleaseRef = release.Name
		app.Status.Health = pipelinesv1alpha1.HealthDegraded
		gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
			now:    func() time.Time { return fixedNow },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Release
		gomega.Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(gomega.Succeed())
		gomega.Expect(updated.Annotations[rollbackAnnotation]).NotTo(gomega.BeEmpty())
		gomega.Expect(updated.Annotations[rollbackAnnotation]).To(gomega.Equal(strconv.FormatInt(fixedNow.Unix(), 10)))

		gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
		assertLastSelfHealTime(app)
		cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Reason).To(gomega.Equal("HealthDegraded"))
	})

	ginkgo.It("should not act within cooldown", func() {
		release := createCompleteRelease(nil)

		app := &pipelinesv1alpha1.Application{}
		gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
		app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
		app.Status.ReleaseRef = release.Name
		app.Status.OutOfSync = 1
		app.Status.LastSelfHealTime = &metav1.Time{Time: fixedNow}
		gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
			now:    func() time.Time { return fixedNow.Add(1 * time.Second) },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Release
		gomega.Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(gomega.Succeed())
		gomega.Expect(updated.Annotations[resyncAnnotation]).To(gomega.BeEmpty())

		gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
		gomega.Expect(app.Status.LastSelfHealTime).NotTo(gomega.BeNil())
		gomega.Expect(app.Status.LastSelfHealTime.Time).To(gomega.BeTemporally("==", fixedNow))
		cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Reason).To(gomega.Equal("CooldownActive"))
	})
})
