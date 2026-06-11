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

var pipelinelog = logf.Log.WithName("pipeline-resource")

func SetupPipelineWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Pipeline{}).
		WithValidator(&PipelineCustomValidator{}).
		WithDefaulter(&PipelineCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up pipeline webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-pipeline,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=pipelines,verbs=create;update,versions=v1alpha1,name=mpipeline-v1alpha1.kb.io,admissionReviewVersions=v1

type PipelineCustomDefaulter struct{}

func (d *PipelineCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Pipeline) error {
	pipelinelog.Info("Defaulting for Pipeline", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-pipeline,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=pipelines,verbs=create;update,versions=v1alpha1,name=vpipeline-v1alpha1.kb.io,admissionReviewVersions=v1

type PipelineCustomValidator struct{}

func (v *PipelineCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.Pipeline) (admission.Warnings, error) {
	pipelinelog.Info("Validation for Pipeline upon creation", "name", obj.GetName())
	return nil, v.validatePipeline(obj)
}

func (v *PipelineCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Pipeline) (admission.Warnings, error) {
	pipelinelog.Info("Validation for Pipeline upon update", "name", newObj.GetName())
	return nil, v.validatePipeline(newObj)
}

func (v *PipelineCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Pipeline) (admission.Warnings, error) {
	pipelinelog.Info("Validation for Pipeline upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *PipelineCustomValidator) validatePipeline(p *pipelinesv1alpha1.Pipeline) error {
	var allErrs field.ErrorList
	stepsPath := field.NewPath("spec").Child("steps")

	if len(p.Spec.Steps) == 0 {
		allErrs = append(allErrs, field.Invalid(stepsPath, p.Spec.Steps, "Must have at least one step"))
	}

	names := make(map[string]bool)
	for i, step := range p.Spec.Steps {
		stepPath := stepsPath.Index(i)
		if step.Name == "" {
			allErrs = append(allErrs, field.Required(stepPath.Child("name"), "Step name is required"))
		} else if names[step.Name] {
			allErrs = append(allErrs, field.Invalid(stepPath.Child("name"), step.Name, "Step name must be unique"))
		}
		names[step.Name] = true

		if step.Image == "" {
			allErrs = append(allErrs, field.Required(stepPath.Child("image"), "Step image is required"))
		}
		if step.Script == "" {
			allErrs = append(allErrs, field.Required(stepPath.Child("script"), "Step script is required"))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Pipeline"},
		p.Name,
		allErrs,
	)
}
