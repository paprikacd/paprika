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

package policy

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

var _ = Describe("Policy Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default", // TODO(user):Modify as needed
		}
		policy := &policyv1alpha1.Policy{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind Policy")
			err := k8sClient.Get(ctx, typeNamespacedName, policy)
			if err != nil && errors.IsNotFound(err) {
				resource := &policyv1alpha1.Policy{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: policyv1alpha1.PolicySpec{
						Severity:   policyv1alpha1.PolicySeverityWarning,
						Expression: "true",
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			// TODO(user): Cleanup logic after each test, like removing the resource instance.
			resource := &policyv1alpha1.Policy{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance Policy")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
		})
		It("should successfully reconcile the resource", func() {
			By("Reconciling the created resource")
			controllerReconciler := &PolicyReconciler{
				client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			By("Checking the policy status is ready")
			updated := &policyv1alpha1.Policy{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(Succeed())
			Expect(updated.Status.ObservedGeneration).To(Equal(updated.Generation))
			Expect(updated.Status.Conditions).To(HaveLen(1))
			Expect(updated.Status.Conditions[0].Type).To(Equal("Ready"))
			Expect(updated.Status.Conditions[0].Status).To(Equal(metav1.ConditionTrue))
		})

		It("should surface a compile error in status", func() {
			By("Updating the policy with an invalid expression")
			existing := &policyv1alpha1.Policy{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, existing)).To(Succeed())
			existing.Spec.Expression = "broken("
			Expect(k8sClient.Update(ctx, existing)).To(Succeed())

			By("Reconciling the invalid resource")
			controllerReconciler := &PolicyReconciler{
				client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}
			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			By("Checking the policy status reports the compile failure")
			updated := &policyv1alpha1.Policy{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(Succeed())
			Expect(updated.Status.Conditions).To(HaveLen(1))
			Expect(updated.Status.Conditions[0].Type).To(Equal("Ready"))
			Expect(updated.Status.Conditions[0].Status).To(Equal(metav1.ConditionFalse))
			Expect(updated.Status.Conditions[0].Reason).To(Equal("CompileFailed"))
		})
	})
})
