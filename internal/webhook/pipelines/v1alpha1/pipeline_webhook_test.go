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

var _ = Describe("Pipeline Webhook", func() {
	var (
		obj       *pipelinesv1alpha1.Pipeline
		oldObj    *pipelinesv1alpha1.Pipeline
		validator PipelineCustomValidator
		defaulter PipelineCustomDefaulter
	)

	BeforeEach(func() {
		obj = &pipelinesv1alpha1.Pipeline{}
		oldObj = &pipelinesv1alpha1.Pipeline{}
		validator = PipelineCustomValidator{}
		defaulter = PipelineCustomDefaulter{}
	})

	Context("When creating Pipeline under Defaulting Webhook", func() {
		It("Should apply no defaults and succeed", func() {
			Expect(defaulter.Default(ctx, obj)).To(Succeed())
		})
	})

	Context("When creating or updating Pipeline under Validating Webhook", func() {
		Describe("ValidateCreate", func() {
			It("Should admit creation with valid steps", func() {
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: "go build"},
					{Name: "test", Image: "golang:1.22", Script: "go test"},
				}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject creation with no steps", func() {
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Must have at least one step"))
			})

			It("Should reject creation with nil steps", func() {
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Must have at least one step"))
			})

			It("Should reject creation with step missing name", func() {
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "", Image: "golang:1.22", Script: "go build"},
				}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Step name is required"))
			})

			It("Should reject creation with step missing image", func() {
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "", Script: "go build"},
				}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Step image is required"))
			})

			It("Should reject creation with step missing script", func() {
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: ""},
				}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Step script is required"))
			})

			It("Should reject creation with duplicate step names", func() {
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: "go build"},
					{Name: "build", Image: "node:20", Script: "npm build"},
				}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Step name must be unique"))
			})
		})

		Describe("ValidateUpdate", func() {
			It("Should admit update with valid steps", func() {
				oldObj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: "go build"},
				}
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.23", Script: "go build"},
				}
				warnings, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject update with no steps", func() {
				oldObj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: "go build"},
				}
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{}
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Must have at least one step"))
			})

			It("Should reject update with duplicate step names", func() {
				oldObj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: "go build"},
				}
				obj.Spec.Steps = []pipelinesv1alpha1.PipelineStep{
					{Name: "build", Image: "golang:1.22", Script: "go build"},
					{Name: "build", Image: "node:20", Script: "npm build"},
				}
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Step name must be unique"))
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
