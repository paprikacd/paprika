package investigator

import (
	"context"
	"strings"
)

// ForbiddenRbacDetector flags K8s events with reason "Forbidden" which usually
// indicate ServiceAccount/RBAC misconfiguration.
type ForbiddenRbacDetector struct{}

// ID returns the detector's stable identifier.
func (d *ForbiddenRbacDetector) ID() string { return "forbidden_rbac" }

// Severity returns Warning — RBAC failures are usually recoverable by re-binding.
func (d *ForbiddenRbacDetector) Severity() Severity { return SeverityWarning }

// Detect scans events for Forbidden reason targeting the resource.
func (d *ForbiddenRbacDetector) Detect(ctx context.Context, in Input) ([]Finding, error) { //nolint:gocritic // Detector interface takes Input by value.
	var ev []Evidence
	for _, e := range in.Events {
		if e.Reason != "Forbidden" {
			continue
		}
		if e.ObjectKind != in.Ref.Kind || e.ObjectName != in.Ref.Name {
			continue
		}
		ev = append(ev, Evidence{
			Source:    "events",
			Timestamp: e.LastTimestamp,
			Summary:   e.Reason + ": " + e.Message,
		})
	}
	if len(ev) == 0 {
		return nil, nil
	}
	var sb strings.Builder
	sb.WriteString("Resource ")
	sb.WriteString(in.Ref.Kind)
	sb.WriteString("/")
	sb.WriteString(in.Ref.Name)
	sb.WriteString(" received Forbidden errors. The Subject (ServiceAccount) lacks the " +
		"permission to perform the requested verb, or the RoleBinding is missing.")
	return []Finding{
		{
			ID:          "forbidden_" + in.Ref.Name,
			Severity:    SeverityWarning,
			Title:       "RBAC denial events detected",
			Description: sb.String(),
			Evidence:    ev,
			Playbook: []string{
				"Run `kubectl auth can-i <verb> <resource> --as=system:serviceaccount:<ns>:<sa>`",
				"Bind the missing Role / ClusterRole via RoleBinding / ClusterRoleBinding",
				"Verify the Pod's `serviceAccountName` matches the binding's Subject",
			},
		},
	}, nil
}
