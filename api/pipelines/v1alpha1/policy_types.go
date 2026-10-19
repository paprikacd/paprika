package v1alpha1

import "slices"

// ManagementPolicy names one capability Paprika may exercise against a target
// cluster. The vocabulary follows Crossplane's managementPolicies: a policy set
// is an allow-list, so a nil set means "unspecified" and defaults to full
// management, while an explicitly empty set grants nothing.
//
// The set is evaluated per action, not per resource: a release that may Apply
// but not Prune leaves removed manifests in the cluster rather than deleting
// them, which is what an operator adopting an existing cluster needs.
// +kubebuilder:validation:Enum=Observe;Apply;Prune;Delete;SelfHeal;Rollout;*
type ManagementPolicy string

const (
	// ManagementPolicyObserve reads state — inventory, drift, health, capacity.
	// It never mutates the target cluster, so it is always safe to combine with
	// any other policy and never needs to be revoked to stop writes.
	ManagementPolicyObserve ManagementPolicy = "Observe"
	// ManagementPolicyApply creates and updates managed resources, including
	// sync hooks.
	ManagementPolicyApply ManagementPolicy = "Apply"
	// ManagementPolicyPrune deletes managed resources that are no longer in the
	// desired manifest set.
	ManagementPolicyPrune ManagementPolicy = "Prune"
	// ManagementPolicyDelete deletes managed resources when a Release is
	// deleted. Without it, release cleanup orphans the workloads on purpose.
	ManagementPolicyDelete ManagementPolicy = "Delete"
	// ManagementPolicySelfHeal lets self-heal re-apply drift and roll back a
	// degraded release without an operator asking.
	ManagementPolicySelfHeal ManagementPolicy = "SelfHeal"
	// ManagementPolicyRollout lets traffic shift progressively through canary,
	// blue-green, A/B and mirror strategies, and lets analysis abort them.
	ManagementPolicyRollout ManagementPolicy = "Rollout"
	// ManagementPolicyAll grants every policy this binary knows. A binary only
	// ever evaluates its own vocabulary, so "future" means "the next release's
	// list", not an action this build cannot name.
	ManagementPolicyAll ManagementPolicy = "*"
)

// ManagementPolicySet is an allow-list of ManagementPolicy values.
type ManagementPolicySet []ManagementPolicy

// allManagementPolicies lists every concrete policy in evaluation order. A
// future policy must be added here, which is what makes "which policy gates
// this action" a compile-time question rather than a grep.
var allManagementPolicies = [...]ManagementPolicy{
	ManagementPolicyObserve,
	ManagementPolicyApply,
	ManagementPolicyPrune,
	ManagementPolicyDelete,
	ManagementPolicySelfHeal,
	ManagementPolicyRollout,
}

// AllManagementPolicies returns every concrete policy, in evaluation order.
func AllManagementPolicies() []ManagementPolicy {
	return slices.Clone(allManagementPolicies[:])
}

// DefaultManagementPolicies is the set applied when a spec leaves the field
// unset (nil, not explicitly empty): full management, matching behaviour that
// predates the field.
func DefaultManagementPolicies() []ManagementPolicy {
	return []ManagementPolicy{ManagementPolicyAll}
}

// NormalizeManagementPolicies resolves an unset allow-list to its default.
// A nil slice is unset; an explicitly empty slice stays empty and therefore
// grants nothing. This distinction is the whole point of the API: a caller
// must be able to say "manage nothing here" without deleting the field.
func NormalizeManagementPolicies(policies []ManagementPolicy) []ManagementPolicy {
	if policies == nil {
		return DefaultManagementPolicies()
	}
	return policies
}

// Allows reports whether the allow-list grants action. An unset list resolves
// to the default first, so a spec that never heard of policies keeps working.
//
// An action outside this build's vocabulary is always denied, even under "*".
// A caller asking about a policy the binary does not implement has made a
// mistake, and answering "granted" would turn that mistake into a silent
// permission grant.
func Allows(policies []ManagementPolicy, action ManagementPolicy) bool {
	if !KnownManagementPolicy(action) {
		return false
	}
	for _, granted := range NormalizeManagementPolicies(policies) {
		if granted == ManagementPolicyAll || granted == action {
			return true
		}
	}
	return false
}

// KnownManagementPolicy reports whether a value names one of this build's
// concrete policies. The wildcard is not an action; nothing does "everything",
// it only grants.
func KnownManagementPolicy(value ManagementPolicy) bool {
	return slices.Contains(allManagementPolicies[:], value)
}

// ValidManagementPolicy reports whether a value is acceptable in a policy list:
// either a concrete policy or the wildcard.
func ValidManagementPolicy(value ManagementPolicy) bool {
	return value == ManagementPolicyAll || KnownManagementPolicy(value)
}

// IntersectManagementPolicies returns the policies granted by both the ceiling
// and the request. Both sides resolve their own default first, so an unset
// ceiling and an unset request intersect to full management rather than to
// nothing.
//
// The result is always a concrete, ordered list with the wildcard expanded, so a
// status field can report exactly what a placement may do and two equivalent
// specs compare equal.
func IntersectManagementPolicies(ceiling, requested []ManagementPolicy) []ManagementPolicy {
	effective := make([]ManagementPolicy, 0, len(allManagementPolicies))
	for _, policy := range allManagementPolicies {
		if Allows(ceiling, policy) && Allows(requested, policy) {
			effective = append(effective, policy)
		}
	}
	return effective
}

// ManagementPoliciesEqual reports whether two allow-lists grant the same set of
// concrete policies. It is used to decide whether a status field changed, where
// "*" and the explicit list mean the same thing.
func ManagementPoliciesEqual(left, right []ManagementPolicy) bool {
	return slices.Equal(IntersectManagementPolicies(left, DefaultManagementPolicies()),
		IntersectManagementPolicies(right, DefaultManagementPolicies()))
}
