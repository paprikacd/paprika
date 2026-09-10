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
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
)

// binding returns a DataProviderBinding named name, bound to the given
// scope kind and name, pointing at a fixed provider reference.
func binding(name string, kind v1alpha1.ScopeKind, scopeName string) *v1alpha1.DataProviderBinding {
	return &v1alpha1.DataProviderBinding{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: v1alpha1.DataProviderBindingSpec{
			ProviderRef: v1alpha1.ProviderReference{Kind: "CapacityProvider", Name: "some-provider"},
			Scope:       v1alpha1.BindingScope{Kind: kind, Name: scopeName},
		},
	}
}

// fakeClientWith returns a controller-runtime fake client, scoped to the
// providers/v1alpha1 scheme, seeded with objs.
func fakeClientWith(objs ...client.Object) client.Client {
	scheme := runtime.NewScheme()
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		panic(err)
	}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

func TestDuplicateBindingForOneScopeAndClassIsRejected(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing))
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeCluster, "prod-eu-1"))
	require.ErrorContains(t, err, "already bound")
}

func TestDifferentScopeNamesAreNotDuplicates(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing))
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeCluster, "prod-us-1"))
	require.NoError(t, err)
}

func TestDifferentScopeKindsAreNotDuplicates(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing))
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeNamespace, "prod-eu-1"))
	require.NoError(t, err)
}

func TestUpdatingABindingDoesNotConflictWithItself(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing))
	updated := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	updated.Spec.ProviderRef.Name = "different-provider"
	_, err := v.ValidateUpdate(t.Context(), existing, updated)
	require.NoError(t, err)
}

// TestClusterScopedBindingWithEmptyNameIsRejected covers the Task 3 review
// finding: the resolver compares scope.name by string equality, so a
// Cluster-scoped binding with an empty name would silently over-match a
// scope that also has no cluster set.
func TestClusterScopedBindingWithEmptyNameIsRejected(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith())
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeCluster, ""))
	require.ErrorContains(t, err, "scope name is required")
}

// TestGlobalScopedBindingWithEmptyNameIsAccepted is the exemption: Global
// legitimately has no name to compare.
func TestGlobalScopedBindingWithEmptyNameIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith())
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeGlobal, ""))
	require.NoError(t, err)
}

func TestValidateDeleteAlwaysAdmitsBinding(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith())
	warnings, err := v.ValidateDelete(t.Context(), binding("a", v1alpha1.ScopeGlobal, ""))
	require.NoError(t, err)
	require.Nil(t, warnings)
}
