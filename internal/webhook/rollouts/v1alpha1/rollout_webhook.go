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
	"math"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

var rolloutlog = logf.Log.WithName("rollout-resource")

// SetupRolloutWebhookWithManager registers the Rollout webhooks.
func SetupRolloutWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &rolloutsv1alpha1.Rollout{}).
		WithValidator(&RolloutCustomValidator{}).
		WithDefaulter(&RolloutCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up rollout webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-rollouts-paprika-io-v1alpha1-rollout,mutating=true,failurePolicy=fail,sideEffects=None,groups=rollouts.paprika.io,resources=rollouts,verbs=create;update,versions=v1alpha1,name=mrollout-v1alpha1.kb.io,admissionReviewVersions=v1

type RolloutCustomDefaulter struct{}

func (d *RolloutCustomDefaulter) Default(_ context.Context, obj *rolloutsv1alpha1.Rollout) error {
	rolloutlog.Info("Defaulting for Rollout", "name", obj.GetName())

	if obj.Spec.Replicas == nil {
		obj.Spec.Replicas = ptr.To(int32(1))
	}
	if obj.Spec.RevisionHistoryLimit == nil {
		obj.Spec.RevisionHistoryLimit = ptr.To(int32(10))
	}
	if obj.Spec.Target.Kind == "" {
		obj.Spec.Target.Kind = "Deployment"
	}

	if obj.Spec.Strategy.Type == "Rolling" && obj.Spec.Strategy.Rolling != nil {
		if obj.Spec.Strategy.Rolling.MaxSurge == nil {
			obj.Spec.Strategy.Rolling.MaxSurge = ptr.To(intstr.FromString("25%"))
		}
		if obj.Spec.Strategy.Rolling.MaxUnavailable == nil {
			obj.Spec.Strategy.Rolling.MaxUnavailable = ptr.To(intstr.FromString("25%"))
		}
	}

	setServiceDefaults(&obj.Spec.Strategy, obj.Name)
	return nil
}

// +kubebuilder:webhook:path=/validate-rollouts-paprika-io-v1alpha1-rollout,mutating=false,failurePolicy=fail,sideEffects=None,groups=rollouts.paprika.io,resources=rollouts,verbs=create;update,versions=v1alpha1,name=vrollout-v1alpha1.kb.io,admissionReviewVersions=v1

type RolloutCustomValidator struct{}

func (v *RolloutCustomValidator) ValidateCreate(_ context.Context, obj *rolloutsv1alpha1.Rollout) (admission.Warnings, error) {
	rolloutlog.Info("Validation for Rollout upon creation", "name", obj.GetName())
	if errs := v.validateRollout(obj); len(errs) > 0 {
		return nil, apierrors.NewInvalid(
			schema.GroupKind{Group: "rollouts.paprika.io", Kind: "Rollout"},
			obj.Name,
			errs,
		)
	}
	return nil, nil
}

func (v *RolloutCustomValidator) ValidateUpdate(ctx context.Context, _, newObj *rolloutsv1alpha1.Rollout) (admission.Warnings, error) {
	rolloutlog.Info("Validation for Rollout upon update", "name", newObj.GetName())
	return v.ValidateCreate(ctx, newObj)
}

func (v *RolloutCustomValidator) ValidateDelete(_ context.Context, _ *rolloutsv1alpha1.Rollout) (admission.Warnings, error) {
	return nil, nil
}

func (v *RolloutCustomValidator) validateRollout(ro *rolloutsv1alpha1.Rollout) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")
	strategyPath := specPath.Child("strategy")

	switch ro.Spec.Strategy.Type {
	case "Rolling", "Canary", "BlueGreen", "ABTest", "Mirror":
	default:
		allErrs = append(allErrs, field.NotSupported(strategyPath.Child("type"), ro.Spec.Strategy.Type, []string{"Rolling", "Canary", "BlueGreen", "ABTest", "Mirror"}))
	}

	desired := int32(1)
	if ro.Spec.Replicas != nil {
		desired = *ro.Spec.Replicas
	}
	if err := v.validateStrategyConfig(&ro.Spec.Strategy, strategyPath, desired); err != nil {
		allErrs = append(allErrs, err...)
	}

	if ro.Spec.Target.Kind != "" && ro.Spec.Target.Kind != "Deployment" {
		allErrs = append(allErrs, field.NotSupported(specPath.Child("target").Child("kind"), ro.Spec.Target.Kind, []string{"", "Deployment"}))
	}

	return allErrs
}

func (v *RolloutCustomValidator) validateStrategyConfig(s *rolloutsv1alpha1.RolloutStrategy, path *field.Path, desiredReplicas int32) field.ErrorList {
	var allErrs field.ErrorList

	switch s.Type {
	case "Rolling":
		if s.Rolling == nil {
			allErrs = append(allErrs, field.Required(path.Child("rolling"), "rolling configuration is required"))
			break
		}
		if errs := validateRollingSurgeUnavailable(s.Rolling, path.Child("rolling"), desiredReplicas); len(errs) > 0 {
			allErrs = append(allErrs, errs...)
		}
	case "Canary":
		if s.Canary == nil {
			allErrs = append(allErrs, field.Required(path.Child("canary"), "canary configuration is required"))
			return allErrs
		}
		if len(s.Canary.Steps) == 0 {
			allErrs = append(allErrs, field.Required(path.Child("canary").Child("steps"), "at least one canary step is required"))
		}
		for i, step := range s.Canary.Steps {
			if step.SetWeight < 0 || step.SetWeight > 100 {
				allErrs = append(allErrs, field.NotSupported(path.Child("canary").Child("steps").Index(i).Child("setWeight"), step.SetWeight, []string{}))
			}
		}
	case "BlueGreen":
		if s.BlueGreen == nil {
			allErrs = append(allErrs, field.Required(path.Child("blueGreen"), "blueGreen configuration is required"))
			return allErrs
		}
		if s.BlueGreen.ActiveService == "" {
			allErrs = append(allErrs, field.Required(path.Child("blueGreen").Child("activeService"), "activeService is required"))
		}
		if s.BlueGreen.AutoPromotionSeconds != nil && *s.BlueGreen.AutoPromotionSeconds < 0 {
			allErrs = append(allErrs, field.Invalid(path.Child("blueGreen").Child("autoPromotionSeconds"), *s.BlueGreen.AutoPromotionSeconds, "must be >= 0"))
		}
		if s.BlueGreen.ScaleDownDelaySeconds != nil && *s.BlueGreen.ScaleDownDelaySeconds < 0 {
			allErrs = append(allErrs, field.Invalid(path.Child("blueGreen").Child("scaleDownDelaySeconds"), *s.BlueGreen.ScaleDownDelaySeconds, "must be >= 0"))
		}
	case "ABTest":
		if s.ABTest == nil {
			allErrs = append(allErrs, field.Required(path.Child("abTest"), "abTest configuration is required"))
			return allErrs
		}
		if len(s.ABTest.Routes) == 0 {
			allErrs = append(allErrs, field.Required(path.Child("abTest").Child("routes"), "at least one route is required"))
		}
		for i, route := range s.ABTest.Routes {
			routePath := path.Child("abTest").Child("routes").Index(i)
			if route.Service != "stable" && route.Service != "canary" {
				allErrs = append(allErrs, field.NotSupported(routePath.Child("service"), route.Service, []string{"stable", "canary"}))
			}
		}
	case "Mirror":
		if s.Mirror == nil {
			allErrs = append(allErrs, field.Required(path.Child("mirror"), "mirror configuration is required"))
			return allErrs
		}
		if s.Mirror.MirrorPercent < 1 || s.Mirror.MirrorPercent > 100 {
			allErrs = append(allErrs, field.NotSupported(path.Child("mirror").Child("mirrorPercent"), s.Mirror.MirrorPercent, []string{}))
		}
	}

	configs := []struct {
		name string
		set  bool
	}{
		{"rolling", s.Rolling != nil},
		{"canary", s.Canary != nil},
		{"blueGreen", s.BlueGreen != nil},
		{"abTest", s.ABTest != nil},
		{"mirror", s.Mirror != nil},
	}
	setCount := 0
	for _, c := range configs {
		if c.set {
			setCount++
		}
	}
	if setCount != 1 {
		allErrs = append(allErrs, field.Forbidden(path, fmt.Sprintf("exactly one strategy configuration must be set (found %d)", setCount)))
	}

	return allErrs
}

// validateRollingSurgeUnavailable validates MaxSurge/MaxUnavailable against the
// Deployment controller's rules: both must be non-negative, and they cannot
// both resolve to zero (would deadlock). Percent strings like "25%" are
// resolved against the rollout's replica count.
func validateRollingSurgeUnavailable(r *rolloutsv1alpha1.RollingStrategy, path *field.Path, desiredReplicas int32) field.ErrorList {
	var allErrs field.ErrorList
	surge, surgeErr := resolveRollingCount(r.MaxSurge, desiredReplicas)
	unavail, unavailErr := resolveRollingCount(r.MaxUnavailable, desiredReplicas)
	if surgeErr != nil {
		allErrs = append(allErrs, field.Invalid(path.Child("maxSurge"), r.MaxSurge, surgeErr.Error()))
	}
	if unavailErr != nil {
		allErrs = append(allErrs, field.Invalid(path.Child("maxUnavailable"), r.MaxUnavailable, unavailErr.Error()))
	}
	if len(allErrs) > 0 {
		return allErrs
	}
	if desiredReplicas > 0 && surge == 0 && unavail == 0 {
		allErrs = append(allErrs, field.Invalid(path, r, "maxSurge and maxUnavailable cannot both be zero"))
	}
	return allErrs
}

// resolveRollingCount resolves an intstr.IntOrString to an int32 against the
// desired replica count. A nil pointer resolves to 0. Percent strings like
// "25%" are evaluated against `desired` via intstr.GetScaledValueFromIntOrPercent.
// Negative integers or unparseable strings return an error.
func resolveRollingCount(v *intstr.IntOrString, desired int32) (int32, error) {
	if v == nil {
		return 0, nil
	}
	resolved, err := intstr.GetScaledValueFromIntOrPercent(v, int(desired), true)
	if err != nil {
		return 0, fmt.Errorf("could not resolve %q: %w", v.String(), err)
	}
	if resolved < 0 {
		return 0, fmt.Errorf("must be non-negative, got %d", resolved)
	}
	if resolved > math.MaxInt32 {
		return 0, fmt.Errorf("must fit in int32, got %d", resolved)
	}
	return int32(resolved), nil
}

func setServiceDefaults(s *rolloutsv1alpha1.RolloutStrategy, name string) {
	switch s.Type {
	case "Canary":
		if s.Canary != nil {
			if s.Canary.StableService == "" {
				s.Canary.StableService = name + "-stable"
			}
			if s.Canary.CanaryService == "" {
				s.Canary.CanaryService = name + "-canary"
			}
		}
	case "BlueGreen":
		if s.BlueGreen != nil {
			if s.BlueGreen.ActiveService == "" {
				s.BlueGreen.ActiveService = name + "-active"
			}
			if s.BlueGreen.PreviewService == "" {
				s.BlueGreen.PreviewService = name + "-preview"
			}
		}
	case "ABTest":
		if s.ABTest != nil {
			if s.ABTest.StableService == "" {
				s.ABTest.StableService = name + "-stable"
			}
			if s.ABTest.CanaryService == "" {
				s.ABTest.CanaryService = name + "-canary"
			}
		}
	case "Mirror":
		if s.Mirror != nil {
			if s.Mirror.StableService == "" {
				s.Mirror.StableService = name + "-stable"
			}
			if s.Mirror.CanaryService == "" {
				s.Mirror.CanaryService = name + "-canary"
			}
		}
	}
}
