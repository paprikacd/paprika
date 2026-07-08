package investigator

import (
	"context"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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
func (d *PendingSchedulingDetector) Detect(ctx context.Context, in Input) ([]Finding, error) { //nolint:gocritic // Detector interface takes Input by value.
	if !isPendingPod(in.LiveManifest) {
		return nil, nil
	}
	podName := in.LiveManifest.GetName()
	podNamespace := in.LiveManifest.GetNamespace()
	ev := failedSchedulingEvidence(in.Events, podName)
	if len(ev) == 0 {
		return nil, nil
	}
	return []Finding{
		{
			ID:       "pending_" + podName,
			Severity: SeverityWarning,
			Title:    "Pod stuck Pending",
			Description: "Pod " + podNamespace + "/" + podName + " has been Pending. The scheduler reported " +
				"a FailedScheduling reason. The most common cause is insufficient cluster capacity.",
			Evidence: ev,
			Playbook: []string{
				"Run `kubectl describe pod " + podName + "` and read the Events section",
				"Confirm the namespace has enough ResourceQuota headroom",
				"For nodeSelector / affinity / taints, ensure at least one node satisfies them",
				"Cluster autoscaler: confirm it's enabled and didn't fail to scale up",
			},
		},
	}, nil
}

func isPendingPod(manifest *unstructured.Unstructured) bool {
	if manifest == nil || manifest.GetKind() != "Pod" {
		return false
	}
	status, ok := manifest.Object["status"].(map[string]interface{})
	if !ok {
		return false
	}
	phase, ok := status["phase"].(string)
	return ok && phase == "Pending"
}

func failedSchedulingEvidence(events []KubernetesEvent, podName string) []Evidence {
	var ev []Evidence
	for _, e := range events {
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
	return ev
}
