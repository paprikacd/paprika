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

var applicationsetlog = logf.Log.WithName("applicationset-resource")

// SetupApplicationSetWebhookWithManager registers the ApplicationSet webhooks.
func SetupApplicationSetWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.ApplicationSet{}).
		WithValidator(&ApplicationSetCustomValidator{}).
		WithDefaulter(&ApplicationSetCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up applicationset webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-applicationset,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=applicationsets,verbs=create;update,versions=v1alpha1,name=mapplicationset-v1alpha1.kb.io,admissionReviewVersions=v1

// ApplicationSetCustomDefaulter sets defaults for ApplicationSet.
type ApplicationSetCustomDefaulter struct{}

func (d *ApplicationSetCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.ApplicationSet) error {
	applicationsetlog.Info("Defaulting for ApplicationSet", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-applicationset,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=applicationsets,verbs=create;update,versions=v1alpha1,name=vapplicationset-v1alpha1.kb.io,admissionReviewVersions=v1

// ApplicationSetCustomValidator validates ApplicationSet resources.
type ApplicationSetCustomValidator struct{}

func (v *ApplicationSetCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.ApplicationSet) (admission.Warnings, error) {
	applicationsetlog.Info("Validation for ApplicationSet upon creation", "name", obj.GetName())
	return nil, validateApplicationSet(obj)
}

func (v *ApplicationSetCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.ApplicationSet) (admission.Warnings, error) {
	applicationsetlog.Info("Validation for ApplicationSet upon update", "name", newObj.GetName())
	return nil, validateApplicationSet(newObj)
}

func (v *ApplicationSetCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.ApplicationSet) (admission.Warnings, error) {
	applicationsetlog.Info("Validation for ApplicationSet upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateApplicationSet(appSet *pipelinesv1alpha1.ApplicationSet) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if len(appSet.Spec.Generators) == 0 {
		allErrs = append(allErrs, field.Required(specPath.Child("generators"), "at least one generator is required"))
	}

	for i, g := range appSet.Spec.Generators {
		genPath := specPath.Child("generators").Index(i)
		allErrs = append(allErrs, validateApplicationSetGenerator(g, genPath)...)
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "ApplicationSet"},
		appSet.Name,
		allErrs,
	)
}

func validateApplicationSetGenerator(g pipelinesv1alpha1.ApplicationSetGenerator, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	setCount := 0
	if g.List != nil {
		setCount++
		if len(g.List.Items) == 0 {
			errs = append(errs, field.Required(path.Child("list").Child("items"), "list generator must have at least one item"))
		}
	}
	if g.GitDirectories != nil {
		setCount++
		if g.GitDirectories.RepoURL == "" {
			errs = append(errs, field.Required(path.Child("gitDirectories").Child("repoUrl"), "repoUrl is required"))
		}
	}
	if g.Clusters != nil {
		setCount++
	}
	if g.Matrix != nil {
		setCount++
		errs = append(errs, validateNestedGenerator(g.Matrix.First, path.Child("matrix").Child("first"))...)
		errs = append(errs, validateNestedGenerator(g.Matrix.Second, path.Child("matrix").Child("second"))...)
	}
	if setCount != 1 {
		errs = append(errs, field.Invalid(path, g, "exactly one generator field must be set"))
	}
	return errs
}

func validateNestedGenerator(g pipelinesv1alpha1.NestedApplicationSetGenerator, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	setCount := 0
	if g.List != nil {
		setCount++
	}
	if g.GitDirectories != nil {
		setCount++
	}
	if g.Clusters != nil {
		setCount++
	}
	if setCount != 1 {
		errs = append(errs, field.Invalid(path, g, "exactly one nested generator field must be set"))
	}
	return errs
}
