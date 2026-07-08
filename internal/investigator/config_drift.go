package investigator

import (
	"context"
	"strings"
)

// ConfigDriftDetector emits a Warning when the live manifest differs from
// desired in any non-trivial way. The diff string is provided by the caller
// in Input.Diff (a unified diff of the YAML manifests, server-fields stripped).
type ConfigDriftDetector struct{}

// ID returns the detector's stable identifier.
func (d *ConfigDriftDetector) ID() string { return "config_drift" }

// Severity returns Warning — drift is interesting but rarely critical.
func (d *ConfigDriftDetector) Severity() Severity { return SeverityWarning }

// Detect returns a finding when Input.Diff is non-empty.
func (d *ConfigDriftDetector) Detect(ctx context.Context, in Input) ([]Finding, error) { //nolint:gocritic // Detector interface takes Input by value.
	if strings.TrimSpace(in.Diff) == "" {
		return nil, nil
	}
	return []Finding{
		{
			ID:       "config_drift_" + in.Ref.Name,
			Severity: SeverityWarning,
			Title:    "Live manifest diverges from desired",
			Description: "The cluster's live manifest does not match the desired manifest. " +
				"This often indicates out-of-band kubectl edits, a stuck Helm release, or " +
				"a partial sync.",
			Evidence: []Evidence{
				{
					Source:  "diff",
					Summary: firstLines(in.Diff, 12),
				},
			},
			Playbook: []string{
				"Open the Diff tab to inspect the changes line-by-line",
				"Re-run the Sync action to push the desired manifest back into the cluster",
				"If drift is intentional, capture it into source control and let Argo-style sync push the changes",
			},
		},
	}, nil
}

func firstLines(s string, n int) string {
	out := []string{}
	count := 0
	for _, line := range strings.Split(s, "\n") {
		if count >= n {
			break
		}
		out = append(out, line)
		count++
	}
	if count < strings.Count(s, "\n") {
		out = append(out, "…")
	}
	return strings.Join(out, "\n")
}
