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
	"github.com/benebsworth/paprika/internal/featureflag"
)

// log is for logging in this package.
var featureflaglog = logf.Log.WithName("featureflag-resource")

// SetupFeatureFlagWebhookWithManager registers the webhook for FeatureFlag in the manager.
func SetupFeatureFlagWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &featureflagsv1alpha1.FeatureFlag{}).
		WithValidator(&FeatureFlagCustomValidator{}).
		WithDefaulter(&FeatureFlagCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up featureflag webhook: %w", err)
	}
	return nil
}

// TODO(user): EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!

// +kubebuilder:webhook:path=/mutate-featureflags-paprika-io-v1alpha1-featureflag,mutating=true,failurePolicy=fail,sideEffects=None,groups=featureflags.paprika.io,resources=featureflags,verbs=create;update,versions=v1alpha1,name=mfeatureflag-v1alpha1.kb.io,admissionReviewVersions=v1

// FeatureFlagCustomDefaulter struct is responsible for setting default values on the custom resource of the
// Kind FeatureFlag when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type FeatureFlagCustomDefaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind FeatureFlag.
func (d *FeatureFlagCustomDefaulter) Default(_ context.Context, obj *featureflagsv1alpha1.FeatureFlag) error {
	featureflaglog.Info("Defaulting for FeatureFlag", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}

// TODO(user): change verbs to "verbs=create;update;delete" if you want to enable deletion validation.
// NOTE: If you want to customise the 'path', use the flags '--defaulting-path' or '--validation-path'.
// +kubebuilder:webhook:path=/validate-featureflags-paprika-io-v1alpha1-featureflag,mutating=false,failurePolicy=fail,sideEffects=None,groups=featureflags.paprika.io,resources=featureflags,verbs=create;update,versions=v1alpha1,name=vfeatureflag-v1alpha1.kb.io,admissionReviewVersions=v1

// FeatureFlagCustomValidator struct is responsible for validating the FeatureFlag resource
// when it is created, updated, or deleted.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as this struct is used only for temporary operations and does not need to be deeply copied.
type FeatureFlagCustomValidator struct {
	// TODO(user): Add more fields as needed for validation
}

// ValidateCreate implements webhook.CustomValidator so a webhook will be registered for the type FeatureFlag.
func (v *FeatureFlagCustomValidator) ValidateCreate(_ context.Context, obj *featureflagsv1alpha1.FeatureFlag) (admission.Warnings, error) {
	featureflaglog.Info("Validation for FeatureFlag upon creation", "name", obj.GetName())
	return nil, validateFeatureFlag(obj)
}

// ValidateUpdate implements webhook.CustomValidator so a webhook will be registered for the type FeatureFlag.
func (v *FeatureFlagCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *featureflagsv1alpha1.FeatureFlag) (admission.Warnings, error) {
	featureflaglog.Info("Validation for FeatureFlag upon update", "name", newObj.GetName())
	return nil, validateFeatureFlag(newObj)
}

// ValidateDelete implements webhook.CustomValidator so a webhook will be registered for the type FeatureFlag.
func (v *FeatureFlagCustomValidator) ValidateDelete(_ context.Context, obj *featureflagsv1alpha1.FeatureFlag) (admission.Warnings, error) {
	featureflaglog.Info("Validation for FeatureFlag upon deletion", "name", obj.GetName())
	return nil, nil
}

//nolint:cyclop // feature flag validation has sequential type checks.
func validateFeatureFlag(flag *featureflagsv1alpha1.FeatureFlag) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if flag.Spec.Type == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("type"), "flag type is required"))
	} else if flag.Spec.Type != "boolean" && flag.Spec.Type != "string" && flag.Spec.Type != "int" && flag.Spec.Type != "float" {
		allErrs = append(allErrs, field.NotSupported(specPath.Child("type"), flag.Spec.Type, []string{"boolean", "string", "int", "float"}))
	}

	if err := featureflag.ValidateDefaultValue(flag.Spec.Type, flag.Spec.DefaultValue); err != nil {
		allErrs = append(allErrs, field.Invalid(specPath.Child("defaultValue"), flag.Spec.DefaultValue, err.Error()))
	}

	for i, rule := range flag.Spec.Rules {
		rulePath := specPath.Child("rules").Index(i)
		if rule.Condition == "" {
			allErrs = append(allErrs, field.Required(rulePath.Child("condition"), "rule condition is required"))
		} else if err := featureflag.ValidateCondition(rule.Condition); err != nil {
			allErrs = append(allErrs, field.Invalid(rulePath.Child("condition"), rule.Condition, err.Error()))
		}
		if err := featureflag.ValidateValue(flag.Spec.Type, rule.Value); err != nil {
			allErrs = append(allErrs, field.Invalid(rulePath.Child("value"), rule.Value, err.Error()))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "featureflags.paprika.io", Kind: "FeatureFlag"},
		flag.Name,
		allErrs,
	)
}
