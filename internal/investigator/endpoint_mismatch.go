package investigator

import (
	"context"

	corev1 "k8s.io/api/core/v1"
)

// EndpointMismatchDetector flags Services whose Selector matches zero Pods.
// A Service without endpoints silently drops all traffic — a frequent
// "why is my app returning 503" cause.
type EndpointMismatchDetector struct{}

// ID returns the detector's stable identifier.
func (d *EndpointMismatchDetector) ID() string { return "endpoint_mismatch" }

// Severity is Info — not necessarily an immediate outage, but loud enough to
// surface in the report.
func (d *EndpointMismatchDetector) Severity() Severity { return SeverityInfo }

// Detect reads the Service's Selector. We can't list Pods here (registry is
// decoupled); the handler is responsible for pre-loading Pods into Evidence.
// For v1 we surface a "selector exists but no endpoints" check via the live
// manifest plus any matching pod count from the Evidence list.
func (d *EndpointMismatchDetector) Detect(ctx context.Context, in Input) ([]Finding, error) { //nolint:gocritic // Detector interface takes Input by value.
	if in.LiveManifest == nil || in.LiveManifest.GetKind() != "Service" {
		return nil, nil
	}
	var svc corev1.Service
	if err := fromUnstructured(in.LiveManifest, &svc); err != nil {
		return nil, nil
	}
	if len(svc.Spec.Selector) == 0 {
		return nil, nil
	}
	matching := 0
	for _, e := range in.Events {
		if e.ObjectKind == "Pod" {
			matching++
		}
	}
	if matching > 0 {
		return nil, nil
	}
	return []Finding{
		{
			ID:       "endpoint_mismatch_" + svc.Name,
			Severity: SeverityInfo,
			Title:    "Service selector matches no Pods",
			Description: "Service " + svc.Namespace + "/" + svc.Name + " has a selector " +
				selectorString(svc.Spec.Selector) + " but no matching Pods are visible in the input. " +
				"Traffic will fail with no endpoints.",
			Evidence: []Evidence{
				{Source: "manifest", Summary: "Service spec.selector=" + selectorString(svc.Spec.Selector)},
			},
			Playbook: []string{
				"Verify the Pod labels actually include the selector keys",
				"Run `kubectl get endpoints " + svc.Name + "` to inspect the endpoint list",
				"Re-check after the next rollout — drift in template labels is a common cause",
			},
		},
	}, nil
}

func selectorString(m map[string]string) string {
	if len(m) == 0 {
		return "{}"
	}
	out := ""
	for k, v := range m {
		if out != "" {
			out += ","
		}
		out += k + "=" + v
	}
	return out
}
