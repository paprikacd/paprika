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

	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
	"github.com/benebsworth/paprika/internal/dataprovider"
)

// stubCapacitySource is a minimal dataprovider.CapacitySource used only to
// exercise the CapacityProvider webhook. A fussy source rejects any
// non-empty config, giving TestConfigIsValidatedByTheImplementation
// something to fail against.
type stubCapacitySource struct {
	name  string
	fussy bool
}

func (s stubCapacitySource) Descriptor() dataprovider.Descriptor {
	return dataprovider.Descriptor{Name: s.name}
}

func (s stubCapacitySource) ValidateConfig(config json.RawMessage) error {
	if s.fussy && len(config) > 0 {
		return errors.New("fussy stub rejects any configuration")
	}
	return nil
}

func (s stubCapacitySource) Read(_ context.Context, _ dataprovider.ReadRequest) (dataprovider.CapacityReading, error) {
	return dataprovider.CapacityReading{}, nil
}

// registryWith returns a Registry populated with stub CapacitySources under
// the given names. A source named "Fussy" rejects any non-empty config.
func registryWith(names ...string) *dataprovider.Registry {
	r := dataprovider.NewRegistry()
	for _, name := range names {
		if err := r.RegisterCapacity(stubCapacitySource{name: name, fussy: name == "Fussy"}); err != nil {
			panic(err)
		}
	}
	return r
}

// providerWith returns a CapacityProvider referencing provider with the
// given raw JSON config.
func providerWith(provider string, config []byte) *v1alpha1.CapacityProvider {
	p := &v1alpha1.CapacityProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "test-provider"},
		Spec:       v1alpha1.CapacityProviderSpec{Provider: provider},
	}
	if len(config) > 0 {
		p.Spec.Config = runtime.RawExtension{Raw: config}
	}
	return p
}

func TestUnknownProviderKeyIsRejected(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	_, err := v.ValidateCreate(t.Context(), providerWith("NoSuchThing", nil))
	require.ErrorContains(t, err, "unknown provider")
}

func TestConfigIsValidatedByTheImplementation(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("Fussy"))
	_, err := v.ValidateCreate(t.Context(), providerWith("Fussy", []byte(`{"bad":true}`)))
	// Rejected at apply time, not discovered broken on first fetch.
	require.Error(t, err)
}

func TestValidConfigIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", []byte(`{"namespace":"kube-system"}`)))
	require.NoError(t, err)
}

func TestInlineCredentialIsRejected(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"token", "password", "bearerToken"} {
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
			config := []byte(fmt.Sprintf(`{%q:"super-secret-value"}`, key))
			_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", config))
			require.ErrorContains(t, err, "secretRef")
			assert.NotContains(t, err.Error(), "super-secret-value")
		})
	}
}

func TestSecretRefConfigIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", []byte(`{"secretRef":{"name":"creds"}}`)))
	require.NoError(t, err)
}

// TestNestedInlineCredentialIsRejected covers a fix-round-1 finding: a
// credential nested under a grouping key (e.g. "auth.token") is exactly how
// real provider configs shape inline secrets, and must be caught, not just
// a bare top-level key.
func TestNestedInlineCredentialIsRejected(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	config := []byte(`{"auth":{"token":"s3cr3t"}}`)
	_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", config))
	require.ErrorContains(t, err, "auth.token")
	assert.NotContains(t, err.Error(), "s3cr3t")
}

// TestCredentialNestedInsideArrayElementIsRejected covers a credential
// buried inside an array of objects, another realistic config shape the
// flat top-level-only check would have missed.
func TestCredentialNestedInsideArrayElementIsRejected(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	config := []byte(`{"clusters":[{"name":"a"},{"password":"s3cr3t"}]}`)
	_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", config))
	require.ErrorContains(t, err, "password")
	assert.NotContains(t, err.Error(), "s3cr3t")
}

// TestNestedSecretRefConfigIsAccepted confirms the recursive scan does not
// over-match: a secretRef nested under a grouping key is still fine.
func TestNestedSecretRefConfigIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	config := []byte(`{"auth":{"secretRef":{"name":"creds"}}}`)
	_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", config))
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
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	config := nestedConfig(maxCredentialScanDepth+10, "note", "not a credential")
	_, err := v.ValidateCreate(t.Context(), providerWith("KubernetesCapacity", config))
	require.ErrorContains(t, err, "exceeds the maximum depth")
}

func TestValidateUpdateAlsoValidatesConfig(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("Fussy"))
	oldProvider := providerWith("Fussy", nil)
	newProvider := providerWith("Fussy", []byte(`{"bad":true}`))
	_, err := v.ValidateUpdate(t.Context(), oldProvider, newProvider)
	require.Error(t, err)
}

func TestValidateDeleteAlwaysAdmitsProvider(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	warnings, err := v.ValidateDelete(t.Context(), providerWith("KubernetesCapacity", nil))
	require.NoError(t, err)
	require.Nil(t, warnings)
}
