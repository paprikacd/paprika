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

const (
	testPipelineRef = "my-pipeline"
	testTargetStage = "production"
)

var _ = Describe("Release Webhook", func() {
	var (
		obj       *pipelinesv1alpha1.Release
		oldObj    *pipelinesv1alpha1.Release
		validator ReleaseCustomValidator
		defaulter ReleaseCustomDefaulter
	)

	BeforeEach(func() {
		obj = &pipelinesv1alpha1.Release{}
		oldObj = &pipelinesv1alpha1.Release{}
		validator = ReleaseCustomValidator{}
		defaulter = ReleaseCustomDefaulter{}
	})

	Context("When creating Release under Defaulting Webhook", func() {
		It("Should apply no defaults and succeed", func() {
			Expect(defaulter.Default(ctx, obj)).To(Succeed())
		})
	})

	Context("When creating or updating Release under Validating Webhook", func() {
		Describe("ValidateCreate", func() {
			It("Should admit creation with valid fields", func() {
				obj.Spec.Pipeline = testPipelineRef
				obj.Spec.Target = testTargetStage
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should admit creation with empty pipeline reference (direct chart deploy)", func() {
				obj.Spec.Target = testTargetStage
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject creation with empty target stage", func() {
				obj.Spec.Pipeline = testPipelineRef
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Target stage is required"))
			})

			It("Should reject creation with both fields empty", func() {
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Target stage is required"))
			})

			It("Should reject creation with inline manifest source missing configMapRef", func() {
				obj.Spec.Target = testTargetStage
				obj.Spec.ManifestSource = &pipelinesv1alpha1.ManifestSource{ConfigMapRef: ""}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("configMapRef is required for inline manifest source"))
			})

			It("Should admit creation with valid inline manifest source", func() {
				obj.Spec.Target = testTargetStage
				obj.Spec.ManifestSource = &pipelinesv1alpha1.ManifestSource{ConfigMapRef: "snapshot-cm"}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})
		})

		Describe("ValidateUpdate", func() {
			BeforeEach(func() {
				oldObj.Spec.Pipeline = testPipelineRef
				oldObj.Spec.Target = testTargetStage
				obj.Spec.Pipeline = testPipelineRef
				obj.Spec.Target = testTargetStage
			})

			It("Should admit update with no changes to immutable fields", func() {
				warnings, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject update that changes pipeline reference", func() {
				obj.Spec.Pipeline = "different-pipeline"
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Pipeline reference is immutable"))
			})

			It("Should reject update that changes target stage", func() {
				obj.Spec.Target = "staging"
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Target stage is immutable"))
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
