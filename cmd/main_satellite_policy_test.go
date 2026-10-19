package main

import (
	"reflect"
	"testing"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

func TestParseSatelliteAutonomy(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		raw     string
		want    clustersv1alpha1.AutonomyMode
		wantErr bool
	}{
		{"unset falls back to failover", "", clustersv1alpha1.AutonomyFailover, false},
		{"observe only", "ObserveOnly", clustersv1alpha1.AutonomyObserveOnly, false},
		{"failover", "Failover", clustersv1alpha1.AutonomyFailover, false},
		{"delegated", "Delegated", clustersv1alpha1.AutonomyDelegated, false},
		{"whitespace is trimmed", "  Delegated  ", clustersv1alpha1.AutonomyDelegated, false},
		{"unknown mode is refused", "Autonomous", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseSatelliteAutonomy(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSatelliteAutonomy(%q) accepted an unknown mode", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSatelliteAutonomy(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Errorf("mode = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParseSatellitePolicies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		raw     []string
		want    []clustersv1alpha1.ManagementPolicy
		wantErr bool
	}{
		{"unset defaults to full management", nil, []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyAll}, false},
		{"wildcard", []string{"*"}, []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyAll}, false},
		{"observe only", []string{"Observe"}, []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve}, false},
		{
			"several, blank entries dropped",
			[]string{"Observe", " ", "Apply"},
			[]clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve, clustersv1alpha1.ManagementPolicyApply},
			false,
		},
		{"only blanks falls back to full management", []string{" ", ""}, []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyAll}, false},
		{"unknown policy is refused", []string{"Destroy"}, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseSatellitePolicies(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSatellitePolicies(%v) accepted an unknown policy", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSatellitePolicies(%v): %v", tt.raw, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("policies = %v, want %v", got, tt.want)
			}
		})
	}
}
