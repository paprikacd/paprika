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

	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
)

// log is for logging in this package.
var featureflagbindinglog = logf.Log.WithName("featureflagbinding-resource")

// SetupFeatureFlagBindingWebhookWithManager registers the webhook for FeatureFlagBinding in the manager.
func SetupFeatureFlagBindingWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &featureflagsv1alpha1.FeatureFlagBinding{}).
		WithValidator(&FeatureFlagBindingCustomValidator{}).
		WithDefaulter(&FeatureFlagBindingCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up featureflagbinding webhook: %w", err)
	}
	return nil
}

// TODO(user): EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!

// +kubebuilder:webhook:path=/mutate-featureflags-paprika-io-v1alpha1-featureflagbinding,mutating=true,failurePolicy=fail,sideEffects=None,groups=featureflags.paprika.io,resources=featureflagbindings,verbs=create;update,versions=v1alpha1,name=mfeatureflagbinding-v1alpha1.kb.io,admissionReviewVersions=v1

// FeatureFlagBindingCustomDefaulter struct is responsible for setting default values on the custom resource of the
// Kind FeatureFlagBinding when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type FeatureFlagBindingCustomDefaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind FeatureFlagBinding.
func (d *FeatureFlagBindingCustomDefaulter) Default(_ context.Context, obj *featureflagsv1alpha1.FeatureFlagBinding) error {
	featureflagbindinglog.Info("Defaulting for FeatureFlagBinding", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}

// TODO(user): change verbs to "verbs=create;update;delete" if you want to enable deletion validation.
// NOTE: If you want to customise the 'path', use the flags '--defaulting-path' or '--validation-path'.
// +kubebuilder:webhook:path=/validate-featureflags-paprika-io-v1alpha1-featureflagbinding,mutating=false,failurePolicy=fail,sideEffects=None,groups=featureflags.paprika.io,resources=featureflagbindings,verbs=create;update,versions=v1alpha1,name=vfeatureflagbinding-v1alpha1.kb.io,admissionReviewVersions=v1

// FeatureFlagBindingCustomValidator struct is responsible for validating the FeatureFlagBinding resource
// when it is created, updated, or deleted.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as this struct is used only for temporary operations and does not need to be deeply copied.
type FeatureFlagBindingCustomValidator struct {
	// TODO(user): Add more fields as needed for validation
}

// ValidateCreate implements webhook.CustomValidator so a webhook will be registered for the type FeatureFlagBinding.
func (v *FeatureFlagBindingCustomValidator) ValidateCreate(_ context.Context, obj *featureflagsv1alpha1.FeatureFlagBinding) (admission.Warnings, error) {
	featureflagbindinglog.Info("Validation for FeatureFlagBinding upon creation", "name", obj.GetName())
	return nil, validateFeatureFlagBinding(obj)
}

// ValidateUpdate implements webhook.CustomValidator so a webhook will be registered for the type FeatureFlagBinding.
func (v *FeatureFlagBindingCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *featureflagsv1alpha1.FeatureFlagBinding) (admission.Warnings, error) {
	featureflagbindinglog.Info("Validation for FeatureFlagBinding upon update", "name", newObj.GetName())
	return nil, validateFeatureFlagBinding(newObj)
}

// ValidateDelete implements webhook.CustomValidator so a webhook will be registered for the type FeatureFlagBinding.
func (v *FeatureFlagBindingCustomValidator) ValidateDelete(_ context.Context, obj *featureflagsv1alpha1.FeatureFlagBinding) (admission.Warnings, error) {
	featureflagbindinglog.Info("Validation for FeatureFlagBinding upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateFeatureFlagBinding(binding *featureflagsv1alpha1.FeatureFlagBinding) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if binding.Spec.FlagRef == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("flagRef"), "flagRef is required"))
	}

	targetPath := specPath.Child("target")
	if binding.Spec.Target.Kind == "" {
		allErrs = append(allErrs, field.Required(targetPath.Child("kind"), "target kind is required"))
	} else {
		switch binding.Spec.Target.Kind {
		case "Rollout", "Deployment":
			if binding.Spec.Target.Name == "" && binding.Spec.Target.Selector == nil {
				allErrs = append(allErrs, field.Required(targetPath, fmt.Sprintf("target name or selector is required for %q", binding.Spec.Target.Kind)))
			}
		case "Namespace":
			// Namespace targets do not require a name or selector.
		default:
			allErrs = append(allErrs, field.NotSupported(targetPath.Child("kind"), binding.Spec.Target.Kind, []string{"Rollout", "Deployment", "Namespace"}))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "featureflags.paprika.io", Kind: "FeatureFlagBinding"},
		binding.Name,
		allErrs,
	)
}
