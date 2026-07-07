package investigator

import (
	"context"

	corev1 "k8s.io/api/core/v1"
)

// OOMKilledDetector flags any container whose LastTerminationState was OOMKilled.
type OOMKilledDetector struct{}

// ID returns the detector's stable identifier.
func (d *OOMKilledDetector) ID() string { return "oom_killed" }

// Severity returns Critical — OOMKilled is a workload bug.
func (d *OOMKilledDetector) Severity() Severity { return SeverityCritical }

// Detect reads the live Pod manifest's container statuses.
func (d *OOMKilledDetector) Detect(ctx context.Context, in Input) ([]Finding, error) {
	if in.LiveManifest == nil || in.LiveManifest.GetKind() != "Pod" {
		return nil, nil
	}
	var pod corev1.Pod
	if err := fromUnstructured(in.LiveManifest, &pod); err != nil {
		return nil, nil
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.LastTerminationState.Terminated != nil && cs.LastTerminationState.Terminated.Reason == "OOMKilled" {
			exit := cs.LastTerminationState.Terminated.ExitCode
			f := Finding{
				ID:          "oom_" + cs.Name,
				Severity:    SeverityCritical,
				Title:       "Container OOMKilled",
				Description: "Container " + cs.Name + " was OOMKilled on last termination (exit " + itoa(int(exit)) + "). Container exceeded its memory limit.",
				Evidence: []Evidence{
					{Source: "manifest", Summary: "Pod " + pod.Namespace + "/" + pod.Name + " container " + cs.Name + " memory status: terminated: OOMKilled"},
				},
				Playbook: []string{
					"Inspect the Pod's memory.request and memory.limit values",
					"Profile the process — increase the limit if a real leak isn't the cause",
					"Check whether another container in the same Pod competes for the same memory cgroup",
					"Look for `container exited with code 137` in the Logs tab",
				},
			}
			return []Finding{f}, nil
		}
	}
	return nil, nil
}
