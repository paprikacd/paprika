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

	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/internal/policy"
)

// policylog is used by the defaulting and validating webhooks.
var policylog = logf.Log.WithName("policy-resource")

// SetupPolicyWebhookWithManager registers the webhook for Policy in the manager.
func SetupPolicyWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &policyv1alpha1.Policy{}).
		WithValidator(&PolicyCustomValidator{}).
		WithDefaulter(&PolicyCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("failed to setup Policy webhook: %w", err)
	}
	return nil
}

// TODO(user): EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!

// +kubebuilder:webhook:path=/mutate-policy-paprika-io-v1alpha1-policy,mutating=true,failurePolicy=fail,sideEffects=None,groups=policy.paprika.io,resources=policies,verbs=create;update,versions=v1alpha1,name=mpolicy-v1alpha1.kb.io,admissionReviewVersions=v1

// PolicyCustomDefaulter struct is responsible for setting default values on the custom resource of the
// Kind Policy when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type PolicyCustomDefaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind Policy.
func (d *PolicyCustomDefaulter) Default(_ context.Context, obj *policyv1alpha1.Policy) error {
	policylog.Info("Defaulting for Policy", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}

// TODO(user): change verbs to "verbs=create;update;delete" if you want to enable deletion validation.
// NOTE: If you want to customise the 'path', use the flags '--defaulting-path' or '--validation-path'.
// +kubebuilder:webhook:path=/validate-policy-paprika-io-v1alpha1-policy,mutating=false,failurePolicy=fail,sideEffects=None,groups=policy.paprika.io,resources=policies,verbs=create;update,versions=v1alpha1,name=vpolicy-v1alpha1.kb.io,admissionReviewVersions=v1

// PolicyCustomValidator struct is responsible for validating the Policy resource
// when it is created, updated, or deleted.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as this struct is used only for temporary operations and does not need to be deeply copied.
type PolicyCustomValidator struct {
	// TODO(user): Add more fields as needed for validation
}

// ValidateCreate implements webhook.CustomValidator so a webhook will be registered for the type Policy.
func (v *PolicyCustomValidator) ValidateCreate(_ context.Context, p *policyv1alpha1.Policy) (admission.Warnings, error) {
	policylog.Info("Validation for Policy upon creation", "name", p.GetName())
	return nil, validatePolicy(p)
}

// ValidateUpdate implements webhook.CustomValidator so a webhook will be registered for the type Policy.
func (v *PolicyCustomValidator) ValidateUpdate(_ context.Context, _, p *policyv1alpha1.Policy) (admission.Warnings, error) {
	policylog.Info("Validation for Policy upon update", "name", p.GetName())
	return nil, validatePolicy(p)
}

// ValidateDelete implements webhook.CustomValidator so a webhook will be registered for the type Policy.
func (v *PolicyCustomValidator) ValidateDelete(_ context.Context, p *policyv1alpha1.Policy) (admission.Warnings, error) {
	policylog.Info("Validation for Policy upon deletion", "name", p.GetName())
	return nil, nil
}

func validatePolicy(p *policyv1alpha1.Policy) error {
	allErrs := make(field.ErrorList, 0, 4)
	path := field.NewPath("spec")

	allErrs = append(allErrs, validatePolicySeverity(p, path)...)
	allErrs = append(allErrs, validatePolicyExpression(p, path)...)
	allErrs = append(allErrs, validatePolicyDefaultAction(p, path)...)
	allErrs = append(allErrs, validatePolicyProjects(p, path)...)

	if len(allErrs) == 0 {
		return nil
	}
	return allErrs.ToAggregate()
}

func validatePolicySeverity(p *policyv1alpha1.Policy, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	if p.Spec.Severity == "" {
		errs = append(errs, field.Required(path.Child("severity"), ""))
		return errs
	}
	if p.Spec.Severity != policyv1alpha1.PolicySeverityCritical && p.Spec.Severity != policyv1alpha1.PolicySeverityWarning {
		errs = append(errs, field.NotSupported(path.Child("severity"), p.Spec.Severity, []string{
			string(policyv1alpha1.PolicySeverityCritical),
			string(policyv1alpha1.PolicySeverityWarning),
		}))
	}
	return errs
}

func validatePolicyExpression(p *policyv1alpha1.Policy, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	if p.Spec.Expression == "" {
		errs = append(errs, field.Required(path.Child("expression"), ""))
		return errs
	}
	if err := validateCELExpression(p.Spec.Expression); err != nil {
		errs = append(errs, field.Invalid(path.Child("expression"), p.Spec.Expression, err.Error()))
	}
	return errs
}

func validatePolicyDefaultAction(p *policyv1alpha1.Policy, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	if p.Spec.DefaultAction != "" &&
		p.Spec.DefaultAction != policyv1alpha1.PolicyActionEnforce &&
		p.Spec.DefaultAction != policyv1alpha1.PolicyActionWarn {
		errs = append(errs, field.NotSupported(path.Child("defaultAction"), p.Spec.DefaultAction, []string{
			string(policyv1alpha1.PolicyActionEnforce),
			string(policyv1alpha1.PolicyActionWarn),
		}))
	}
	return errs
}

func validatePolicyProjects(p *policyv1alpha1.Policy, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	seen := map[string]bool{}
	for i, pr := range p.Spec.Projects {
		if pr == "" {
			errs = append(errs, field.Required(path.Child("projects").Index(i), "project must not be empty"))
			continue
		}
		// "*" is accepted per the design spec and matches all projects.
		if seen[pr] {
			errs = append(errs, field.Duplicate(path.Child("projects").Index(i), pr))
			continue
		}
		seen[pr] = true
	}
	return errs
}

func validateCELExpression(expr string) error {
	if err := policy.CompileExpression(expr); err != nil {
		return fmt.Errorf("compile CEL expression: %w", err)
	}
	return nil
}
