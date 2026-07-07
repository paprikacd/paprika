package investigator

import (
	"context"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// CrashLoopDetector emits a Critical finding when a Pod's container has
// restarted several times recently, or is currently in CrashLoopBackOff.
type CrashLoopDetector struct{}

// ID returns the detector's stable identifier.
func (d *CrashLoopDetector) ID() string { return "crash_loop" }

// Severity returns Critical — CrashLoop is operationally severe.
func (d *CrashLoopDetector) Severity() Severity { return SeverityCritical }

// Detect inspects the live Pod manifest for restart counts and waiting reasons.
func (d *CrashLoopDetector) Detect(ctx context.Context, in Input) ([]Finding, error) {
	if in.LiveManifest == nil {
		return nil, nil
	}
	if in.LiveManifest.GetKind() != "Pod" {
		return nil, nil
	}
	// Re-parse the containers / statuses from the unstructured object.
	var pod corev1.Pod
	if err := fromUnstructured(in.LiveManifest, &pod); err != nil {
		return nil, nil
	}

	for _, cs := range pod.Status.ContainerStatuses {
		if cs.RestartCount >= 3 || cs.State.Waiting != nil && cs.State.Waiting.Reason == "CrashLoopBackOff" {
			f := Finding{
				ID:       "crash_loop_" + cs.Name,
				Severity: SeverityCritical,
				Title:    "CrashLoopBackOff detected",
				Description: "Container " + cs.Name + " has restarted " + itoa(int(cs.RestartCount)) +
					" times. K8s has stopped retrying as soon as the backoff cap is reached.",
				Evidence: []Evidence{
					{Source: "manifest", Summary: "Pod " + pod.Namespace + "/" + pod.Name + " container " + cs.Name + " waiting reason: " + reasonOrEmpty(cs)},
				},
				Playbook: []string{
					"Open the Logs tab on this pod and inspect the last stack trace or panic",
					"Verify the image tag is correct and the entrypoint command exists",
					"Check if the container's memory limit is too low — OOMKilled often shows as restart loop",
					"Run `kubectl describe pod <name>` to see the Last Termination State and Reason",
				},
			}
			if pod.Status.Message != "" {
				f.Evidence = append(f.Evidence, Evidence{Source: "status", Summary: pod.Status.Message})
			}
			return []Finding{f}, nil
		}
	}
	return nil, nil
}

func reasonOrEmpty(cs corev1.ContainerStatus) string {
	if cs.State.Waiting != nil {
		return cs.State.Waiting.Reason
	}
	if cs.State.Terminated != nil {
		return cs.State.Terminated.Reason
	}
	return ""
}

// fromUnstructured converts an unstructured pod back into the typed object.
func fromUnstructured(u *unstructured.Unstructured, out any) error {
	return runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, out)
}

// unused-but-keeps-import from strings while we have the custom helpers.
var _ = strings.Repeat
