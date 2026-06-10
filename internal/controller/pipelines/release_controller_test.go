package controller

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var _ = Describe("Release Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		release := &pipelinesv1alpha1.Release{}
		stageName := "test-stage"

		BeforeEach(func() {
			By("creating the custom resource for the Kind Release")
			err := k8sClient.Get(ctx, typeNamespacedName, release)
			if err != nil && errors.IsNotFound(err) {
				By("creating the Stage resource needed by the Release")
				Expect(k8sClient.Create(ctx, &pipelinesv1alpha1.Stage{
					ObjectMeta: metav1.ObjectMeta{
						Name:      stageName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.StageSpec{
						Name:      stageName,
						Ring:      1,
						Templates: []string{},
					},
				})).To(Succeed())

				resource := &pipelinesv1alpha1.Release{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.ReleaseSpec{
						Pipeline: "test-pipeline",
						Target:   stageName,
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &pipelinesv1alpha1.Release{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			if err != nil && errors.IsNotFound(err) {
				return
			}
			Expect(err).NotTo(HaveOccurred())
			By("Cleanup the specific resource instance Release")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())

			By("Cleanup the Stage resource")
			stage := &pipelinesv1alpha1.Stage{}
			if err := k8sClient.Get(ctx, types.NamespacedName{Name: stageName, Namespace: "default"}, stage); err == nil {
				Expect(k8sClient.Delete(ctx, stage)).To(Succeed())
			}
		})
		It("should add finalizer on creation and handle cleanup on deletion", func() {
			By("Reconciling the created resource")
			controllerReconciler := &ReleaseReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
				Namespace: "default",
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())
			updated := &pipelinesv1alpha1.Release{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(Succeed())
			Expect(updated.Finalizers).To(ContainElement("paprika.io/release-cleanup"))
		})
	})
})
