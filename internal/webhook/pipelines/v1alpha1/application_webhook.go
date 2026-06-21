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
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

var applicationlog = logf.Log.WithName("application-resource")

// SetupApplicationWebhookWithManager registers the Application webhooks.
func SetupApplicationWebhookWithManager(mgr ctrl.Manager) error {
	resolver := governance.NewProjectResolver(mgr.GetClient())
	validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(mgr.GetClient()), mgr.GetRESTMapper())
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Application{}).
		WithValidator(&ApplicationCustomValidator{validator: validator, client: mgr.GetClient()}).
		WithDefaulter(&ApplicationCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up application webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-application,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=applications,verbs=create;update,versions=v1alpha1,name=mapplication-v1alpha1.kb.io,admissionReviewVersions=v1

type ApplicationCustomDefaulter struct{}

func (d *ApplicationCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Application) error {
	applicationlog.Info("Defaulting for Application", "name", obj.GetName())
	if obj.Spec.Project == "" {
		obj.Spec.Project = "default"
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-application,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=applications,verbs=create;update,versions=v1alpha1,name=vapplication-v1alpha1.kb.io,admissionReviewVersions=v1

type ApplicationCustomValidator struct {
	validator *governance.ProjectValidator
	client    client.Reader
}

func (v *ApplicationCustomValidator) ValidateCreate(ctx context.Context, obj *pipelinesv1alpha1.Application) (admission.Warnings, error) {
	applicationlog.Info("Validation for Application upon creation", "name", obj.GetName())
	if err := v.validateApplication(ctx, obj); err != nil {
		return nil, err
	}
	if err := v.enforceApplicationQuota(ctx, obj); err != nil {
		return nil, err
	}
	return nil, nil
}

func (v *ApplicationCustomValidator) ValidateUpdate(ctx context.Context, oldObj, newObj *pipelinesv1alpha1.Application) (admission.Warnings, error) {
	applicationlog.Info("Validation for Application upon update", "name", newObj.GetName())
	return nil, v.validateApplication(ctx, newObj)
}

func (v *ApplicationCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Application) (admission.Warnings, error) {
	applicationlog.Info("Validation for Application upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *ApplicationCustomValidator) validateApplication(ctx context.Context, app *pipelinesv1alpha1.Application) error {
	allErrs := v.validateSource(app)

	if len(app.Spec.Stages) == 0 {
		allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("stages"), "At least one stage is required"))
	}

	allErrs = append(allErrs, v.validateProject(ctx, app)...)

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Application"},
		app.Name,
		allErrs,
	)
}

// source type validation branches are inherent.
func (v *ApplicationCustomValidator) validateSource(app *pipelinesv1alpha1.Application) field.ErrorList {
	var allErrs field.ErrorList
	sourcePath := field.NewPath("spec").Child("source")

	if app.Spec.Source.Type == "" {
		allErrs = append(allErrs, field.Required(sourcePath.Child("type"), "Source type is required"))
		return allErrs
	}

	switch app.Spec.Source.Type {
	case pipelinesv1alpha1.SourceTypeInline:
		if app.Spec.Source.Inline == nil || app.Spec.Source.Inline.ConfigMapRef == "" {
			allErrs = append(allErrs, field.Required(sourcePath.Child("inline").Child("configMapRef"), "configMapRef is required for inline source"))
		}
	case pipelinesv1alpha1.SourceTypeGit:
		if app.Spec.Source.RepoURL == "" {
			allErrs = append(allErrs, field.Required(sourcePath.Child("repoUrl"), "Repo URL is required for git sources"))
		}
	case pipelinesv1alpha1.SourceTypeOCI:
		if oci := app.Spec.Source.EffectiveOCI(); oci == nil || oci.URL == "" {
			allErrs = append(allErrs, field.Required(sourcePath.Child("oci").Child("url"), "oci.url is required for oci sources"))
		}
	}
	return allErrs
}

func (v *ApplicationCustomValidator) validateProject(ctx context.Context, app *pipelinesv1alpha1.Application) field.ErrorList {
	var errs field.ErrorList
	if app.Spec.Project == "" {
		errs = append(errs, field.Required(field.NewPath("spec").Child("project"), "project is required"))
		return errs
	}
	if v.validator == nil {
		return errs
	}

	project, err := v.validator.ResolveProject(ctx, app.Namespace, app.Spec.Project)
	if err != nil {
		errs = append(errs, field.Forbidden(field.NewPath("spec").Child("project"), err.Error()))
		return errs
	}
	violations, err := v.validator.Validate(ctx, app, nil, project)
	if err != nil {
		errs = append(errs, field.InternalError(field.NewPath("spec").Child("project"), err))
		return errs
	}
	if blocking := violations.Blocking(); len(blocking) > 0 {
		errs = append(errs, field.Forbidden(field.NewPath("spec").Child("project"), blocking[0].Message))
	}
	return errs
}

// enforceApplicationQuota rejects Application creation when the governing
// AppProject has reached its MaxApplications limit. It is a no-op when the
// validator or client are unset (test harness), when no Limits are configured,
// or when MaxApplications is zero (unlimited).
//
//nolint:cyclop // quota enforcement has sequential guard branches.
func (v *ApplicationCustomValidator) enforceApplicationQuota(ctx context.Context, app *pipelinesv1alpha1.Application) error {
	if v.client == nil || v.validator == nil {
		return nil
	}
	projectName := app.Spec.Project
	if projectName == "" {
		projectName = "default"
	}
	project, err := v.validator.ResolveProject(ctx, app.Namespace, projectName)
	if err != nil {
		return apierrors.NewInternalError(fmt.Errorf("resolve project %s/%s: %w", app.Namespace, projectName, err))
	}
	if project == nil || project.Spec.Limits == nil || project.Spec.Limits.MaxApplications <= 0 {
		return nil
	}

	var apps pipelinesv1alpha1.ApplicationList
	if err := v.client.List(ctx, &apps, client.InNamespace(app.Namespace)); err != nil {
		return apierrors.NewInternalError(fmt.Errorf("list applications: %w", err))
	}
	count := 0
	for i := range apps.Items {
		name := apps.Items[i].Spec.Project
		if name == "" {
			name = "default"
		}
		if name == project.Name {
			count++
		}
	}
	if count >= project.Spec.Limits.MaxApplications {
		return apierrors.NewForbidden(
			schema.GroupResource{Group: "pipelines.paprika.io", Resource: "applications"},
			app.Name,
			fmt.Errorf("project %q has reached its MaxApplications limit of %d (current count: %d)", project.Name, project.Spec.Limits.MaxApplications, count),
		)
	}
	return nil
}
