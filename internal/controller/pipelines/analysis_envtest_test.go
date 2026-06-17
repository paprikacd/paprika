package controller

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var _ = Describe("Application Controller Analysis Envtest", Serial, func() {
	ctx := context.Background()
	const (
		appName      = "analysis-envtest-app"
		releaseName  = appName + "-release"
		templateName = "analysis-template"
	)

	var (
		appKey     = types.NamespacedName{Name: appName, Namespace: "default"}
		runKey     = types.NamespacedName{Name: appName + "-" + templateName + "-analysis", Namespace: "default"}
		releaseKey = types.NamespacedName{Name: releaseName, Namespace: "default"}
	)

	BeforeEach(func() {
		template := &pipelinesv1alpha1.AnalysisTemplate{
			ObjectMeta: metav1.ObjectMeta{Name: templateName, Namespace: "default"},
			Spec: pipelinesv1alpha1.AnalysisTemplateSpec{
				Checks: []pipelinesv1alpha1.AnalysisCheck{
					{Type: "http", URL: "http://localhost:1/health", SuccessThreshold: "0", RequestCount: 1, TimeoutSeconds: 1},
				},
			},
		}
		Expect(k8sClient.Create(ctx, template)).To(Succeed())

		release := &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ReleaseSpec{
				Pipeline: "test-pipeline",
				Target:   "test-target",
			},
		}
		Expect(k8sClient.Create(ctx, release)).To(Succeed())

		var fresh pipelinesv1alpha1.Release
		Expect(k8sClient.Get(ctx, releaseKey, &fresh)).To(Succeed())
		fresh.Status.Phase = pipelinesv1alpha1.ReleaseComplete
		Expect(k8sClient.Status().Update(ctx, &fresh)).To(Succeed())

		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source:     pipelinesv1alpha1.ApplicationSource{Type: "inline"},
				Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
				SyncPolicy: pipelinesv1alpha1.SyncAuto,
				AnalysisTemplates: []pipelinesv1alpha1.AnalysisTemplateRef{
					{Name: templateName, IntervalSeconds: 5},
				},
			},
			Status: pipelinesv1alpha1.ApplicationStatus{
				Phase:      pipelinesv1alpha1.ApplicationHealthy,
				ReleaseRef: releaseName,
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
	})

	AfterEach(func() {
		for _, obj := range []client.Object{
			&pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"}},
			&pipelinesv1alpha1.AnalysisRun{ObjectMeta: metav1.ObjectMeta{Name: runKey.Name, Namespace: "default"}},
			&pipelinesv1alpha1.Release{ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: "default"}},
			&pipelinesv1alpha1.AnalysisTemplate{ObjectMeta: metav1.ObjectMeta{Name: templateName, Namespace: "default"}},
		} {
			_ = client.IgnoreNotFound(k8sClient.Delete(ctx, obj))
		}
	})

	It("should create an AnalysisRun when an Application references a template", func() {
		app := &pipelinesv1alpha1.Application{}
		Expect(k8sClient.Get(ctx, appKey, app)).To(Succeed())

		r := &ApplicationReconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
		}
		Expect(r.reconcileAnalysisRuns(ctx, app)).To(Succeed())

		Eventually(func() error {
			return k8sClient.Get(ctx, runKey, &pipelinesv1alpha1.AnalysisRun{})
		}, 10*time.Second, 500*time.Millisecond).Should(Succeed())
	})

	It("should aggregate analysis results into application status", func() {
		app := &pipelinesv1alpha1.Application{}
		Expect(k8sClient.Get(ctx, appKey, app)).To(Succeed())

		r := &ApplicationReconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
		}
		Expect(r.reconcileAnalysisRuns(ctx, app)).To(Succeed())

		found := false
		for _, c := range app.Status.Conditions {
			if c.Type == "AnalysisFailed" {
				found = true
				break
			}
		}
		Expect(found).To(BeTrue())
	})
})
