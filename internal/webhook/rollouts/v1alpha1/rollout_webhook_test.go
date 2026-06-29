package v1alpha1

import (
	"context"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/util/intstr"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

func int32Ptr(i int32) *int32 {
	return &i
}

func TestRollingRejectsBothZero(t *testing.T) {
	zero := intstr.FromInt32(0)
	ro := &rolloutsv1alpha1.Rollout{
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: int32Ptr(4),
			Strategy: rolloutsv1alpha1.RolloutStrategy{
				Type:    "Rolling",
				Rolling: &rolloutsv1alpha1.RollingStrategy{MaxSurge: &zero, MaxUnavailable: &zero},
			},
		},
	}
	v := &RolloutCustomValidator{}
	_, err := v.ValidateCreate(context.Background(), ro)
	if err == nil || !strings.Contains(err.Error(), "maxSurge and maxUnavailable cannot both be zero") {
		t.Fatalf("expected both-zero rejection, got %v", err)
	}
}

func TestRollingRejectsNegative(t *testing.T) {
	// Use FromInt32 — FromString would land in the percent-parse branch.
	neg := intstr.FromInt32(-1)
	ro := &rolloutsv1alpha1.Rollout{
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: int32Ptr(4),
			Strategy: rolloutsv1alpha1.RolloutStrategy{
				Type:    "Rolling",
				Rolling: &rolloutsv1alpha1.RollingStrategy{MaxSurge: &neg},
			},
		},
	}
	v := &RolloutCustomValidator{}
	_, err := v.ValidateCreate(context.Background(), ro)
	if err == nil {
		t.Fatalf("expected negative rejection, got nil")
	}
}

func TestRollingAcceptsReplicasZero(t *testing.T) {
	// Scale-to-zero is a legitimate pattern; the both-zero check must not
	// fire when desiredReplicas is itself zero.
	surge := intstr.FromString("25%")
	unavail := intstr.FromString("25%")
	ro := &rolloutsv1alpha1.Rollout{
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: int32Ptr(0),
			Strategy: rolloutsv1alpha1.RolloutStrategy{
				Type: "Rolling",
				Rolling: &rolloutsv1alpha1.RollingStrategy{
					MaxSurge:       &surge,
					MaxUnavailable: &unavail,
				},
			},
		},
	}
	v := &RolloutCustomValidator{}
	_, err := v.ValidateCreate(context.Background(), ro)
	if err != nil {
		t.Fatalf("expected replicas=0 with default 25%%/25%% to validate, got %v", err)
	}
}

func TestRollingAcceptsPercentDefaults(t *testing.T) {
	// The defaulter sets "25%" for both. Verify those values actually validate
	// (the validator must resolve percentages, not treat them as zero).
	surge := intstr.FromString("25%")
	unavail := intstr.FromString("25%")
	ro := &rolloutsv1alpha1.Rollout{
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: int32Ptr(4),
			Strategy: rolloutsv1alpha1.RolloutStrategy{
				Type: "Rolling",
				Rolling: &rolloutsv1alpha1.RollingStrategy{
					MaxSurge:       &surge,
					MaxUnavailable: &unavail,
				},
			},
		},
	}
	v := &RolloutCustomValidator{}
	_, err := v.ValidateCreate(context.Background(), ro)
	if err != nil {
		t.Fatalf("expected 25%%/25%% to validate, got %v", err)
	}
}
