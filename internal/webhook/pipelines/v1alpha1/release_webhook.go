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
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

var releaselog = logf.Log.WithName("release-resource")

func SetupReleaseWebhookWithManager(mgr ctrl.Manager) error {
	resolver := governance.NewProjectResolver(mgr.GetClient())
	validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(mgr.GetClient()), mgr.GetRESTMapper())
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Release{}).
		WithValidator(&ReleaseCustomValidator{validator: validator, client: mgr.GetClient()}).
		WithDefaulter(&ReleaseCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up release webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-release,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=releases,verbs=create;update,versions=v1alpha1,name=mrelease-v1alpha1.kb.io,admissionReviewVersions=v1

type ReleaseCustomDefaulter struct{}

func (d *ReleaseCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Release) error {
	releaselog.Info("Defaulting for Release", "name", obj.GetName())
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-release,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=releases,verbs=create;update,versions=v1alpha1,name=vrelease-v1alpha1.kb.io,admissionReviewVersions=v1

type ReleaseCustomValidator struct {
	validator *governance.ProjectValidator
	client    client.Reader
}

func (v *ReleaseCustomValidator) ValidateCreate(ctx context.Context, obj *pipelinesv1alpha1.Release) (admission.Warnings, error) {
	releaselog.Info("Validation for Release upon creation", "name", obj.GetName())
	if errs := v.validateReleaseCreate(obj); len(errs) > 0 {
		return nil, apierrors.NewInvalid(
			schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Release"},
			obj.Name,
			errs,
		)
	}
	if err := v.enforceReleaseQuota(ctx, obj); err != nil {
		return nil, err
	}
	return nil, nil
}

func (v *ReleaseCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.Release) (admission.Warnings, error) {
	releaselog.Info("Validation for Release upon update", "name", newObj.GetName())

	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if oldObj.Spec.Pipeline != newObj.Spec.Pipeline {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("pipeline"), "Pipeline reference is immutable"))
	}

	if oldObj.Spec.Target != newObj.Spec.Target {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("target"), "Target stage is immutable"))
	}

	if createErrs := v.validateReleaseCreate(newObj); len(createErrs) > 0 {
		allErrs = append(allErrs, createErrs...)
	}

	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Release"},
		newObj.Name,
		allErrs,
	)
}

func (v *ReleaseCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.Release) (admission.Warnings, error) {
	releaselog.Info("Validation for Release upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *ReleaseCustomValidator) validateReleaseCreate(r *pipelinesv1alpha1.Release) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	// Pipeline is optional when there are no build steps (direct chart deploy).
	// It is required when the release follows a build pipeline.

	if r.Spec.Target == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("target"), "Target stage is required"))
	}

	if r.Spec.ManifestSource != nil && r.Spec.ManifestSource.ConfigMapRef == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("manifestSource").Child("configMapRef"), "configMapRef is required for inline manifest source"))
	}

	return allErrs
}

// projectLabelKey is the label used to associate a Release with its AppProject.
const projectLabelKey = "app.paprika.io/project"

// enforceReleaseQuota rejects Release creation when the governing AppProject
// has reached its MaxReleases limit. It is a no-op when the validator or
// client are unset (test harness), when no Limits are configured, or when
// MaxReleases is zero (unlimited).
func (v *ReleaseCustomValidator) enforceReleaseQuota(ctx context.Context, release *pipelinesv1alpha1.Release) error {
	if v.client == nil || v.validator == nil {
		return nil
	}
	projectName := v.resolveProjectName(ctx, release)
	if projectName == "" {
		projectName = "default"
	}
	project, err := v.validator.ResolveProject(ctx, release.Namespace, projectName)
	if err != nil {
		return apierrors.NewInternalError(fmt.Errorf("resolve project %s/%s: %w", release.Namespace, projectName, err))
	}
	if project == nil || project.Spec.Limits == nil || project.Spec.Limits.MaxReleases <= 0 {
		return nil
	}

	var releases pipelinesv1alpha1.ReleaseList
	if err := v.client.List(ctx, &releases, client.InNamespace(release.Namespace), client.MatchingLabels{projectLabelKey: project.Name}); err != nil {
		return apierrors.NewInternalError(fmt.Errorf("list releases: %w", err))
	}
	if len(releases.Items) >= project.Spec.Limits.MaxReleases {
		return apierrors.NewForbidden(
			schema.GroupResource{Group: "pipelines.paprika.io", Resource: "releases"},
			release.Name,
			fmt.Errorf("project %q has reached its MaxReleases limit of %d (current count: %d)", project.Name, project.Spec.Limits.MaxReleases, len(releases.Items)),
		)
	}
	return nil
}

// resolveProjectName determines the AppProject name governing a Release. It
// prefers the project label, then falls back to the owning Application's
// Spec.Project. An empty result lets ResolveProject apply its "default" fallback.
func (v *ReleaseCustomValidator) resolveProjectName(ctx context.Context, release *pipelinesv1alpha1.Release) string {
	if name := release.Labels[projectLabelKey]; name != "" {
		return name
	}
	for _, ref := range release.OwnerReferences {
		if ref.Kind == "Application" && ref.APIVersion == pipelinesv1alpha1.GroupVersion.String() {
			var app pipelinesv1alpha1.Application
			if err := v.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: release.Namespace}, &app); err == nil {
				return app.Spec.Project
			}
		}
	}
	return ""
}
