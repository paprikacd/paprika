package v1alpha1

import (
	"slices"
	"testing"
)

func TestAllows(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		policies []ManagementPolicy
		action   ManagementPolicy
		want     bool
	}{
		{"unset grants full management", nil, ManagementPolicyApply, true},
		{"unset grants prune", nil, ManagementPolicyPrune, true},
		{"explicitly empty grants nothing", ManagementPolicySet{}, ManagementPolicyObserve, false},
		{"wildcard grants observe", []ManagementPolicy{ManagementPolicyAll}, ManagementPolicyObserve, true},
		{"wildcard grants rollout", []ManagementPolicy{ManagementPolicyAll}, ManagementPolicyRollout, true},
		{"observe only denies apply", []ManagementPolicy{ManagementPolicyObserve}, ManagementPolicyApply, false},
		{"observe only denies prune", []ManagementPolicy{ManagementPolicyObserve}, ManagementPolicyPrune, false},
		{"apply without prune denies prune", []ManagementPolicy{ManagementPolicyApply}, ManagementPolicyPrune, false},
		{"apply grants apply", []ManagementPolicy{ManagementPolicyApply}, ManagementPolicyApply, true},
		{"explicit every policy", AllManagementPolicies(), ManagementPolicyDelete, true},
		{"unknown action is denied", []ManagementPolicy{ManagementPolicyAll}, ManagementPolicy("Bogus"), false},
		{"unset denies unknown action", nil, ManagementPolicy("Bogus"), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := Allows(tt.policies, tt.action); got != tt.want {
				t.Errorf("Allows(%v, %q) = %v, want %v", tt.policies, tt.action, got, tt.want)
			}
		})
	}
}

func TestNormalizeManagementPolicies(t *testing.T) {
	t.Parallel()

	if got := NormalizeManagementPolicies(nil); !slices.Equal(got, []ManagementPolicy{ManagementPolicyAll}) {
		t.Errorf("nil should resolve to the wildcard, got %v", got)
	}
	empty := NormalizeManagementPolicies(ManagementPolicySet{})
	if empty == nil {
		t.Fatal("an explicitly empty set must stay empty, not become nil")
	}
	if len(empty) != 0 {
		t.Errorf("an explicitly empty set must grant nothing, got %v", empty)
	}
}

func TestIntersectManagementPolicies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		ceiling   []ManagementPolicy
		requested []ManagementPolicy
		want      []ManagementPolicy
	}{
		{
			"unset ceiling and request intersect to every policy",
			nil, nil, AllManagementPolicies(),
		},
		{
			"observe ceiling denies a managed request",
			[]ManagementPolicy{ManagementPolicyObserve},
			[]ManagementPolicy{ManagementPolicyAll},
			[]ManagementPolicy{ManagementPolicyObserve},
		},
		{
			"observe request narrows a full ceiling",
			[]ManagementPolicy{ManagementPolicyAll},
			[]ManagementPolicy{ManagementPolicyObserve},
			[]ManagementPolicy{ManagementPolicyObserve},
		},
		{
			"apply without prune on both sides",
			[]ManagementPolicy{ManagementPolicyApply},
			[]ManagementPolicy{ManagementPolicyApply},
			[]ManagementPolicy{ManagementPolicyApply},
		},
		{
			"disjoint sets grant nothing",
			[]ManagementPolicy{ManagementPolicyObserve},
			[]ManagementPolicy{ManagementPolicyApply},
			[]ManagementPolicy{},
		},
		{
			"empty ceiling grants nothing",
			ManagementPolicySet{},
			[]ManagementPolicy{ManagementPolicyAll},
			[]ManagementPolicy{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := IntersectManagementPolicies(tt.ceiling, tt.requested)
			if !slices.Equal(got, tt.want) {
				t.Errorf("IntersectManagementPolicies(%v, %v) = %v, want %v",
					tt.ceiling, tt.requested, got, tt.want)
			}
		})
	}
}

func TestIntersectManagementPoliciesIsDeterministic(t *testing.T) {
	t.Parallel()

	// A status field depends on this ordering being stable across calls, so the
	// result must not follow map iteration or input order.
	one := IntersectManagementPolicies(
		[]ManagementPolicy{ManagementPolicyRollout, ManagementPolicyApply, ManagementPolicyAll},
		[]ManagementPolicy{ManagementPolicyPrune, ManagementPolicyAll},
	)
	two := IntersectManagementPolicies(
		[]ManagementPolicy{ManagementPolicyAll},
		[]ManagementPolicy{ManagementPolicyAll},
	)
	if !slices.Equal(one, two) {
		t.Fatalf("policy resolution depends on input order: %v vs %v", one, two)
	}
}

func TestManagementPoliciesEqual(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		left  []ManagementPolicy
		right []ManagementPolicy
		want  bool
	}{
		{"wildcard equals the explicit list", []ManagementPolicy{ManagementPolicyAll}, AllManagementPolicies(), true},
		{"wildcard differs from observe only", []ManagementPolicy{ManagementPolicyAll}, []ManagementPolicy{ManagementPolicyObserve}, false},
		{"nil equals wildcard", nil, []ManagementPolicy{ManagementPolicyAll}, true},
		{"empty differs from wildcard", ManagementPolicySet{}, []ManagementPolicy{ManagementPolicyAll}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := ManagementPoliciesEqual(tt.left, tt.right); got != tt.want {
				t.Errorf("ManagementPoliciesEqual(%v, %v) = %v, want %v", tt.left, tt.right, got, tt.want)
			}
		})
	}
}

func TestAllManagementPoliciesIsCloned(t *testing.T) {
	t.Parallel()

	first := AllManagementPolicies()
	first[0] = ManagementPolicy("Corrupted")
	if got := AllManagementPolicies()[0]; got != ManagementPolicyObserve {
		t.Fatalf("AllManagementPolicies shares its backing array: got %q", got)
	}
}
