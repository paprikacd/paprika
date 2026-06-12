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
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

var repositorylog = logf.Log.WithName("repository-resource")

// SetupRepositoryWebhookWithManager registers the Repository webhooks.
func SetupRepositoryWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &corev1alpha1.Repository{}).
		WithValidator(&RepositoryCustomValidator{}).
		WithDefaulter(&RepositoryCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up repository webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-core-paprika-io-v1alpha1-repository,mutating=true,failurePolicy=fail,sideEffects=None,groups=core.paprika.io,resources=repositories,verbs=create;update,versions=v1alpha1,name=mrepository-v1alpha1.kb.io,admissionReviewVersions=v1

type RepositoryCustomDefaulter struct{}

func (d *RepositoryCustomDefaulter) Default(_ context.Context, obj *corev1alpha1.Repository) error {
	repositorylog.Info("Defaulting for Repository", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-core-paprika-io-v1alpha1-repository,mutating=false,failurePolicy=fail,sideEffects=None,groups=core.paprika.io,resources=repositories,verbs=create;update,versions=v1alpha1,name=vrepository-v1alpha1.kb.io,admissionReviewVersions=v1

type RepositoryCustomValidator struct{}

func (v *RepositoryCustomValidator) ValidateCreate(_ context.Context, obj *corev1alpha1.Repository) (admission.Warnings, error) {
	repositorylog.Info("Validation for Repository upon creation", "name", obj.GetName())
	return nil, v.validateRepository(obj)
}

func (v *RepositoryCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *corev1alpha1.Repository) (admission.Warnings, error) {
	repositorylog.Info("Validation for Repository upon update", "name", newObj.GetName())
	return nil, v.validateRepository(newObj)
}

func (v *RepositoryCustomValidator) ValidateDelete(_ context.Context, obj *corev1alpha1.Repository) (admission.Warnings, error) {
	repositorylog.Info("Validation for Repository upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *RepositoryCustomValidator) validateRepository(repo *corev1alpha1.Repository) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if repo.Spec.Type == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("type"), "Repository type is required"))
	}
	if repo.Spec.URL == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("url"), "Repository URL is required"))
	}

	allErrs = append(allErrs, validateRepositoryByType(repo, specPath)...)

	if repo.Spec.SecretRef != nil && repo.Spec.SecretRef.Name == "" {
		allErrs = append(allErrs, field.Required(
			specPath.Child("secretRef").Child("name"), "secretRef name is required"))
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "core.paprika.io", Kind: "Repository"},
		repo.Name,
		allErrs,
	)
}

func validateRepositoryByType(repo *corev1alpha1.Repository, specPath *field.Path) field.ErrorList {
	var allErrs field.ErrorList
	urlPath := specPath.Child("url")

	switch repo.Spec.Type {
	case corev1alpha1.RepositoryTypeOCI:
		allErrs = append(allErrs, validateOCIURL(repo.Spec.URL, urlPath)...)
	case corev1alpha1.RepositoryTypeHelm:
		allErrs = append(allErrs, validateHelmURL(repo, specPath)...)
	case corev1alpha1.RepositoryTypeGit:
		allErrs = append(allErrs, validateGitURL(repo, specPath)...)
	}
	return allErrs
}

func validateOCIURL(url string, urlPath *field.Path) field.ErrorList {
	if strings.HasPrefix(url, "oci://") {
		return nil
	}
	return field.ErrorList{field.Invalid(
		urlPath, url,
		"oci repository URL must use oci:// scheme")}
}

func validateHelmURL(repo *corev1alpha1.Repository, specPath *field.Path) field.ErrorList {
	var allErrs field.ErrorList
	urlPath := specPath.Child("url")
	if strings.HasPrefix(repo.Spec.URL, "oci://") {
		allErrs = append(allErrs, field.Invalid(
			urlPath, repo.Spec.URL,
			"helm repository URL must not use oci:// scheme (use type=oci instead)"))
	}
	if repo.Spec.Insecure && !strings.HasPrefix(repo.Spec.URL, "http://") {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("insecure"), repo.Spec.Insecure,
			"insecure is only valid for http:// or oci:// URLs"))
	}
	return allErrs
}

func validateGitURL(repo *corev1alpha1.Repository, specPath *field.Path) field.ErrorList {
	var allErrs field.ErrorList
	urlPath := specPath.Child("url")
	if strings.HasPrefix(repo.Spec.URL, "oci://") {
		allErrs = append(allErrs, field.Invalid(
			urlPath, repo.Spec.URL,
			"git repository URL must not use oci:// scheme (use type=oci instead)"))
	}
	if repo.Spec.GitHubApp != nil && (repo.Spec.GitHubApp.AppID == "" || repo.Spec.GitHubApp.InstallationID == "") {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("githubApp"), repo.Spec.GitHubApp,
			"githubApp requires both appId and installationId"))
	}
	return allErrs
}
