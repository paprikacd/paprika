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

	"github.com/distribution/reference"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// log is for logging in this package.
var artifactlog = logf.Log.WithName("artifact-resource")

// SetupArtifactWebhookWithManager registers the webhook for Artifact in the manager.
func SetupArtifactWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Artifact{}).
		WithValidator(&ArtifactCustomValidator{}).
		WithDefaulter(&ArtifactCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up artifact webhook: %w", err)
	}
	return nil
}

// TODO(user): EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-artifact,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=artifacts,verbs=create;update,versions=v1alpha1,name=martifact-v1alpha1.kb.io,admissionReviewVersions=v1

// ArtifactCustomDefaulter struct is responsible for setting default values on the custom resource of the
// Kind Artifact when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type ArtifactCustomDefaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind Artifact.
func (d *ArtifactCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Artifact) error {
	artifactlog.Info("Defaulting for Artifact", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}

// TODO(user): change verbs to "verbs=create;update;delete" if you want to enable deletion validation.
// NOTE: If you want to customise the 'path', use the flags '--defaulting-path' or '--validation-path'.
// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-artifact,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=artifacts,verbs=create;update,versions=v1alpha1,name=vartifact-v1alpha1.kb.io,admissionReviewVersions=v1

// ArtifactCustomValidator struct is responsible for validating the Artifact resource
// when it is created, updated, or deleted.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as this struct is used only for temporary operations and does not need to be deeply copied.
type ArtifactCustomValidator struct {
	// TODO(user): Add more fields as needed for validation
}

// ValidateCreate implements webhook.CustomValidator so a webhook will be registered for the type Artifact.
func (v *ArtifactCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.Artifact) (admission.Warnings, error) {
	artifactlog.Info("Validation for Artifact upon creation", "name", obj.GetName())
	return nil, validateArtifact(obj)
}

// ValidateUpdate implements webhook.CustomValidator so a webhook will be registered for the type Artifact.
func (v *ArtifactCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Artifact) (admission.Warnings, error) {
	artifactlog.Info("Validation for Artifact upon update", "name", newObj.GetName())
	return nil, validateArtifact(newObj)
}

// ValidateDelete implements webhook.CustomValidator so a webhook will be registered for the type Artifact.
func (v *ArtifactCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Artifact) (admission.Warnings, error) {
	artifactlog.Info("Validation for Artifact upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateArtifact(artifact *pipelinesv1alpha1.Artifact) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if artifact.Spec.Type == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("type"), "artifact type is required"))
	}
	if artifact.Spec.Type != "" && artifact.Spec.Type != "oci" {
		allErrs = append(allErrs, field.NotSupported(specPath.Child("type"), artifact.Spec.Type, []string{"oci"}))
	}
	if artifact.Spec.Reference == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("reference"), "artifact reference is required"))
	}
	if artifact.Spec.Reference != "" {
		ref := strings.TrimPrefix(artifact.Spec.Reference, "oci://")
		if _, err := reference.ParseAnyReference(ref); err != nil {
			allErrs = append(allErrs, field.Invalid(specPath.Child("reference"), artifact.Spec.Reference, fmt.Sprintf("invalid OCI reference: %v", err)))
		}
	}
	if artifact.Spec.Digest != "" {
		if _, err := reference.ParseAnyReference("dummy@" + artifact.Spec.Digest); err != nil {
			allErrs = append(allErrs, field.Invalid(specPath.Child("digest"), artifact.Spec.Digest, fmt.Sprintf("invalid digest: %v", err)))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Artifact"},
		artifact.Name,
		allErrs,
	)
}
