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

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var conftestpolicylog = logf.Log.WithName("conftestpolicy-resource")

// SetupConftestPolicyWebhookWithManager registers the ConftestPolicy webhooks.
func SetupConftestPolicyWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.ConftestPolicy{}).
		WithValidator(&ConftestPolicyCustomValidator{}).
		WithDefaulter(&ConftestPolicyCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up conftestpolicy webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-conftestpolicy,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=conftestpolicies,verbs=create;update,versions=v1alpha1,name=mconftestpolicy-v1alpha1.kb.io,admissionReviewVersions=v1

// ConftestPolicyCustomDefaulter sets defaults for ConftestPolicy.
type ConftestPolicyCustomDefaulter struct{}

func (d *ConftestPolicyCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.ConftestPolicy) error {
	conftestpolicylog.Info("Defaulting for ConftestPolicy", "name", obj.GetName())
	if obj.Spec.Enforcement == "" {
		obj.Spec.Enforcement = pipelinesv1alpha1.ConftestEnforce
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-conftestpolicy,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=conftestpolicies,verbs=create;update,versions=v1alpha1,name=vconftestpolicy-v1alpha1.kb.io,admissionReviewVersions=v1

// ConftestPolicyCustomValidator validates ConftestPolicy resources.
type ConftestPolicyCustomValidator struct{}

func (v *ConftestPolicyCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.ConftestPolicy) (admission.Warnings, error) {
	conftestpolicylog.Info("Validation for ConftestPolicy upon creation", "name", obj.GetName())
	return nil, validateConftestPolicy(obj)
}

func (v *ConftestPolicyCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.ConftestPolicy) (admission.Warnings, error) {
	conftestpolicylog.Info("Validation for ConftestPolicy upon update", "name", newObj.GetName())
	return nil, validateConftestPolicy(newObj)
}

func (v *ConftestPolicyCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.ConftestPolicy) (admission.Warnings, error) {
	conftestpolicylog.Info("Validation for ConftestPolicy upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateConftestPolicy(policy *pipelinesv1alpha1.ConftestPolicy) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if strings.TrimSpace(policy.Spec.Rego) == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("rego"), "rego policy source is required"))
	}
	if policy.Spec.Enforcement != "" && policy.Spec.Enforcement != pipelinesv1alpha1.ConftestEnforce && policy.Spec.Enforcement != pipelinesv1alpha1.ConftestWarn {
		allErrs = append(allErrs, field.NotSupported(specPath.Child("enforcement"), policy.Spec.Enforcement, []string{string(pipelinesv1alpha1.ConftestEnforce), string(pipelinesv1alpha1.ConftestWarn)}))
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "ConftestPolicy"},
		policy.Name,
		allErrs,
	)
}
