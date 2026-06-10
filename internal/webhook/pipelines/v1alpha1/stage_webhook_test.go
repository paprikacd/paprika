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

package v1alpha1

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const testStageName = "canary"

var _ = Describe("Stage Webhook", func() {
	var (
		obj       *pipelinesv1alpha1.Stage
		oldObj    *pipelinesv1alpha1.Stage
		validator StageCustomValidator
		defaulter StageCustomDefaulter
	)

	BeforeEach(func() {
		obj = &pipelinesv1alpha1.Stage{}
		oldObj = &pipelinesv1alpha1.Stage{}
		validator = StageCustomValidator{}
		defaulter = StageCustomDefaulter{}
	})

	Context("When creating Stage under Defaulting Webhook", func() {
		It("Should apply no defaults and succeed", func() {
			Expect(defaulter.Default(ctx, obj)).To(Succeed())
		})
	})

	Context("When creating or updating Stage under Validating Webhook", func() {
		Describe("ValidateCreate", func() {
			It("Should admit creation with valid fields", func() {
				obj.Spec.Name = testStageName
				obj.Spec.Templates = []string{"nginx-template"}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject creation with empty name", func() {
				obj.Spec.Templates = []string{"nginx-template"}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Stage name is required"))
			})

			It("Should reject creation with no templates", func() {
				obj.Spec.Name = testStageName
				obj.Spec.Templates = []string{}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Must have at least one template"))
			})

			It("Should reject creation with nil templates", func() {
				obj.Spec.Name = testStageName
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Must have at least one template"))
			})

			It("Should reject creation with empty template name", func() {
				obj.Spec.Name = testStageName
				obj.Spec.Templates = []string{""}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Template name must not be empty"))
			})

			It("Should admit creation with cluster set", func() {
				obj.Spec.Name = testStageName
				obj.Spec.Templates = []string{"nginx-template"}
				obj.Spec.Cluster = pipelinesv1alpha1.ClusterRef{Name: "prod-cluster"}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})
		})

		Describe("ValidateUpdate", func() {
			BeforeEach(func() {
				oldObj.Spec.Name = testStageName
				oldObj.Spec.Templates = []string{"nginx-template"}
				obj.Spec.Name = testStageName
				obj.Spec.Templates = []string{"nginx-template"}
			})

			It("Should admit update with no changes to immutable fields", func() {
				warnings, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject update that changes template list", func() {
				obj.Spec.Templates = []string{"different-template"}
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Template list is immutable"))
			})

			It("Should reject update that changes cluster", func() {
				oldObj.Spec.Cluster = pipelinesv1alpha1.ClusterRef{Name: "old-cluster"}
				obj.Spec.Cluster = pipelinesv1alpha1.ClusterRef{Name: "new-cluster"}
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Cluster reference is immutable"))
			})

			It("Should reject update that makes templates empty", func() {
				obj.Spec.Templates = []string{}
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Template list is immutable"))
			})
		})

		Describe("ValidateDelete", func() {
			It("Should always admit deletion", func() {
				warnings, err := validator.ValidateDelete(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})
		})
	})
})
