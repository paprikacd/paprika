package investigator

import (
	"context"

	appsv1 "k8s.io/api/apps/v1"
)

// DeploymentReplicasDriftDetector flags Deployments where ReadyReplicas < Replicas.
// Escalates to Critical if ready == 0 (zero-capacity outage).
type DeploymentReplicasDriftDetector struct{}

// ID returns the detector's stable identifier.
func (d *DeploymentReplicasDriftDetector) ID() string { return "deployment_replicas_drift" }

// Severity is Warning; overridden to Critical per-finding when ready==0.
func (d *DeploymentReplicasDriftDetector) Severity() Severity { return SeverityWarning }

// Detect reads the Deployment's live replicas.
func (d *DeploymentReplicasDriftDetector) Detect(ctx context.Context, in Input) ([]Finding, error) {
	if in.LiveManifest == nil || in.LiveManifest.GetKind() != "Deployment" {
		return nil, nil
	}
	var dep appsv1.Deployment
	if err := fromUnstructured(in.LiveManifest, &dep); err != nil {
		return nil, nil
	}
	desired := int32(0)
	if dep.Spec.Replicas != nil {
		desired = *dep.Spec.Replicas
	}
	ready := dep.Status.ReadyReplicas
	if desired <= 0 {
		return nil, nil
	}
	if ready >= desired {
		return nil, nil
	}
	sev := SeverityWarning
	if ready == 0 {
		sev = SeverityCritical
	}
	title := "Deployment replicas mismatch"
	if ready == 0 {
		title = "Deployment has 0 ready replicas (outage)"
	}
	return []Finding{
		{
			ID:       "deployment_replicas_" + dep.Name,
			Severity: sev,
			Title:    title,
			Description: "Deployment " + dep.Namespace + "/" + dep.Name + " has " +
				itoa(int(ready)) + "/" + itoa(int(desired)) + " ready replicas. " +
				"Either pods are failing to start or the rollout is in progress.",
			Evidence: []Evidence{
				{Source: "manifest", Summary: "spec.replicas=" + itoa(int(desired)) + ", status.readyReplicas=" + itoa(int(ready))},
			},
			Playbook: []string{
				"Inspect the failing Pod — most replicas are happy when a subset fail",
				"Check `kubectl get pods -l app=" + dep.Name + "` for CrashLoop/ImagePull issues",
				"Rollout history: `kubectl rollout history deployment " + dep.Name + "`",
				"Verify imagePullSecrets, serviceAccount, and nodeSelector are correct",
			},
		},
	}, nil
}
