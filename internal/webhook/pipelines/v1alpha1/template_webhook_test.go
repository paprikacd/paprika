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

var _ = Describe("Template Webhook", func() {
	var (
		obj       *pipelinesv1alpha1.Template
		oldObj    *pipelinesv1alpha1.Template
		validator TemplateCustomValidator
		defaulter TemplateCustomDefaulter
	)

	BeforeEach(func() {
		obj = &pipelinesv1alpha1.Template{}
		oldObj = &pipelinesv1alpha1.Template{}
		validator = TemplateCustomValidator{}
		defaulter = TemplateCustomDefaulter{}
	})

	Context("When creating Template under Defaulting Webhook", func() {
		It("Should default type to helm when empty", func() {
			obj.Spec.Type = ""
			Expect(defaulter.Default(ctx, obj)).To(Succeed())
			Expect(obj.Spec.Type).To(Equal(defaultTemplateType))
		})

		It("Should preserve type when already set", func() {
			obj.Spec.Type = "kubernetes"
			Expect(defaulter.Default(ctx, obj)).To(Succeed())
			Expect(obj.Spec.Type).To(Equal("kubernetes"))
		})
	})

	Context("When creating or updating Template under Validating Webhook", func() {
		Describe("ValidateCreate", func() {
			BeforeEach(func() {
				obj.Spec.Type = defaultTemplateType
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{Repo: "https://charts.example.com", Name: "nginx"}
			})

			It("Should admit creation with helm type and valid chart", func() {
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should admit creation with kubernetes type without chart", func() {
				obj.Spec.Type = "kubernetes"
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should admit creation with kustomize type without chart", func() {
				obj.Spec.Type = "kustomize"
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject creation with helm type and missing chart repo", func() {
				obj.Spec.Chart.Repo = ""
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Chart repo is required"))
			})

			It("Should reject creation with empty type", func() {
				obj.Spec.Type = ""
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Template type is required"))
			})

			It("Should reject creation with invalid type", func() {
				obj.Spec.Type = "invalid"
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Template type must be one of: helm, kubernetes, kustomize, git, s3"))
			})

			It("Should reject creation with helm type and missing chart name", func() {
				obj.Spec.Chart.Name = ""
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Chart name is required"))
			})

			It("Should reject creation with helm type and no chart", func() {
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{}
				_, err := validator.ValidateCreate(ctx, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Chart repo is required"))
			})

			It("Should admit creation with helm type and local chart path", func() {
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{Path: "/charts/local"}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should admit creation with git type", func() {
				obj.Spec.Type = "git"
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{}
				obj.Spec.Git = &pipelinesv1alpha1.GitSourceSpec{RepoURL: "https://github.com/example/repo"}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should admit creation with s3 type", func() {
				obj.Spec.Type = "s3"
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{}
				obj.Spec.S3 = &pipelinesv1alpha1.S3SourceSpec{Bucket: "my-bucket", Key: "path/to/source.tgz"}
				warnings, err := validator.ValidateCreate(ctx, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})
		})

		Describe("ValidateUpdate", func() {
			BeforeEach(func() {
				oldObj.Spec.Type = defaultTemplateType
				oldObj.Spec.Chart = pipelinesv1alpha1.ChartRef{Repo: "https://charts.example.com", Name: "nginx"}
				obj.Spec.Type = defaultTemplateType
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{Repo: "https://charts.example.com", Name: "nginx"}
			})

			It("Should admit update with no changes to immutable fields", func() {
				warnings, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).ToNot(HaveOccurred())
				Expect(warnings).To(BeNil())
			})

			It("Should reject update that changes type", func() {
				obj.Spec.Type = "kustomize"
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Template type is immutable"))
			})

			It("Should reject update that removes chart on helm type", func() {
				obj.Spec.Chart = pipelinesv1alpha1.ChartRef{}
				_, err := validator.ValidateUpdate(ctx, oldObj, obj)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("Chart repo is required"))
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
