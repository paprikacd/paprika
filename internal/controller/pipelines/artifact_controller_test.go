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

package pipelines

import (
	"context"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/oci"
)

var _ = ginkgo.Describe("Artifact Controller", func() {
	ginkgo.Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		artifact := &pipelinesv1alpha1.Artifact{}

		ginkgo.BeforeEach(func() {
			ginkgo.By("creating the custom resource for the Kind Artifact")
			err := k8sClient.Get(ctx, typeNamespacedName, artifact)
			if err != nil && errors.IsNotFound(err) {
				resource := &pipelinesv1alpha1.Artifact{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.ArtifactSpec{
						Type:      "oci",
						Reference: "test:v1",
					},
				}
				gomega.Expect(k8sClient.Create(ctx, resource)).To(gomega.Succeed())
			}
		})

		ginkgo.AfterEach(func() {
			resource := &pipelinesv1alpha1.Artifact{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			ginkgo.By("Cleanup the specific resource instance Artifact")
			gomega.Expect(k8sClient.Delete(ctx, resource)).To(gomega.Succeed())
		})

		ginkgo.It("should successfully reconcile the resource", func() {
			ginkgo.By("Reconciling the created resource")
			controllerReconciler := &ArtifactReconciler{
				client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Verifier: oci.NopVerifier{},
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			ginkgo.By("Checking the artifact status is verified")
			updated := &pipelinesv1alpha1.Artifact{}
			gomega.Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(gomega.Succeed())
			gomega.Expect(updated.Status.Verified).To(gomega.BeTrue())
			gomega.Expect(updated.Status.ObservedGeneration).To(gomega.Equal(updated.Generation))
			gomega.Expect(updated.Status.Conditions).To(gomega.HaveLen(1))
			gomega.Expect(updated.Status.Conditions[0].Type).To(gomega.Equal("Ready"))
			gomega.Expect(updated.Status.Conditions[0].Status).To(gomega.Equal(metav1.ConditionTrue))
		})

		ginkgo.It("should detect digest mismatch", func() {
			ginkgo.By("Updating artifact with expected digest")
			existing := &pipelinesv1alpha1.Artifact{}
			gomega.Expect(k8sClient.Get(ctx, typeNamespacedName, existing)).To(gomega.Succeed())
			existing.Spec.Digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
			gomega.Expect(k8sClient.Update(ctx, existing)).To(gomega.Succeed())

			ginkgo.By("Reconciling with a mismatched verifier")
			controllerReconciler := &ArtifactReconciler{
				client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Verifier: oci.NopVerifier{},
			}
			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			ginkgo.By("Checking the artifact status reports digest mismatch")
			updated := &pipelinesv1alpha1.Artifact{}
			gomega.Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(gomega.Succeed())
			gomega.Expect(updated.Status.Verified).To(gomega.BeFalse())
			gomega.Expect(updated.Status.Conditions).To(gomega.HaveLen(1))
			gomega.Expect(updated.Status.Conditions[0].Status).To(gomega.Equal(metav1.ConditionFalse))
			gomega.Expect(updated.Status.Conditions[0].Reason).To(gomega.Equal("DigestMismatch"))
		})
	})
})
