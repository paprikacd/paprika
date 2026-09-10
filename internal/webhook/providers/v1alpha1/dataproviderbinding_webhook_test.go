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

// testControlPlaneNamespace is where the validator is told this control plane
// runs, and so the only namespace whose Global-scoped bindings are admitted.
// The existing fixtures live there, so every pre-existing case is unaffected.
const testControlPlaneNamespace = "default"

// binding returns a DataProviderBinding named name, bound to the given
// scope kind and name, pointing at a fixed provider reference.
func binding(name string, kind v1alpha1.ScopeKind, scopeName string) *v1alpha1.DataProviderBinding {
	return &v1alpha1.DataProviderBinding{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testControlPlaneNamespace},
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
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeCluster, "prod-eu-1"))
	require.ErrorContains(t, err, "already bound")
}

func TestDifferentScopeNamesAreNotDuplicates(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeCluster, "prod-us-1"))
	require.NoError(t, err)
}

func TestDifferentScopeKindsAreNotDuplicates(t *testing.T) {
	t.Parallel()
	// Both bindings name the same scope name, so only the kind distinguishes
	// them. The name is the binding's own namespace because a Namespace-scoped
	// binding may name no other; see ScopeIsPermitted.
	existing := binding("a", v1alpha1.ScopeCluster, testControlPlaneNamespace)
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeNamespace, testControlPlaneNamespace))
	require.NoError(t, err)
}

// bindingTo returns a binding named name that points at the CapacityProvider
// called providerName, at the given scope.
func bindingTo(name, providerName string, kind v1alpha1.ScopeKind, scopeName string) *v1alpha1.DataProviderBinding {
	b := binding(name, kind, scopeName)
	b.Spec.ProviderRef.Name = providerName
	return b
}

// TestTwoProvidersMayBeBoundToOneScope covers the whole-branch review's
// critical finding: both shipped implementations are Kind CapacityProvider, so
// a duplicate rule keyed on the ref kind alone forbade binding
// KubernetesCapacity and MetricsServer to the same scope — which is precisely
// the composition ResolveAll and Merge exist to serve. KubernetesCapacity
// supplies allocatable and requested; MetricsServer completes the meter with
// used.
func TestTwoProvidersMayBeBoundToOneScope(t *testing.T) {
	t.Parallel()
	existing := bindingTo("bind-structural", "kubernetes-capacity", v1alpha1.ScopeGlobal, "")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(),
		bindingTo("bind-usage", "metrics-server", v1alpha1.ScopeGlobal, ""))
	require.NoError(t, err, "composing two providers at one scope is the point of the model")
}

// TestTheSameProviderTwiceAtOneScopeIsRejected is the other direction: two
// bindings for one provider object at one scope say nothing the first does not,
// and ResolveAll would pick one of them arbitrarily.
func TestTheSameProviderTwiceAtOneScopeIsRejected(t *testing.T) {
	t.Parallel()
	existing := bindingTo("bind-one", "kubernetes-capacity", v1alpha1.ScopeGlobal, "")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(),
		bindingTo("bind-two", "kubernetes-capacity", v1alpha1.ScopeGlobal, ""))
	require.ErrorContains(t, err, "already bound")
}

// TestSameProviderNameInAnotherNamespaceIsNotADuplicate holds the identity the
// duplicate key uses to the one ResolveAll groups by: providerRef carries no
// namespace, so "structural" in two namespaces is two different provider
// objects, and both may bind one cluster.
func TestSameProviderNameInAnotherNamespaceIsNotADuplicate(t *testing.T) {
	t.Parallel()
	existing := bindingTo("a", "structural", v1alpha1.ScopeCluster, "prod-eu-1")
	existing.Namespace = "other-tenant"
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), bindingTo("b", "structural", v1alpha1.ScopeCluster, "prod-eu-1"))
	require.NoError(t, err)
}

// TestNamespaceScopedBindingNamingAnotherNamespaceIsRejected covers the
// whole-branch finding that Namespace is the most specific level in the chain,
// so an unguarded one lets any tenant win the precedence chain inside another
// tenant's namespace.
func TestNamespaceScopedBindingNamingAnotherNamespaceIsRejected(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), bindingIn("tenant", "a", v1alpha1.ScopeNamespace, "victim"))
	require.ErrorContains(t, err, "may only name the namespace it lives in")
	require.ErrorContains(t, err, "tenant", "the message must name the namespace that would satisfy the rule")
}

func TestNamespaceScopedBindingNamingItsOwnNamespaceIsAdmitted(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), bindingIn("tenant", "a", v1alpha1.ScopeNamespace, "tenant"))
	require.NoError(t, err)
}

// TestValidateUpdateAppliesTheNamespaceScopeRule keeps the rule from being
// reachable by creating a well-scoped binding and then repointing it.
func TestValidateUpdateAppliesTheNamespaceScopeRule(t *testing.T) {
	t.Parallel()
	existing := bindingIn("tenant", "a", v1alpha1.ScopeNamespace, "tenant")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateUpdate(t.Context(), existing, bindingIn("tenant", "a", v1alpha1.ScopeNamespace, "victim"))
	require.ErrorContains(t, err, "may only name the namespace it lives in")
}

// TestScopeSelectorIsRejectedUntilSomethingReadsIt covers the minor finding of
// the same class as validateNoConfig: the CRD serves scope.selector and no
// resolver consults it, so a selector an operator sets would silently widen the
// binding to the whole scope.
func TestScopeSelectorIsRejectedUntilSomethingReadsIt(t *testing.T) {
	t.Parallel()
	b := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	b.Spec.Scope.Selector = &metav1.LabelSelector{MatchLabels: map[string]string{"tier": "gold"}}
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), b)
	require.ErrorContains(t, err, "not yet supported")
}

func TestAnAbsentScopeSelectorIsAdmitted(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeCluster, "prod-eu-1"))
	require.NoError(t, err)
}

func TestUpdatingABindingDoesNotConflictWithItself(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
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
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeCluster, ""))
	require.ErrorContains(t, err, "scope name is required")
}

// TestGlobalScopedBindingWithEmptyNameIsAccepted is the exemption: Global
// legitimately has no name to compare.
func TestGlobalScopedBindingWithEmptyNameIsAccepted(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeGlobal, ""))
	require.NoError(t, err)
}

func TestValidateDeleteAlwaysAdmitsBinding(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	warnings, err := v.ValidateDelete(t.Context(), binding("a", v1alpha1.ScopeGlobal, ""))
	require.NoError(t, err)
	require.Nil(t, warnings)
}

// bindingIn returns a binding that lives in namespace rather than in the
// control plane's namespace.
func bindingIn(namespace, name string, kind v1alpha1.ScopeKind, scopeName string) *v1alpha1.DataProviderBinding {
	b := binding(name, kind, scopeName)
	b.Namespace = namespace
	return b
}

// TestGlobalBindingOutsideTheControlPlaneNamespaceIsRejected covers the Task 7
// review finding: Global scope applies to every tenant, so a tenant-created
// Global binding would repoint what the whole fleet sees. The resolver already
// ignores such a binding; admission is what tells an operator why, instead of
// leaving a binding that exists and does nothing.
func TestGlobalBindingOutsideTheControlPlaneNamespaceIsRejected(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), bindingIn("tenant", "a", v1alpha1.ScopeGlobal, ""))
	require.ErrorContains(t, err, "Global scope applies to the whole fleet")
	require.ErrorContains(t, err, testControlPlaneNamespace,
		"the message must name the namespace that would satisfy the rule")
}

func TestGlobalBindingRejectionNamesOnlyTheNamespaceRequirement(t *testing.T) {
	t.Parallel()
	// Another tenant's binding is in the listing the duplicate check walks; the
	// rejection must not mention it, or one tenant learns another's bindings.
	existing := bindingIn("other-tenant", "their-binding", v1alpha1.ScopeGlobal, "")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), bindingIn("tenant", "a", v1alpha1.ScopeGlobal, ""))
	require.Error(t, err)
	require.NotContains(t, err.Error(), "their-binding")
	require.NotContains(t, err.Error(), "other-tenant")
}

func TestGlobalBindingInTheControlPlaneNamespaceIsAdmitted(t *testing.T) {
	t.Parallel()
	v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeGlobal, ""))
	require.NoError(t, err)
}

func TestScopedBindingsAreAdmittedFromAnyNamespace(t *testing.T) {
	t.Parallel()
	// The rule is about Global scope alone: a tenant binding a provider to its
	// own namespace, cluster or project is exactly what scoping is for.
	tests := map[string]struct {
		kind      v1alpha1.ScopeKind
		scopeName string
	}{
		"namespace": {kind: v1alpha1.ScopeNamespace, scopeName: "tenant"},
		"cluster":   {kind: v1alpha1.ScopeCluster, scopeName: "prod-eu-1"},
		"project":   {kind: v1alpha1.ScopeProject, scopeName: "payments"},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			v := NewBindingValidator(fakeClientWith(), testControlPlaneNamespace)
			_, err := v.ValidateCreate(t.Context(), bindingIn("tenant", "a", test.kind, test.scopeName))
			require.NoError(t, err)
		})
	}
}

func TestNoNamespaceMayDeclareGlobalScopeWhenNoControlPlaneNamespaceIsSet(t *testing.T) {
	t.Parallel()
	// Fail closed: a deployment that has not been told where its control plane
	// runs must not honour a Global binding from wherever it finds one.
	v := NewBindingValidator(fakeClientWith(), "")
	_, err := v.ValidateCreate(t.Context(), binding("a", v1alpha1.ScopeGlobal, ""))
	require.ErrorContains(t, err, "Global scope applies to the whole fleet")
}

// TestValidateUpdateAppliesTheGlobalNamespaceRule keeps the rule from being
// reachable by creating a scoped binding and then widening it.
func TestValidateUpdateAppliesTheGlobalNamespaceRule(t *testing.T) {
	t.Parallel()
	existing := bindingIn("tenant", "a", v1alpha1.ScopeNamespace, "tenant")
	v := NewBindingValidator(fakeClientWith(existing), testControlPlaneNamespace)
	_, err := v.ValidateUpdate(t.Context(), existing, bindingIn("tenant", "a", v1alpha1.ScopeGlobal, ""))
	require.ErrorContains(t, err, "Global scope applies to the whole fleet")
}
