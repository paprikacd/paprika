package investigator

import (
	"context"
	"strings"
)

// ImagePullDetector flags pods that could not pull their container image.
type ImagePullDetector struct{}

// ID returns the detector's stable identifier.
func (d *ImagePullDetector) ID() string { return "image_pull" }

// Severity returns Critical — the Pod can't run.
func (d *ImagePullDetector) Severity() Severity { return SeverityCritical }

// Detect scans K8s events for image-pull related failures.
func (d *ImagePullDetector) Detect(ctx context.Context, in Input) ([]Finding, error) {
	if in.LiveManifest == nil {
		return nil, nil
	}
	if in.LiveManifest.GetKind() != "Pod" {
		return nil, nil
	}
	podName := in.LiveManifest.GetName()
	podNamespace := in.LiveManifest.GetNamespace()
	reasons := map[string]bool{"Failed": true, "BackOff": true, "ErrImagePull": true, "Pulling": true, "FailedToCreatePodSandbox": true}
	var ev []Evidence
	var msg strings.Builder
	for _, e := range in.Events {
		if e.ObjectKind != "Pod" || e.ObjectName != podName || e.ObjectNamespace != podNamespace {
			continue
		}
		if reasons[e.Reason] {
			ev = append(ev, Evidence{
				Source:    "events",
				Timestamp: e.LastTimestamp,
				Summary:   e.Reason + ": " + e.Message,
			})
			if msg.Len() > 0 {
				msg.WriteString("; ")
			}
			msg.WriteString(e.Reason)
			msg.WriteString(": ")
			msg.WriteString(e.Message)
		}
	}
	if len(ev) == 0 {
		return nil, nil
	}
	return []Finding{
		{
			ID:       "image_pull_" + podName,
			Severity: SeverityCritical,
			Title:    "Image pull failure",
			Description: "Pod " + podNamespace + "/" + podName + " could not pull its container image. " +
				"Check the image name, tag, registry credentials, and any imagePullSecrets.",
			Evidence:    ev,
			Playbook: []string{
				"Run `kubectl describe pod " + podName + "` to see the exact pull error",
				"Verify the image tag exists in the registry (typo, missing digest, sha pinning)",
				"Ensure imagePullSecrets are present in the Pod spec AND bound to the ServiceAccount",
				"For private registries, create a `docker-registry` secret and reference it",
			},
		},
	}, nil
}
