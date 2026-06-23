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
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var notificationconfiglog = logf.Log.WithName("notificationconfig-resource")

// SetupNotificationConfigWebhookWithManager registers the NotificationConfig webhooks.
func SetupNotificationConfigWebhookWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.NotificationConfig{}).
		WithValidator(&NotificationConfigCustomValidator{}).
		WithDefaulter(&NotificationConfigCustomDefaulter{}).
		Complete(); err != nil {
		return fmt.Errorf("setting up notificationconfig webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/mutate-pipelines-paprika-io-v1alpha1-notificationconfig,mutating=true,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=notificationconfigs,verbs=create;update,versions=v1alpha1,name=mnotificationconfig-v1alpha1.kb.io,admissionReviewVersions=v1

// NotificationConfigCustomDefaulter sets defaults for NotificationConfig.
type NotificationConfigCustomDefaulter struct{}

func (d *NotificationConfigCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.NotificationConfig) error {
	notificationconfiglog.Info("Defaulting for NotificationConfig", "name", obj.GetName())
	if obj.Spec.RateLimit != nil && obj.Spec.RateLimit.MinInterval == "" {
		obj.Spec.RateLimit.MinInterval = "5m"
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-pipelines-paprika-io-v1alpha1-notificationconfig,mutating=false,failurePolicy=fail,sideEffects=None,groups=pipelines.paprika.io,resources=notificationconfigs,verbs=create;update,versions=v1alpha1,name=vnotificationconfig-v1alpha1.kb.io,admissionReviewVersions=v1

// NotificationConfigCustomValidator validates NotificationConfig resources.
type NotificationConfigCustomValidator struct{}

func (v *NotificationConfigCustomValidator) ValidateCreate(_ context.Context, obj *pipelinesv1alpha1.NotificationConfig) (admission.Warnings, error) {
	notificationconfiglog.Info("Validation for NotificationConfig upon creation", "name", obj.GetName())
	return nil, validateNotificationConfig(obj)
}

func (v *NotificationConfigCustomValidator) ValidateUpdate(_ context.Context, oldObj, newObj *pipelinesv1alpha1.NotificationConfig) (admission.Warnings, error) {
	notificationconfiglog.Info("Validation for NotificationConfig upon update", "name", newObj.GetName())
	return nil, validateNotificationConfig(newObj)
}

func (v *NotificationConfigCustomValidator) ValidateDelete(_ context.Context, obj *pipelinesv1alpha1.NotificationConfig) (admission.Warnings, error) {
	notificationconfiglog.Info("Validation for NotificationConfig upon deletion", "name", obj.GetName())
	return nil, nil
}

func validateNotificationConfig(cfg *pipelinesv1alpha1.NotificationConfig) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if len(cfg.Spec.Destinations) == 0 {
		allErrs = append(allErrs, field.Required(specPath.Child("destinations"), "at least one destination is required"))
	}

	for i := range cfg.Spec.Destinations {
		destPath := specPath.Child("destinations").Index(i)
		allErrs = append(allErrs, validateDestination(&cfg.Spec.Destinations[i], destPath)...)
	}

	if cfg.Spec.RateLimit != nil && cfg.Spec.RateLimit.MinInterval != "" {
		if _, err := time.ParseDuration(cfg.Spec.RateLimit.MinInterval); err != nil {
			allErrs = append(allErrs, field.Invalid(specPath.Child("rateLimit").Child("minInterval"), cfg.Spec.RateLimit.MinInterval, "must be a valid duration"))
		}
	}

	if cfg.Spec.SMTP != nil {
		if cfg.Spec.SMTP.Host == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("smtp").Child("host"), "SMTP host is required"))
		}
		if cfg.Spec.SMTP.From == "" {
			allErrs = append(allErrs, field.Required(specPath.Child("smtp").Child("from"), "SMTP from is required"))
		}
	}

	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "pipelines.paprika.io", Kind: "NotificationConfig"},
		cfg.Name,
		allErrs,
	)
}

func validateDestination(dest *pipelinesv1alpha1.NotificationDestination, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	hasDestination := dest.WebhookURL != "" || dest.SlackWebhookURL != "" || dest.Email != ""
	if !hasDestination {
		errs = append(errs, field.Required(path, "destination must specify webhookUrl, slackWebhookUrl, or email"))
	}
	if dest.SlackWebhookURL != "" && dest.SecretRef == "" {
		errs = append(errs, field.Required(path.Child("secretRef"), "secretRef is required for Slack webhooks"))
	}
	if dest.Email != "" {
		// Email destinations require an SMTP relay configured on the NotificationConfig.
		// Per-resource SMTP validation is intentionally minimal.
		_ = dest.Email
	}
	if dest.Name == "" {
		errs = append(errs, field.Required(path.Child("name"), "destination name is required"))
	}
	return errs
}
