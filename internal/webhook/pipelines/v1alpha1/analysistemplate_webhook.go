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
	"strconv"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var analysistemplatelog = logf.Log.WithName("analysistemplate-resource")

// SetupAnalysisTemplateWebhookWithManager registers the AnalysisTemplate webhooks.
func SetupAnalysisTemplateWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.AnalysisTemplate{}).
		WithValidator(&AnalysisTemplateCustomValidator{}).
		WithDefaulter(&AnalysisTemplateCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up analysistemplate webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-analysistemplate,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=analysistemplates,verbs=create;update,versions=v1alpha1,name=manalysistemplate-v1alpha1.kb.io,admissionReviewVersions=v1

// AnalysisTemplateCustomDefaulter sets defaults for AnalysisTemplate.
type AnalysisTemplateCustomDefaulter struct{}

func (d *AnalysisTemplateCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.AnalysisTemplate) error {
	analysistemplatelog.Info("Defaulting for AnalysisTemplate", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-analysistemplate,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=analysistemplates,verbs=create;update,versions=v1alpha1,name=vanalysistemplate-v1alpha1.kb.io,admissionReviewVersions=v1

// AnalysisTemplateCustomValidator validates AnalysisTemplate resources.
type AnalysisTemplateCustomValidator struct{}

func (v *AnalysisTemplateCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.AnalysisTemplate) (admission.Warnings, error) {
	analysistemplatelog.Info("Validation for AnalysisTemplate upon creation", "name", obj.GetName())
	return nil, validateAnalysisTemplate(obj)
}

func (v *AnalysisTemplateCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.AnalysisTemplate) (admission.Warnings, error) {
	analysistemplatelog.Info("Validation for AnalysisTemplate upon update", "name", newObj.GetName())
	return nil, validateAnalysisTemplate(newObj)
}

func (v *AnalysisTemplateCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.AnalysisTemplate) (admission.Warnings, error) {
	analysistemplatelog.Info("Validation for AnalysisTemplate upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateAnalysisTemplate(template *pipelinesv1alpha1.AnalysisTemplate) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	seenArgs := map[string]bool{}
	for i, arg := range template.Spec.Args {
		argPath := specPath.Child("args").Index(i)
		if arg.Name == "" {
			allErrs = append(allErrs, field.Required(argPath.Child("name"), "arg name is required"))
			continue
		}
		if seenArgs[arg.Name] {
			allErrs = append(allErrs, field.Duplicate(argPath.Child("name"), arg.Name))
		}
		seenArgs[arg.Name] = true
	}

	for i := range template.Spec.Checks {
		checkPath := specPath.Child("checks").Index(i)
		allErrs = append(allErrs, validateAnalysisCheck(&template.Spec.Checks[i], checkPath)...)
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "AnalysisTemplate"},
		template.Name,
		allErrs,
	)
}

//nolint:cyclop // analysis check validation has sequential guard branches.
func validateAnalysisCheck(check *pipelinesv1alpha1.AnalysisCheck, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	if check.Type != "http" && check.Type != "podMetrics" {
		errs = append(errs, field.NotSupported(path.Child("type"), check.Type, []string{"http", "podMetrics"}))
	}
	if check.Type == "http" && check.URL == "" {
		errs = append(errs, field.Required(path.Child("url"), "url is required for http checks"))
	}
	if check.Type == "podMetrics" {
		if check.Metric == "" {
			errs = append(errs, field.Required(path.Child("metric"), "metric is required for podMetrics checks"))
		}
		if check.Metric != "" && check.Metric != "errorRate" && check.Metric != "latencyP99" && check.Metric != "restartRate" {
			errs = append(errs, field.NotSupported(path.Child("metric"), check.Metric, []string{"errorRate", "latencyP99", "restartRate"}))
		}
	}
	if check.SuccessThreshold != "" {
		if _, err := strconv.ParseFloat(check.SuccessThreshold, 64); err != nil {
			errs = append(errs, field.Invalid(path.Child("successThreshold"), check.SuccessThreshold, "must be a number"))
		}
	}
	if check.TimeoutSeconds < 0 {
		errs = append(errs, field.Invalid(path.Child("timeoutSeconds"), check.TimeoutSeconds, "must be non-negative"))
	}
	if check.RequestCount < 0 {
		errs = append(errs, field.Invalid(path.Child("requestCount"), check.RequestCount, "must be non-negative"))
	}
	if check.WindowSeconds < 0 {
		errs = append(errs, field.Invalid(path.Child("windowSeconds"), check.WindowSeconds, "must be non-negative"))
	}
	return errs
}
