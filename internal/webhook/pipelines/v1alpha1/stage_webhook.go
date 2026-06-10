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

	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// log is for logging in this package.
//
//nolint:unused
var stagelog = logf.Log.WithName("stage-resource")

// SetupStageWebhookWithManager registers the webhook for Stage in the manager.
func SetupStageWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Stage{}).
		WithValidator(&StageCustomValidator{}).
		WithDefaulter(&StageCustomDefaulter{}).
		Complete()
}

// TODO(user): EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-stage,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=stages,verbs=create;update,versions=v1alpha1,name=mstage-v1alpha1.kb.io,admissionReviewVersions=v1

// StageCustomDefaulter struct is responsible for setting default values on the custom resource of the
// Kind Stage when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type StageCustomDefaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind Stage.
func (d *StageCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Stage) error {
	stagelog.Info("Defaulting for Stage", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}

// TODO(user): change verbs to "verbs=create;update;delete" if you want to enable deletion validation.
// NOTE: If you want to customise the 'path', use the flags '--defaulting-path' or '--validation-path'.
// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-stage,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=stages,verbs=create;update,versions=v1alpha1,name=vstage-v1alpha1.kb.io,admissionReviewVersions=v1

// StageCustomValidator struct is responsible for validating the Stage resource
// when it is created, updated, or deleted.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as this struct is used only for temporary operations and does not need to be deeply copied.
type StageCustomValidator struct {
	// TODO(user): Add more fields as needed for validation
}

// ValidateCreate implements webhook.CustomValidator so a webhook will be registered for the type Stage.
func (v *StageCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.Stage) (admission.Warnings, error) {
	stagelog.Info("Validation for Stage upon creation", "name", obj.GetName())

	// TODO(user): fill in your validation logic upon object creation.

	return nil, nil
}

// ValidateUpdate implements webhook.CustomValidator so a webhook will be registered for the type Stage.
func (v *StageCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Stage) (admission.Warnings, error) {
	stagelog.Info("Validation for Stage upon update", "name", newObj.GetName())

	// TODO(user): fill in your validation logic upon object update.

	return nil, nil
}

// ValidateDelete implements webhook.CustomValidator so a webhook will be registered for the type Stage.
func (v *StageCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Stage) (admission.Warnings, error) {
	stagelog.Info("Validation for Stage upon deletion", "name", obj.GetName())

	// TODO(user): fill in your validation logic upon object deletion.

	return nil, nil
}
