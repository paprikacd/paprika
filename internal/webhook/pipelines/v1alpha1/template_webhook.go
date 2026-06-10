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
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const defaultTemplateType = "helm"

var validTemplateTypes = map[string]bool{
	"helm":       true,
	"kubernetes": true,
	"kustomize":  true,
}

//nolint:unused
var templatelog = logf.Log.WithName("template-resource")

func SetupTemplateWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Template{}).
		WithValidator(&TemplateCustomValidator{}).
		WithDefaulter(&TemplateCustomDefaulter{}).
		Complete()
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-template,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=templates,verbs=create;update,versions=v1alpha1,name=mtemplate-v1alpha1.kb.io,admissionReviewVersions=v1

type TemplateCustomDefaulter struct{}

func (d *TemplateCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Template) error {
	templatelog.Info("Defaulting for Template", "name", obj.GetName())

	if obj.Spec.Type == "" {
		obj.Spec.Type = defaultTemplateType
	}

	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-template,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=templates,verbs=create;update,versions=v1alpha1,name=vtemplate-v1alpha1.kb.io,admissionReviewVersions=v1

type TemplateCustomValidator struct{}

func (v *TemplateCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.Template) (admission.Warnings, error) {
	templatelog.Info("Validation for Template upon creation", "name", obj.GetName())
	if errs := v.validateTemplateCreate(obj); len(errs) > 0 {
		return nil, apierrors.NewInvalid(
			schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Template"},
			obj.Name,
			errs,
		)
	}
	return nil, nil
}

func (v *TemplateCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Template) (admission.Warnings, error) {
	templatelog.Info("Validation for Template upon update", "name", newObj.GetName())

	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if oldObj.Spec.Type != newObj.Spec.Type {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("type"), "Template type is immutable"))
	}

	if createErrs := v.validateTemplateCreate(newObj); len(createErrs) > 0 {
		allErrs = append(allErrs, createErrs...)
	}

	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Template"},
		newObj.Name,
		allErrs,
	)
}

func (v *TemplateCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Template) (admission.Warnings, error) {
	templatelog.Info("Validation for Template upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *TemplateCustomValidator) validateTemplateCreate(t *pipelinesv1alpha1.Template) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if t.Spec.Type == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("type"), "Template type is required"))
	} else if !validTemplateTypes[t.Spec.Type] {
		allErrs = append(allErrs, field.Invalid(specPath.Child("type"), t.Spec.Type, "Template type must be one of: helm, kubernetes, kustomize"))
	}

	if t.Spec.Type == "helm" {
		if t.Spec.Chart.Repo == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("chart").Child("repo"), "Chart repo is required"))
		}
		if t.Spec.Chart.Name == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("chart").Child("name"), "Chart name is required"))
		}
	}

	return allErrs
}
