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
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var releaselog = logf.Log.WithName("release-resource")

func SetupReleaseWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Release{}).
		WithValidator(&ReleaseCustomValidator{}).
		WithDefaulter(&ReleaseCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up release webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-release,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=releases,verbs=create;update,versions=v1alpha1,name=mrelease-v1alpha1.kb.io,admissionReviewVersions=v1

type ReleaseCustomDefaulter struct{}

func (d *ReleaseCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Release) error {
	releaselog.Info("Defaulting for Release", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-release,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=releases,verbs=create;update,versions=v1alpha1,name=vrelease-v1alpha1.kb.io,admissionReviewVersions=v1

type ReleaseCustomValidator struct{}

func (v *ReleaseCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.Release) (admission.Warnings, error) {
	releaselog.Info("Validation for Release upon creation", "name", obj.GetName())
	if errs := v.validateReleaseCreate(obj); len(errs) > 0 {
		return nil, apierrors.NewInvalid(
			schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Release"},
			obj.Name,
			errs,
		)
	}
	return nil, nil
}

func (v *ReleaseCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Release) (admission.Warnings, error) {
	releaselog.Info("Validation for Release upon update", "name", newObj.GetName())

	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if oldObj.Spec.Pipeline != newObj.Spec.Pipeline {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("pipeline"), "Pipeline reference is immutable"))
	}

	if oldObj.Spec.Target != newObj.Spec.Target {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("target"), "Target stage is immutable"))
	}

	if createErrs := v.validateReleaseCreate(newObj); len(createErrs) > 0 {
		allErrs = append(allErrs, createErrs...)
	}

	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Release"},
		newObj.Name,
		allErrs,
	)
}

func (v *ReleaseCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Release) (admission.Warnings, error) {
	releaselog.Info("Validation for Release upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *ReleaseCustomValidator) validateReleaseCreate(r *pipelinesv1alpha1.Release) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	// Pipeline is optional when there are no build steps (direct chart deploy).
	// It is required when the release follows a build pipeline.

	if r.Spec.Target == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("target"), "Target stage is required"))
	}

	if r.Spec.ManifestSource != nil && r.Spec.ManifestSource.ConfigMapRef == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("manifestSource").Child("configMapRef"), "configMapRef is required for inline manifest source"))
	}

	return allErrs
}
