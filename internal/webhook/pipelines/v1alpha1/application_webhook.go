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
	"github.com/benebsworth/paprika/internal/api/auth"
)

var applicationlog = logf.Log.WithName("application-resource")

// SetupApplicationWebhookWithManager registers the Application webhooks.
func SetupApplicationWebhookWithManager(mgr ctrl.Manager) error {
	enforcer := auth.NewProjectEnforcer(mgr.GetClient())
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Application{}).
		WithValidator(&ApplicationCustomValidator{enforcer: enforcer}).
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
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-application,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=applications,verbs=create;update,versions=v1alpha1,name=vapplication-v1alpha1.kb.io,admissionReviewVersions=v1

type ApplicationCustomValidator struct {
	enforcer *auth.ProjectEnforcer
}

func (v *ApplicationCustomValidator) ValidateCreate(ctx context.Context, obj *pipelinesv1alpha1.Application) (admission.Warnings, error) {
	applicationlog.Info("Validation for Application upon creation", "name", obj.GetName())
	return nil, v.validateApplication(ctx, obj)
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
	var allErrs field.ErrorList

	if app.Spec.Source.Type == "" {
		allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("source").Child("type"), "Source type is required"))
	}
	if app.Spec.Source.Type == pipelinesv1alpha1.SourceTypeGit && app.Spec.Source.RepoURL == "" {
		allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("source").Child("repoUrl"), "Repo URL is required for git sources"))
	}
	if len(app.Spec.Stages) == 0 {
		allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("stages"), "At least one stage is required"))
	}

	if app.Spec.Project != "" && v.enforcer != nil {
		if err := v.enforcer.AuthorizeApplication(ctx, app.Namespace, app.Spec.Project, app.Spec.Source.RepoURL, app.Spec.Source.RepoRef, ""); err != nil {
			allErrs = append(allErrs, field.Forbidden(field.NewPath("spec").Child("project"), err.Error()))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Application"},
		app.Name,
		allErrs,
	)
}
