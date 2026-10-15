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

	v1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
)

var observabilityproviderlog = logf.Log.WithName("observabilityprovider-resource")

// observabilityGroup is the API group the observability webhooks in this
// package validate against, used to build the GroupKind on a rejection.
const observabilityGroup = "observability.paprika.io"

const kindObservabilityProvider = "ObservabilityProvider"

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

// ConfigValidator checks a provider's opaque config against its declared
// type. Injected so this package does not import the connector registry
// (which lives in the gateway's connector package and is registered at
// startup); cmd wires a closure over connector.New + ValidateConfig.
type ConfigValidator func(providerType string, config json.RawMessage) error

// SetupObservabilityProviderWebhookWithManager registers the
// ObservabilityProvider validating webhook.
func SetupObservabilityProviderWebhookWithManager(mgr ctrl.Manager, validateConfig ConfigValidator) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &v1alpha1.ObservabilityProvider{}).
		WithValidator(NewObservabilityProviderValidator(validateConfig)).
		Complete(); err != nil {
		return fmt.Errorf("setting up observabilityprovider webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-observability-paprika-io-v1alpha1-observabilityprovider,mutating=false,failurePolicy=fail,sideEffects=None,groups=observability.paprika.io,resources=observabilityproviders,verbs=create;update,versions=v1alpha1,name=vobservabilityprovider-v1alpha1.kb.io,admissionReviewVersions=v1

// ObservabilityProviderValidator rejects an ObservabilityProvider at
// admission time rather than letting it be discovered broken on first
// scrape: its config must pass the connector's own ValidateConfig, and it
// must not carry an inline credential (a credentialsSecretRef is required
// for those).
type ObservabilityProviderValidator struct {
	validateConfig ConfigValidator
}

// NewObservabilityProviderValidator returns a validator that checks
// spec.config against the connector for spec.type via validateConfig. A nil
// validateConfig skips config validation entirely, so a manager built
// without the gateway's connector registry still enforces the structural
// and credential rules below.
func NewObservabilityProviderValidator(validateConfig ConfigValidator) *ObservabilityProviderValidator {
	return &ObservabilityProviderValidator{validateConfig: validateConfig}
}

func (v *ObservabilityProviderValidator) ValidateCreate(_ context.Context, obj *v1alpha1.ObservabilityProvider) (admission.Warnings, error) {
	observabilityproviderlog.Info("Validation for ObservabilityProvider upon creation", "name", obj.GetName())
	return nil, v.validate(obj)
}

func (v *ObservabilityProviderValidator) ValidateUpdate(_ context.Context, _, newObj *v1alpha1.ObservabilityProvider) (admission.Warnings, error) {
	observabilityproviderlog.Info("Validation for ObservabilityProvider upon update", "name", newObj.GetName())
	return nil, v.validate(newObj)
}

func (v *ObservabilityProviderValidator) ValidateDelete(_ context.Context, obj *v1alpha1.ObservabilityProvider) (admission.Warnings, error) {
	observabilityproviderlog.Info("Validation for ObservabilityProvider upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *ObservabilityProviderValidator) validate(provider *v1alpha1.ObservabilityProvider) error {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	// The enum marker already rejects an empty type at the API server; this
	// is defense in depth for direct writes and older API servers.
	if provider.Spec.Type == "" {
		allErrs = append(allErrs, field.Required(specPath.Child("type"), "type is required"))
	}

	if err := rejectInlineCredentials(provider.Spec.Config.Raw); err != nil {
		allErrs = append(allErrs, field.Forbidden(specPath.Child("config"), err.Error()))
	}
	if v.validateConfig != nil {
		if err := v.validateConfig(provider.Spec.Type, provider.Spec.Config.Raw); err != nil {
			allErrs = append(allErrs, field.Invalid(specPath.Child("config"), redactedConfigValue, err.Error()))
		}
	}

	return newInvalidErr(kindObservabilityProvider, provider.Name, allErrs)
}

// maxCredentialScanDepth bounds how deep rejectInlineCredentials recurses
// into a config's object/array structure. A real provider config nests only
// a handful of levels; anything past this is either a mistake or a hostile
// payload, and either way should fail with a clear error rather than
// recursing without bound.
const maxCredentialScanDepth = 32

// rejectInlineCredentials reports an error when config carries a
// credential-shaped field (see deniedCredentialKeys) with a non-empty
// string value, at any depth — credentials are as often nested under a
// grouping key (e.g. "auth.token") as they are at the top level. A missing
// config, a config that fails to parse as JSON, or a value that isn't an
// object or array, is left for the connector's ValidateConfig to judge on
// its own terms.
func rejectInlineCredentials(raw []byte) error {
	if len(raw) == 0 {
		return nil
	}

	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil
	}

	return scanForInlineCredentials(decoded, "", 0)
}

// scanForInlineCredentials walks a decoded JSON value looking for a denied
// credential key carrying a non-empty string value. path is the dotted
// (and indexed, for arrays) location of value within the config, used only
// to make a rejection actionable — it is never a secret itself.
func scanForInlineCredentials(value any, path string, depth int) error {
	if depth > maxCredentialScanDepth {
		return fmt.Errorf("config nesting at %q exceeds the maximum depth of %d; flatten it or use secretRef", path, maxCredentialScanDepth)
	}

	switch v := value.(type) {
	case map[string]any:
		return scanObjectForInlineCredentials(v, path, depth)
	case []any:
		return scanArrayForInlineCredentials(v, path, depth)
	default:
		return nil
	}
}

func scanObjectForInlineCredentials(obj map[string]any, path string, depth int) error {
	for key, child := range obj {
		childPath := joinConfigPath(path, key)
		if isDeniedCredentialKey(key) {
			if literal, ok := child.(string); ok && literal != "" {
				return fmt.Errorf("config field %q must not carry a literal credential; use secretRef instead", childPath)
			}
		}
		if err := scanForInlineCredentials(child, childPath, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func scanArrayForInlineCredentials(items []any, path string, depth int) error {
	for i, child := range items {
		if err := scanForInlineCredentials(child, fmt.Sprintf("%s[%d]", path, i), depth+1); err != nil {
			return err
		}
	}
	return nil
}

func joinConfigPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func isDeniedCredentialKey(key string) bool {
	for _, denied := range deniedCredentialKeys {
		if key == denied {
			return true
		}
	}
	return false
}

// newInvalidErr builds the apierrors.NewInvalid response for the given
// observability.paprika.io kind, or nil when allErrs is empty.
func newInvalidErr(kind, name string, allErrs field.ErrorList) error {
	if len(allErrs) == 0 {
		return nil
	}
	return apierrors.NewInvalid(schema.GroupKind{Group: observabilityGroup, Kind: kind}, name, allErrs)
}
