package controller

import (
	"context"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
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
})
