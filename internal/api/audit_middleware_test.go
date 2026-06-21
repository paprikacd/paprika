package apiserver

import (
	"testing"

	"github.com/benebsworth/paprika/internal/api/auth"
)

func TestClassifyAudit(t *testing.T) {
	cases := []struct {
		procedure    string
		wantAction   string
		wantResource string
		wantMutating bool
	}{
		{"/paprika.v1.PaprikaService/SyncApplication", "update", "Application", true},
		{"/paprika.v1.PaprikaService/ApplyBundle", "apply", "Bundle", true},
		{"/paprika.v1.PaprikaService/ApproveGate", "approve", "Gate", true},
		{"/paprika.v1.PaprikaService/RejectGate", "reject", "Gate", true},
		{"/paprika.v1.PaprikaService/RollbackRelease", "update", "Release", true},
		{"/paprika.v1.PaprikaService/PromoteRollout", "promote", "Rollout", true},
		{"/paprika.v1.PaprikaService/AbortRollout", "update", "Rollout", true},
		{"/paprika.v1.PaprikaService/ListApplications", "", "", false},
		{"/paprika.v1.PaprikaService/GetApplication", "", "", false},
		{"/paprika.v1.PaprikaService/ListGateStatus", "", "", false},
		{"/paprika.v1.PaprikaService/ResolveSource", "", "", false},
		{"/paprika.v1.PaprikaService/Render", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.procedure, func(t *testing.T) {
			action, resource, mutating := classifyAudit(tc.procedure)
			if action != tc.wantAction || resource != tc.wantResource || mutating != tc.wantMutating {
				t.Errorf("classifyAudit(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tc.procedure, action, resource, mutating, tc.wantAction, tc.wantResource, tc.wantMutating)
			}
		})
	}
}

func TestClassifyAuditHandlesBareProcedure(t *testing.T) {
	action, resource, mutating := classifyAudit("SyncApplication")
	if !mutating || action != "update" || resource != "Application" {
		t.Errorf("classifyAudit(\"SyncApplication\") = (%q, %q, %v), want (update, Application, true)",
			action, resource, mutating)
	}
}

func TestPrincipalString(t *testing.T) {
	cases := []struct {
		name string
		p    *auth.Principal
		want string
	}{
		{"nil", nil, ""},
		{"subject wins", &auth.Principal{Subject: "sub-123", Email: "a@b.c", Name: "Alice"}, "sub-123"},
		{"email fallback", &auth.Principal{Email: "a@b.c", Name: "Alice"}, "a@b.c"},
		{"name fallback", &auth.Principal{Name: "Alice"}, "Alice"},
		{"empty", &auth.Principal{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := principalString(tc.p); got != tc.want {
				t.Errorf("principalString() = %q, want %q", got, tc.want)
			}
		})
	}
}
