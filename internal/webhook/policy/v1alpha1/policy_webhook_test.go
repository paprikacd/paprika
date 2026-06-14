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
	"testing"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

func TestValidateCreate(t *testing.T) {
	validator := &PolicyCustomValidator{}
	ctx := context.Background()

	cases := []struct {
		name    string
		policy  *policyv1alpha1.Policy
		wantErr bool
	}{
		{
			name: "valid critical enforce policy",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Severity:      policyv1alpha1.PolicySeverityCritical,
					DefaultAction: policyv1alpha1.PolicyActionEnforce,
					Expression:    "object.spec.replicas > 1",
				},
			},
		},
		{
			name: "valid warning policy without default action",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Severity:   policyv1alpha1.PolicySeverityWarning,
					Expression: "kind == 'Deployment'",
				},
			},
		},
		{
			name: "missing severity",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Expression: "kind == 'Deployment'",
				},
			},
			wantErr: true,
		},
		{
			name: "invalid severity",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Severity:   "info",
					Expression: "kind == 'Deployment'",
				},
			},
			wantErr: true,
		},
		{
			name: "missing expression",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Severity: policyv1alpha1.PolicySeverityWarning,
				},
			},
			wantErr: true,
		},
		{
			name: "invalid CEL expression",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Severity:   policyv1alpha1.PolicySeverityWarning,
					Expression: "object.spec.replicas +",
				},
			},
			wantErr: true,
		},
		{
			name: "invalid default action",
			policy: &policyv1alpha1.Policy{
				Spec: policyv1alpha1.PolicySpec{
					Severity:      policyv1alpha1.PolicySeverityWarning,
					DefaultAction: "ignore",
					Expression:    "kind == 'Deployment'",
				},
			},
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validator.ValidateCreate(ctx, tc.policy)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateUpdate(t *testing.T) {
	validator := &PolicyCustomValidator{}
	ctx := context.Background()

	policy := &policyv1alpha1.Policy{
		Spec: policyv1alpha1.PolicySpec{
			Severity:   policyv1alpha1.PolicySeverityCritical,
			Expression: "object.spec.replicas > 0",
		},
	}

	if _, err := validator.ValidateUpdate(ctx, policy, policy); err != nil {
		t.Fatalf("expected valid update: %v", err)
	}
}

func TestValidateDelete(t *testing.T) {
	validator := &PolicyCustomValidator{}
	ctx := context.Background()

	policy := &policyv1alpha1.Policy{}
	if _, err := validator.ValidateDelete(ctx, policy); err != nil {
		t.Fatalf("expected delete to be allowed: %v", err)
	}
}
