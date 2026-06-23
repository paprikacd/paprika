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

var analysisrunlog = logf.Log.WithName("analysisrun-resource")

// SetupAnalysisRunWebhookWithManager registers the AnalysisRun webhooks.
func SetupAnalysisRunWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.AnalysisRun{}).
		WithValidator(&AnalysisRunCustomValidator{}).
		WithDefaulter(&AnalysisRunCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up analysisrun webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-analysisrun,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=analysisruns,verbs=create;update,versions=v1alpha1,name=manalysisrun-v1alpha1.kb.io,admissionReviewVersions=v1

// AnalysisRunCustomDefaulter sets defaults for AnalysisRun.
type AnalysisRunCustomDefaulter struct{}

func (d *AnalysisRunCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.AnalysisRun) error {
	analysisrunlog.Info("Defaulting for AnalysisRun", "name", obj.GetName())
	if obj.Spec.IntervalSeconds == 0 {
		obj.Spec.IntervalSeconds = 60
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-analysisrun,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=analysisruns,verbs=create;update,versions=v1alpha1,name=vanalysisrun-v1alpha1.kb.io,admissionReviewVersions=v1

// AnalysisRunCustomValidator validates AnalysisRun resources.
type AnalysisRunCustomValidator struct{}

func (v *AnalysisRunCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.AnalysisRun) (admission.Warnings, error) {
	analysisrunlog.Info("Validation for AnalysisRun upon creation", "name", obj.GetName())
	return nil, validateAnalysisRun(obj)
}

func (v *AnalysisRunCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.AnalysisRun) (admission.Warnings, error) {
	analysisrunlog.Info("Validation for AnalysisRun upon update", "name", newObj.GetName())
	return nil, validateAnalysisRun(newObj)
}

func (v *AnalysisRunCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.AnalysisRun) (admission.Warnings, error) {
	analysisrunlog.Info("Validation for AnalysisRun upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateAnalysisRun(run *pipelinesv1alpha1.AnalysisRun) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if run.Spec.TemplateRef == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("templateRef"), "templateRef is required"))
	}
	if run.Spec.ApplicationRef == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("applicationRef"), "applicationRef is required"))
	}
	if run.Spec.IntervalSeconds < 0 {
		allErrs = append(allErrs, field.Invalid(specPath.Child("intervalSeconds"), run.Spec.IntervalSeconds, "must be non-negative"))
	}
	if run.Spec.Count < 0 {
		allErrs = append(allErrs, field.Invalid(specPath.Child("count"), run.Spec.Count, "must be non-negative"))
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "AnalysisRun"},
		run.Name,
		allErrs,
	)
}
