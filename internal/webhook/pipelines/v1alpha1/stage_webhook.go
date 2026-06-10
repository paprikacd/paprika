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
	"reflect"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

//nolint:unused
var stagelog = logf.Log.WithName("stage-resource")

func SetupStageWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Stage{}).
		WithValidator(&StageCustomValidator{}).
		WithDefaulter(&StageCustomDefaulter{}).
		Complete()
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-stage,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=stages,verbs=create;update,versions=v1alpha1,name=mstage-v1alpha1.kb.io,admissionReviewVersions=v1

type StageCustomDefaulter struct{}

func (d *StageCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Stage) error {
	stagelog.Info("Defaulting for Stage", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-stage,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=stages,verbs=create;update,versions=v1alpha1,name=vstage-v1alpha1.kb.io,admissionReviewVersions=v1

type StageCustomValidator struct{}

func (v *StageCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.Stage) (admission.Warnings, error) {
	stagelog.Info("Validation for Stage upon creation", "name", obj.GetName())
	if errs := v.validateStageCreate(obj); len(errs) > 0 {
		return nil, apierrors.NewInvalid(
			schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Stage"},
			obj.Name,
			errs,
		)
	}
	return nil, nil
}

func (v *StageCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Stage) (admission.Warnings, error) {
	stagelog.Info("Validation for Stage upon update", "name", newObj.GetName())

	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if !reflect.DeepEqual(oldObj.Spec.Templates, newObj.Spec.Templates) {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("templates"), "Template list is immutable"))
	}

	if !reflect.DeepEqual(oldObj.Spec.Cluster, newObj.Spec.Cluster) {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("cluster"), "Cluster reference is immutable"))
	}

	if createErrs := v.validateStageCreate(newObj); len(createErrs) > 0 {
		allErrs = append(allErrs, createErrs...)
	}

	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Stage"},
		newObj.Name,
		allErrs,
	)
}

func (v *StageCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Stage) (admission.Warnings, error) {
	stagelog.Info("Validation for Stage upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *StageCustomValidator) validateStageCreate(s *pipelinesv1alpha1.Stage) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if s.Spec.Name == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("name"), "Stage name is required"))
	}

	templatesPath := specPath.Child("templates")
	if len(s.Spec.Templates) == 0 {
		allErrs = append(allErrs, field.Invalid(templatesPath, s.Spec.Templates, "Must have at least one template"))
	}
	for i, tmpl := range s.Spec.Templates {
		if tmpl == "" {
			allErrs = append(allErrs, field.Required(templatesPath.Index(i), "Template name must not be empty"))
		}
	}

	return allErrs
}
