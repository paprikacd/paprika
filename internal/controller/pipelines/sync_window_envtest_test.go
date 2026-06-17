package controller

import (
	"context"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/syncwindow"
)

var _ = ginkgo.Describe("Application Controller Sync Windows", func() {
	ctx := context.Background()

	ginkgo.It("should block source change outside allow window", func() {
		const appName = "sync-window-source"
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: "helm",
					Chart: pipelinesv1alpha1.ChartRef{
						Path: "/charts/demo-app",
					},
				},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SyncWindows: []pipelinesv1alpha1.SyncWindow{{
					Kind:     pipelinesv1alpha1.SyncWindowAllow,
					Schedule: "0 9 * * *",
					Duration: "8h",
				}},
			},
			Status: pipelinesv1alpha1.ApplicationStatus{
				Phase:      pipelinesv1alpha1.ApplicationHealthy,
				SourceHash: "old-hash",
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())
		app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
		app.Status.SourceHash = "old-hash"
		gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client:              k8sClient,
			Scheme:              k8sClient.Scheme(),
			WorkDir:             "/tmp/paprika-sources-test",
			SyncWindowEvaluator: syncwindow.NewEvaluator(),
			now:                 func() time.Time { return time.Date(2026, 6, 16, 20, 0, 0, 0, time.UTC) },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Application
		gomega.Expect(k8sClient.Get(ctx, appKey, &updated)).To(gomega.Succeed())
		cond := meta.FindStatusCondition(updated.Status.Conditions, "SyncWindow")
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Status).To(gomega.Equal(metav1.ConditionFalse))
		gomega.Expect(cond.Reason).To(gomega.Equal("Blocked"))
		gomega.Expect(updated.Status.Phase).To(gomega.Equal(pipelinesv1alpha1.ApplicationHealthy))
	})

	ginkgo.It("should block release creation outside allow window", func() {
		const appName = "sync-window-release"
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: "helm",
					Chart: pipelinesv1alpha1.ChartRef{
						Path: "/charts/demo-app",
					},
				},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SyncWindows: []pipelinesv1alpha1.SyncWindow{{
					Kind:     pipelinesv1alpha1.SyncWindowAllow,
					Schedule: "0 9 * * *",
					Duration: "8h",
				}},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client:              k8sClient,
			Scheme:              k8sClient.Scheme(),
			WorkDir:             "/tmp/paprika-sources-test",
			SyncWindowEvaluator: syncwindow.NewEvaluator(),
			now:                 func() time.Time { return time.Date(2026, 6, 16, 20, 0, 0, 0, time.UTC) },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Application
		gomega.Expect(k8sClient.Get(ctx, appKey, &updated)).To(gomega.Succeed())
		cond := meta.FindStatusCondition(updated.Status.Conditions, "SyncWindow")
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Status).To(gomega.Equal(metav1.ConditionFalse))
		gomega.Expect(cond.Reason).To(gomega.Equal("Blocked"))

		var releases pipelinesv1alpha1.ReleaseList
		gomega.Expect(k8sClient.List(ctx, &releases, client.InNamespace("default"))).To(gomega.Succeed())
		var found bool
		for _, rel := range releases.Items {
			if rel.Labels["app.paprika.io/name"] == appName {
				found = true
				break
			}
		}
		gomega.Expect(found).To(gomega.BeFalse())
	})

	ginkgo.It("should allow manual sync to bypass windows and create a release", func() {
		const appName = "sync-window-manual"
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{
				Name:      appName,
				Namespace: "default",
				Annotations: map[string]string{
					manualSyncAnnotation: "true",
				},
			},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: "helm",
					Chart: pipelinesv1alpha1.ChartRef{
						Path: "/charts/demo-app",
					},
				},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SyncWindows: []pipelinesv1alpha1.SyncWindow{{
					Kind:     pipelinesv1alpha1.SyncWindowAllow,
					Schedule: "0 9 * * *",
					Duration: "8h",
				}},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client:              k8sClient,
			Scheme:              k8sClient.Scheme(),
			WorkDir:             "/tmp/paprika-sources-test",
			SyncWindowEvaluator: syncwindow.NewEvaluator(),
			now:                 func() time.Time { return time.Date(2026, 6, 16, 20, 0, 0, 0, time.UTC) },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Application
		gomega.Expect(k8sClient.Get(ctx, appKey, &updated)).To(gomega.Succeed())
		gomega.Expect(updated.Status.ReleaseRef).NotTo(gomega.BeEmpty())
		_, ok := updated.Annotations[manualSyncAnnotation]
		gomega.Expect(ok).To(gomega.BeFalse())
	})

	ginkgo.It("should block self-heal drift sync by an active block window", func() {
		const appName = "sync-window-selfheal"
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}

		release := &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{
				Name:      appName + "-release",
				Namespace: "default",
			},
		}
		gomega.Expect(k8sClient.Create(ctx, release)).To(gomega.Succeed())
		release.Status.Phase = pipelinesv1alpha1.ReleaseComplete
		gomega.Expect(k8sClient.Status().Update(ctx, release)).To(gomega.Succeed())

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: "helm",
					Chart: pipelinesv1alpha1.ChartRef{
						Path: "/charts/demo-app",
					},
				},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SyncWindows: []pipelinesv1alpha1.SyncWindow{{
					Kind:     pipelinesv1alpha1.SyncWindowBlock,
					Schedule: "0 9 * * *",
					Duration: "8h",
				}},
				SelfHeal: &pipelinesv1alpha1.SelfHealConfig{
					AutoSyncOnDrift: true,
				},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())
		app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
		app.Status.ReleaseRef = release.Name
		app.Status.OutOfSync = 1
		gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client:              k8sClient,
			Scheme:              k8sClient.Scheme(),
			WorkDir:             "/tmp/paprika-sources-test",
			SyncWindowEvaluator: syncwindow.NewEvaluator(),
			now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updatedRelease pipelinesv1alpha1.Release
		gomega.Expect(k8sClient.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: "default"}, &updatedRelease)).To(gomega.Succeed())
		_, ok := updatedRelease.Annotations[resyncAnnotation]
		gomega.Expect(ok).To(gomega.BeFalse())

		var updated pipelinesv1alpha1.Application
		gomega.Expect(k8sClient.Get(ctx, appKey, &updated)).To(gomega.Succeed())
		cond := meta.FindStatusCondition(updated.Status.Conditions, "SyncWindow")
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Status).To(gomega.Equal(metav1.ConditionFalse))
	})

	ginkgo.It("should surface invalid window config as SyncWindow=Invalid", func() {
		const appName = "sync-window-invalid"
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: "helm",
					Chart: pipelinesv1alpha1.ChartRef{
						Path: "/charts/demo-app",
					},
				},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SyncWindows: []pipelinesv1alpha1.SyncWindow{{
					Kind:     pipelinesv1alpha1.SyncWindowAllow,
					Schedule: "not-a-cron",
					Duration: "8h",
				}},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

		r := &ApplicationReconciler{
			Client:              k8sClient,
			Scheme:              k8sClient.Scheme(),
			WorkDir:             "/tmp/paprika-sources-test",
			SyncWindowEvaluator: syncwindow.NewEvaluator(),
			now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
		}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var updated pipelinesv1alpha1.Application
		gomega.Expect(k8sClient.Get(ctx, appKey, &updated)).To(gomega.Succeed())
		cond := meta.FindStatusCondition(updated.Status.Conditions, "SyncWindow")
		gomega.Expect(cond).NotTo(gomega.BeNil())
		gomega.Expect(cond.Status).To(gomega.Equal(metav1.ConditionFalse))
		gomega.Expect(cond.Reason).To(gomega.Equal("Invalid"))
	})

	ginkgo.It("should requeue for the next allow window transition", func() {
		const appName = "sync-window-requeue"
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: "helm",
					Chart: pipelinesv1alpha1.ChartRef{
						Path: "/charts/demo-app",
					},
				},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				SyncWindows: []pipelinesv1alpha1.SyncWindow{{
					Kind:     pipelinesv1alpha1.SyncWindowAllow,
					Schedule: "0 9 * * *",
					Duration: "8h",
				}},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

		fixed := time.Date(2026, 6, 16, 20, 0, 0, 0, time.UTC)
		r := &ApplicationReconciler{
			Client:              k8sClient,
			Scheme:              k8sClient.Scheme(),
			WorkDir:             "/tmp/paprika-sources-test",
			SyncWindowEvaluator: syncwindow.NewEvaluator(),
			now:                 func() time.Time { return fixed },
		}
		res, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		// Requeue is capped at one hour so spec changes are not delayed indefinitely.
		gomega.Expect(res.RequeueAfter).To(gomega.Equal(time.Hour))
	})
})
