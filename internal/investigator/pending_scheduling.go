package investigator

import (
	"context"
	"strings"
)

// PendingSchedulingDetector flags pods stuck in Pending because the scheduler
// could not find (or refused) a node. Detected by matching pod phase +
// FailedScheduling events.
type PendingSchedulingDetector struct{}

// ID returns the detector's stable identifier.
func (d *PendingSchedulingDetector) ID() string { return "pending_scheduling" }

// Severity is Warning — usually a capacity or topology issue, recoverable.
func (d *PendingSchedulingDetector) Severity() Severity { return SeverityWarning }

// Detect checks the pod phase and any FailedScheduling events.
func (d *PendingSchedulingDetector) Detect(ctx context.Context, in Input) ([]Finding, error) {
	if in.LiveManifest == nil || in.LiveManifest.GetKind() != "Pod" {
		return nil, nil
	}
	podName := in.LiveManifest.GetName()
	podNamespace := in.LiveManifest.GetNamespace()
	var ev []Evidence
	hasPendingPhase := false
	for _, e := range in.Events {
		if e.ObjectKind != "Pod" || e.ObjectName != podName {
			continue
		}
		if e.Type == "Warning" && strings.Contains(e.Reason, "Failed") {
			ev = append(ev, Evidence{
				Source:    "events",
				Timestamp: e.LastTimestamp,
				Summary:   e.Reason + ": " + e.Message,
			})
		}
	}
	if v, ok := in.LiveManifest.Object["status"].(map[string]interface{}); ok {
		if phase, _ := v["phase"].(string); phase == "Pending" {
			hasPendingPhase = true
		}
	}
	if !(hasPendingPhase && len(ev) > 0) {
		return nil, nil
	}
	return []Finding{
		{
			ID:       "pending_" + podName,
			Severity: SeverityWarning,
			Title:    "Pod stuck Pending",
			Description: "Pod " + podNamespace + "/" + podName + " has been Pending. The scheduler reported " +
				"a FailedScheduling reason. The most common cause is insufficient cluster capacity.",
			Evidence:    ev,
			Playbook: []string{
				"Run `kubectl describe pod " + podName + "` and read the Events section",
				"Confirm the namespace has enough ResourceQuota headroom",
				"For nodeSelector / affinity / taints, ensure at least one node satisfies them",
				"Cluster autoscaler: confirm it's enabled and didn't fail to scale up",
			},
		},
	}, nil
}
