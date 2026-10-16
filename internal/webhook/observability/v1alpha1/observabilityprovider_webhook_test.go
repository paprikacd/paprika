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
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	v1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
)

// fussyValidator rejects any non-empty config for type "fussy", mirroring
// a connector whose ValidateConfig fails — it gives
// TestConfigIsValidatedByTheConnector something to fail against. Every
// other type accepts whatever config it is handed.
func fussyValidator(providerType string, config json.RawMessage) error {
	if providerType == "fussy" && len(config) > 0 {
		return errors.New("fussy connector rejects any configuration")
	}
	return nil
}

// providerWith returns an ObservabilityProvider of the given type with the
// given raw JSON config.
func providerWith(providerType string, config []byte) *v1alpha1.ObservabilityProvider {
	p := &v1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "test-provider"},
		Spec:       v1alpha1.ObservabilityProviderSpec{Type: providerType},
	}
	if len(config) > 0 {
		p.Spec.Config = runtime.RawExtension{Raw: config}
	}
	return p
}

func TestUnknownTypeConfigIsRejected(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	_, err := v.ValidateCreate(t.Context(), providerWith("fussy", []byte(`{"bad":true}`)))
	// Rejected at apply time, not discovered broken on first scrape.
	require.Error(t, err)
}

func TestValidConfigIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", []byte(`{"url":"https://prometheus:9090"}`)))
	require.NoError(t, err)
}

func TestNilValidatorStillEnforcesCredentialRule(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(nil)
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", []byte(`{"token":"super-secret-value"}`)))
	require.ErrorContains(t, err, "secretRef")
	assert.NotContains(t, err.Error(), "super-secret-value")
}

func TestEmptyTypeIsRejected(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	_, err := v.ValidateCreate(t.Context(), providerWith("", nil))
	require.ErrorContains(t, err, "type")
}

func TestInlineCredentialIsRejected(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"token", "password", "bearerToken"} {
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			v := NewObservabilityProviderValidator(fussyValidator)
			config := []byte(fmt.Sprintf(`{%q:"super-secret-value"}`, key))
			_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", config))
			require.ErrorContains(t, err, "secretRef")
			assert.NotContains(t, err.Error(), "super-secret-value")
		})
	}
}

func TestSecretRefConfigIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", []byte(`{"secretRef":{"name":"creds"}}`)))
	require.NoError(t, err)
}

// TestNestedInlineCredentialIsRejected covers a credential nested under a
// grouping key (e.g. "auth.token") — exactly how real connector configs
// shape inline secrets — which a bare top-level-only check would miss.
func TestNestedInlineCredentialIsRejected(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	config := []byte(`{"auth":{"token":"s3cr3t"}}`)
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", config))
	require.ErrorContains(t, err, "auth.token")
	assert.NotContains(t, err.Error(), "s3cr3t")
}

// TestCredentialNestedInsideArrayElementIsRejected covers a credential
// buried inside an array of objects, another realistic config shape the
// flat top-level-only check would have missed.
func TestCredentialNestedInsideArrayElementIsRejected(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	config := []byte(`{"endpoints":[{"name":"a"},{"password":"s3cr3t"}]}`)
	_, err := v.ValidateCreate(t.Context(), providerWith("loki", config))
	require.ErrorContains(t, err, "password")
	assert.NotContains(t, err.Error(), "s3cr3t")
}

// TestNestedSecretRefConfigIsAccepted confirms the recursive scan does not
// over-match: a secretRef nested under a grouping key is still fine.
func TestNestedSecretRefConfigIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", []byte(`{"auth":{"secretRef":{"name":"creds"}}}`)))
	require.NoError(t, err)
}

// nestedConfig builds a JSON object nesting {leafKey: leafValue} depth
// levels under a repeated grouping key, for exercising the recursion cap.
func nestedConfig(depth int, leafKey, leafValue string) []byte {
	var obj any = map[string]any{leafKey: leafValue}
	for i := 0; i < depth; i++ {
		obj = map[string]any{"level": obj}
	}
	raw, err := json.Marshal(obj)
	if err != nil {
		panic(err)
	}
	return raw
}

// TestDeeplyNestedConfigPastDepthCapIsRejected confirms a config nested
// well past maxCredentialScanDepth fails with a clear depth error rather
// than recursing without bound — this is not a credential-shaped config at
// all, so a stack overflow here would be the real bug.
func TestDeeplyNestedConfigPastDepthCapIsRejected(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	config := nestedConfig(maxCredentialScanDepth+10, "note", "not a credential")
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", config))
	require.ErrorContains(t, err, "exceeds the maximum depth")
}

// TestValidatorFailureNeverEchoesRawConfig confirms the rejection echoes
// the redaction sentinel, never the config bytes the connector choked on —
// a config is exactly where an operator would park a credential-shaped
// value this package's key list does not know about.
func TestValidatorFailureNeverEchoesRawConfig(t *testing.T) {
	t.Parallel()
	//nolint:gosec // G101 false positive: test fixture string, not a credential.
	secret := "credential-looking-value"
	validate := func(_ string, _ json.RawMessage) error {
		return fmt.Errorf("endpoint %q is not reachable", secret)
	}
	v := NewObservabilityProviderValidator(validate)
	config := []byte(fmt.Sprintf(`{"endpoint":%q}`, secret))
	_, err := v.ValidateCreate(t.Context(), providerWith("prometheus", config))
	require.Error(t, err)
	assert.Contains(t, err.Error(), redactedConfigValue)
}

func TestValidateUpdateAlsoValidatesConfig(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	oldProvider := providerWith("fussy", nil)
	newProvider := providerWith("fussy", []byte(`{"bad":true}`))
	_, err := v.ValidateUpdate(context.Background(), oldProvider, newProvider)
	require.Error(t, err)
}

func TestValidateDeleteAlwaysAdmitsProvider(t *testing.T) {
	t.Parallel()
	v := NewObservabilityProviderValidator(fussyValidator)
	warnings, err := v.ValidateDelete(t.Context(), providerWith("prometheus", nil))
	require.NoError(t, err)
	require.Nil(t, warnings)
}
