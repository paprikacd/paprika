package controller

import (
	"context"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

const (
	governanceTestTimeout  = 30 * time.Second
	governanceTestInterval = 1 * time.Second
)

var _ = ginkgo.Describe("Application Controller", func() {
	ginkgo.Context("When reconciling a resource", func() {
		const resourceName = "test-application"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		application := &pipelinesv1alpha1.Application{}
		ginkgo.BeforeEach(func() {
			ginkgo.By("creating the custom resource for the Kind Application")
			err := k8sClient.Get(ctx, typeNamespacedName, application)
			if err != nil && errors.IsNotFound(err) {
				resource := &pipelinesv1alpha1.Application{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.ApplicationSpec{
						Source: pipelinesv1alpha1.ApplicationSource{
							Type: "helm",
							Chart: pipelinesv1alpha1.ChartRef{
								Path: "/charts/demo-app",
							},
						},
						Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
							{
								Name: "dev",
								Ring: 1,
							},
						},
						Strategy:   pipelinesv1alpha1.StrategyRolling,
						SyncPolicy: pipelinesv1alpha1.SyncAuto,
						Parameters: map[string]string{
							"replicaCount": "1",
						},
					},
				}
				gomega.Expect(k8sClient.Create(ctx, resource)).To(gomega.Succeed())
			}
		})

		ginkgo.AfterEach(func() {
			resource := &pipelinesv1alpha1.Application{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			if err == nil {
				ginkgo.By("Cleanup the specific resource instance Application")
				gomega.Expect(k8sClient.Delete(ctx, resource)).To(gomega.Succeed())
			}
		})

		ginkgo.It("should successfully reconcile the resource", func() {
			ginkgo.By("Reconciling the created resource")
			controllerReconciler := &ApplicationReconciler{
				Client:  k8sClient,
				Scheme:  k8sClient.Scheme(),
				WorkDir: "/tmp/paprika-sources-test",
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			gomega.Expect(err).NotTo(gomega.HaveOccurred())
		})
	})

	ginkgo.Context("when an Application violates its AppProject boundaries", func() {
		const (
			appName     = "test-app-governance"
			projectName = "restricted"
		)

		ctx := context.Background()
		appKey := types.NamespacedName{Name: appName, Namespace: "default"}
		projectKey := types.NamespacedName{Name: projectName, Namespace: "default"}

		ginkgo.BeforeEach(func() {
			project := &corev1alpha1.AppProject{
				ObjectMeta: metav1.ObjectMeta{
					Name:      projectName,
					Namespace: "default",
				},
				Spec: corev1alpha1.AppProjectSpec{
					Description: "Restricts deployments to allowed namespaces",
					Destinations: []corev1alpha1.AppProjectDestination{
						{Server: "*", Namespace: "allowed-ns"},
					},
				},
			}
			gomega.Expect(k8sClient.Create(ctx, project)).To(gomega.Succeed())

			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:      appName,
					Namespace: "default",
				},
				Spec: pipelinesv1alpha1.ApplicationSpec{
					Project: projectName,
					Source: pipelinesv1alpha1.ApplicationSource{
						Type: "helm",
						Chart: pipelinesv1alpha1.ChartRef{
							Path: "/charts/demo-app",
						},
					},
					Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
						{
							Name: "dev",
							Ring: 1,
						},
					},
					Strategy:   pipelinesv1alpha1.StrategyRolling,
					SyncPolicy: pipelinesv1alpha1.SyncAuto,
				},
			}
			gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())
		})

		ginkgo.AfterEach(func() {
			app := &pipelinesv1alpha1.Application{}
			if err := k8sClient.Get(ctx, appKey, app); err == nil {
				gomega.Expect(k8sClient.Delete(ctx, app)).To(gomega.Succeed())
			}

			project := &corev1alpha1.AppProject{}
			if err := k8sClient.Get(ctx, projectKey, project); err == nil {
				gomega.Expect(k8sClient.Delete(ctx, project)).To(gomega.Succeed())
			}
		})

		ginkgo.It("should set GovernanceChecked=False", func() {
			ginkgo.By("Reconciling the Application with a ProjectValidator")

			rec := record.NewFakeRecorder(10)
			validator := governance.NewProjectValidator(
				governance.NewProjectResolver(k8sClient),
				governance.NewClusterResolver(k8sClient),
				nil,
			)

			controllerReconciler := &ApplicationReconciler{
				Client:           k8sClient,
				Scheme:           k8sClient.Scheme(),
				WorkDir:          "/tmp/paprika-sources-test",
				EventRecorder:    rec,
				ProjectValidator: validator,
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: appKey,
			})
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			var app pipelinesv1alpha1.Application
			gomega.Eventually(func() bool {
				if getErr := k8sClient.Get(ctx, appKey, &app); getErr != nil {
					return false
				}
				cond := meta.FindStatusCondition(app.Status.Conditions, "GovernanceChecked")
				return cond != nil && cond.Status == metav1.ConditionFalse
			}, governanceTestTimeout, governanceTestInterval).Should(gomega.BeTrue())
		})
	})
})
