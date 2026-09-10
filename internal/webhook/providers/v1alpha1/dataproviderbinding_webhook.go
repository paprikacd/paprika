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
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
)

var dataproviderbindinglog = logf.Log.WithName("dataproviderbinding-resource")

// SetupDataProviderBindingWebhookWithManager registers the
// DataProviderBinding validating webhook.
func SetupDataProviderBindingWebhookWithManager(mgr ctrl.Manager, controlPlaneNamespace string) error {
	if err := ctrl.NewWebhookManagedBy(mgr, &v1alpha1.DataProviderBinding{}).
		WithValidator(NewBindingValidator(mgr.GetClient(), controlPlaneNamespace)).
		Complete(); err != nil {
		return fmt.Errorf("setting up dataproviderbinding webhook: %w", err)
	}
	return nil
}

// +kubebuilder:webhook:path=/validate-providers-paprika-io-v1alpha1-dataproviderbinding,mutating=false,failurePolicy=fail,sideEffects=None,groups=providers.paprika.io,resources=dataproviderbindings,verbs=create;update,versions=v1alpha1,name=vdataproviderbinding-v1alpha1.kb.io,admissionReviewVersions=v1

// BindingValidator rejects a DataProviderBinding that would leave the
// resolver unable to tell it apart from another binding: one whose
// non-Global scope has no name (the resolver compares scope.name by string
// equality, so an empty name would over-match a scope that also has no
// value set at that level), and one that duplicates another binding's
// (providerRef.kind, scope.kind, scope.name) triple.
//
// It also rejects a Global-scoped binding created outside the control plane's
// namespace, which would otherwise let one tenant repoint what every other
// tenant sees. The resolver ignores exactly those bindings; admission is what
// turns a silently inert binding into a clear error an operator can act on.
type BindingValidator struct {
	client client.Client

	// controlPlaneNamespace is the one namespace permitted to host a
	// Global-scoped binding. Empty permits none: see
	// DataProviderBinding.ScopeIsPermitted.
	controlPlaneNamespace string
}

// NewBindingValidator returns a validator that checks new and updated
// bindings against the bindings already on the cluster via c, treating
// controlPlaneNamespace as the only namespace that may declare Global scope.
func NewBindingValidator(c client.Client, controlPlaneNamespace string) *BindingValidator {
	return &BindingValidator{client: c, controlPlaneNamespace: controlPlaneNamespace}
}

func (v *BindingValidator) ValidateCreate(ctx context.Context, obj *v1alpha1.DataProviderBinding) (admission.Warnings, error) {
	dataproviderbindinglog.Info("Validation for DataProviderBinding upon creation", "name", obj.GetName())
	return nil, v.validate(ctx, obj)
}

func (v *BindingValidator) ValidateUpdate(ctx context.Context, _, newObj *v1alpha1.DataProviderBinding) (admission.Warnings, error) {
	dataproviderbindinglog.Info("Validation for DataProviderBinding upon update", "name", newObj.GetName())
	return nil, v.validate(ctx, newObj)
}

func (v *BindingValidator) ValidateDelete(_ context.Context, obj *v1alpha1.DataProviderBinding) (admission.Warnings, error) {
	dataproviderbindinglog.Info("Validation for DataProviderBinding upon deletion", "name", obj.GetName())
	return nil, nil
}

func (v *BindingValidator) validate(ctx context.Context, binding *v1alpha1.DataProviderBinding) error {
	var allErrs field.ErrorList
	scopePath := field.NewPath("spec").Child("scope")

	if !binding.ScopeIsPermitted(v.controlPlaneNamespace) {
		allErrs = append(allErrs, field.Forbidden(scopePath.Child("kind"),
			fmt.Sprintf("Global scope applies to the whole fleet, so a Global-scoped binding "+
				"may only be created in the control plane namespace %q", v.controlPlaneNamespace)))
		// Stop here rather than falling through to the duplicate check. That
		// check lists bindings fleet-wide and names the one it collides with,
		// so running it for a binding that is already invalid would tell one
		// tenant what another tenant has bound, for no benefit: the message
		// names the requirement and the namespace that satisfies it, and
		// nothing else.
		return newInvalidErr(kindDataProviderBinding, binding.Name, allErrs)
	}

	if binding.Spec.Scope.Kind != v1alpha1.ScopeGlobal && binding.Spec.Scope.Name == "" {
		allErrs = append(allErrs, field.Required(scopePath.Child("name"),
			fmt.Sprintf("scope name is required for %s-scoped bindings; only Global scope may leave it empty", binding.Spec.Scope.Kind)))
	}

	dup, err := v.findDuplicate(ctx, binding)
	if err != nil {
		return apierrors.NewInternalError(err)
	}
	if dup != "" {
		allErrs = append(allErrs, field.Forbidden(scopePath,
			fmt.Sprintf("this scope is already bound by %q", dup)))
	}

	return newInvalidErr(kindDataProviderBinding, binding.Name, allErrs)
}

// findDuplicate returns the name of another binding that already covers the
// same (providerRef.kind, scope.kind, scope.name) triple as binding, or ""
// when none does. binding itself (matched by namespace and name, present in
// the listing on an update) is never treated as its own duplicate.
func (v *BindingValidator) findDuplicate(ctx context.Context, binding *v1alpha1.DataProviderBinding) (string, error) {
	var existing v1alpha1.DataProviderBindingList
	if err := v.client.List(ctx, &existing); err != nil {
		return "", fmt.Errorf("list data provider bindings: %w", err)
	}

	for i := range existing.Items {
		other := &existing.Items[i]
		if other.Namespace == binding.Namespace && other.Name == binding.Name {
			continue
		}
		if other.Spec.ProviderRef.Kind == binding.Spec.ProviderRef.Kind &&
			other.Spec.Scope.Kind == binding.Spec.Scope.Kind &&
			other.Spec.Scope.Name == binding.Spec.Scope.Name {
			return other.Name, nil
		}
	}
	return "", nil
}
