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

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

var appprojectlog = logf.Log.WithName("appproject-resource")

// SetupAppProjectWebhookWithManager registers the AppProject webhooks.
func SetupAppProjectWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &corev1alpha1.AppProject{}).
		WithValidator(&AppProjectCustomValidator{}).
		WithDefaulter(&AppProjectCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up appproject webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-core-paprika-io-v1alpha1-appproject,mutating=true,failurePolicy=fail,sideEffects=None,groups=core.paprika.io,resources=appprojects,verbs=create;update,versions=v1alpha1,name=mappproject-v1alpha1.kb.io,admissionReviewVersions=v1

type AppProjectCustomDefaulter struct{}

func (d *AppProjectCustomDefaulter) Default(_ context.Context, obj *corev1alpha1.AppProject) error {
	appprojectlog.Info("Defaulting for AppProject", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-core-paprika-io-v1alpha1-appproject,mutating=false,failurePolicy=fail,sideEffects=None,groups=core.paprika.io,resources=appprojects,verbs=create;update,versions=v1alpha1,name=vappproject-v1alpha1.kb.io,admissionReviewVersions=v1

type AppProjectCustomValidator struct{}

func (v *AppProjectCustomValidator) ValidateCreate(_ context.Context, obj *corev1alpha1.AppProject) (admission.Warnings, error) {
	appprojectlog.Info("Validation for AppProject upon creation", "name", obj.GetName())
	return nil, v.validateAppProject(obj)
}

func (v *AppProjectCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *corev1alpha1.AppProject) (admission.Warnings, error) {
	appprojectlog.Info("Validation for AppProject upon update", "name", newObj.GetName())
	return nil, v.validateAppProject(newObj)
}

func (v *AppProjectCustomValidator) ValidateDelete(_ context.Context, obj *corev1alpha1.AppProject) (admission.Warnings, error) {
	appprojectlog.Info("Validation for AppProject upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *AppProjectCustomValidator) validateAppProject(project *corev1alpha1.AppProject) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if err := validateNoOverlap(project.Spec.SourceRepos, project.Spec.SourceReposDeny, specPath.Child("sourceRepos"), specPath.Child("sourceReposDeny")); err != nil {
		allErrs = append(allErrs, err)
	}
	if err := validateNoOverlap(project.Spec.Kinds, project.Spec.KindsDeny, specPath.Child("kinds"), specPath.Child("kindsDeny")); err != nil {
		allErrs = append(allErrs, err)
	}

	for i, d := range project.Spec.Destinations {
		if d.Server == "" && d.Namespace == "" && d.Name == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("destinations").Index(i), "at least one of server, namespace, or name is required"))
		}
	}
	for i, k := range project.Spec.Kinds {
		if k == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("kinds").Index(i), "kind must not be empty"))
		}
	}
	for i, k := range project.Spec.ClusterResourceWhitelist {
		if k == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("clusterResourceWhitelist").Index(i), "kind must not be empty"))
		}
	}
	for i, k := range project.Spec.ClusterResourceBlacklist {
		if k == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("clusterResourceBlacklist").Index(i), "kind must not be empty"))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "core.paprika.io", Kind: "AppProject"},
		project.Name,
		allErrs,
	)
}

func validateNoOverlap(allowed, denied []string, allowedPath, deniedPath *field.Path) *field.Error {
	for _, d := range denied {
		for _, a := range allowed {
			if a == d {
				return field.Invalid(deniedPath, d, fmt.Sprintf("value %q also appears in allow list %s", d, allowedPath.String()))
			}
		}
	}
	return nil
}
