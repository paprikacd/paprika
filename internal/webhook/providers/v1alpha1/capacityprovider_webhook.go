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
	"encoding/json"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
	"github.com/benebsworth/paprika/internal/dataprovider"
)

var capacityproviderlog = logf.Log.WithName("capacityprovider-resource")

// providersGroup is the API group every provider webhook in this package
// validates against, used to build the GroupKind on a rejection.
const providersGroup = "providers.paprika.io"

const (
	kindCapacityProvider    = "CapacityProvider"
	kindDataProviderBinding = "DataProviderBinding"
)

// redactedConfigValue stands in for a provider's raw config in a rejection
// message. Config may legitimately carry values an operator would not want
// echoed back in an API response or a controller log, so a validation
// failure never reproduces it verbatim.
const redactedConfigValue = "<config redacted>"

// deniedCredentialKeys names spec.config fields that must never carry a
// plaintext credential value. This is deliberately a small, explicit set
// rather than a pattern match: a false negative here is a review problem, a
// false positive is a working config that suddenly can't be applied.
var deniedCredentialKeys = []string{"token", "password", "bearerToken"}

// SetupCapacityProviderWebhookWithManager registers the CapacityProvider
// validating webhook.
func SetupCapacityProviderWebhookWithManager(mgr ctrl.Manager, registry *dataprovider.Registry) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &v1alpha1.CapacityProvider{}).
		WithValidator(NewCapacityProviderValidator(registry)).
		Complete(); err != nil {
		return fmt.Errorf("setting up capacityprovider webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-providers-paprika-io-v1alpha1-capacityprovider,mutating=false,failurePolicy=fail,sideEffects=None,groups=providers.paprika.io,resources=capacityproviders,verbs=create;update,versions=v1alpha1,name=vcapacityprovider-v1alpha1.kb.io,admissionReviewVersions=v1

// CapacityProviderValidator rejects a CapacityProvider at admission time
// rather than letting it be discovered broken on first fetch: the provider
// key must resolve in the registry, its config must pass the
// implementation's own ValidateConfig, and it must not carry an inline
// credential (a secretRef is required for those).
type CapacityProviderValidator struct {
	registry *dataprovider.Registry
}

// NewCapacityProviderValidator returns a validator that resolves
// spec.provider against registry.
func NewCapacityProviderValidator(registry *dataprovider.Registry) *CapacityProviderValidator {
	return &CapacityProviderValidator{registry: registry}
}

func (v *CapacityProviderValidator) ValidateCreate(_ context.Context, obj *v1alpha1.CapacityProvider) (admission.Warnings, error) {
	capacityproviderlog.Info("Validation for CapacityProvider upon creation", "name", obj.GetName())
	return nil, v.validate(obj)
}

func (v *CapacityProviderValidator) ValidateUpdate(_ context.Context, _, newObj *v1alpha1.CapacityProvider) (admission.Warnings, error) {
	capacityproviderlog.Info("Validation for CapacityProvider upon update", "name", newObj.GetName())
	return nil, v.validate(newObj)
}

func (v *CapacityProviderValidator) ValidateDelete(_ context.Context, obj *v1alpha1.CapacityProvider) (admission.Warnings, error) {
	capacityproviderlog.Info("Validation for CapacityProvider upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *CapacityProviderValidator) validate(provider *v1alpha1.CapacityProvider) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	source, ok := v.registry.Capacity(provider.Spec.Provider)
	if !ok {
		allErrs = append(allErrs, field.Invalid(specPath.Child("provider"), provider.Spec.Provider,
			fmt.Sprintf("unknown provider: no CapacitySource is registered under %q", provider.Spec.Provider)))
		return newInvalidErr(kindCapacityProvider, provider.Name, allErrs)
	}

	if err := rejectInlineCredentials(provider.Spec.Config.Raw); err != nil {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("config"), err.Error()))
	}
	if err := source.ValidateConfig(provider.Spec.Config.Raw); err != nil {
		allErrs = append(allErrs, field.Invalid(specPath.Child("config"), redactedConfigValue, err.Error()))
	}

	return newInvalidErr(kindCapacityProvider, provider.Name, allErrs)
}

// rejectInlineCredentials reports an error when raw carries a
// credential-shaped field (see deniedCredentialKeys) with a non-empty
// string value. A missing or non-object config, or a config that fails to
// parse as JSON, is left for ValidateConfig to judge on its own terms.
func rejectInlineCredentials(raw []byte) error {
	if len(raw) == 0 {
		return nil
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}

	for _, key := range deniedCredentialKeys {
		value, ok := fields[key]
		if !ok {
			continue
		}
		var literal string
		if err := json.Unmarshal(value, &literal); err != nil {
			continue
		}
		if literal != "" {
			return fmt.Errorf("config field %q must not carry a literal credential; use secretRef instead", key)
		}
	}
	return nil
}

// newInvalidErr builds the apierrors.NewInvalid response for the given
// providers.paprika.io kind, or nil when allErrs is empty.
func newInvalidErr(kind, name string, allErrs field.ErrorList) error {
	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(schema.GroupKind{Group: providersGroup, Kind: kind}, name, allErrs)
}
