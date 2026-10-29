package pipelines

import (
	"k8s.io/apimachinery/pkg/api/equality"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// applicationUpdateFilter drops the watch event an Application's own
// observation write produces.
//
// Every health observation patches status.healthChecks[].checkedAt (plus the
// probe's duration and response body), and every 30 seconds the deployment
// observation's observedAt bucket moves. Without a filter each of those writes
// came straight back as an update event and ran a second full reconcile,
// including a repo-server render for drift, with nothing left to do: the
// reconcile that wrote the observation had already acted on it and scheduled
// the next one with RequeueAfter. On omega-ha (2026-10-29) that doubled every
// Application's reconcile rate (4/min for a 30s check, 24/min for the 5s
// promotion-demo checks) and accounted for roughly half of the controller's
// reconciles and of the repo server's render requests.
//
// Only updates whose sole difference is that bookkeeping are dropped. Spec,
// generation, labels, annotations (paprika.io/sync among them), finalizers,
// deletion, owner references and every other status field still reconcile at
// once, whoever wrote them: the release controller and the API write gates and
// the release reference into this status, and those must be seen immediately.
// Informer resyncs (an unchanged object) also still pass.
func applicationUpdateFilter() predicate.Predicate {
	return predicate.Funcs{
		UpdateFunc: func(e event.UpdateEvent) bool {
			oldApp, okOld := e.ObjectOld.(*paprikav1.Application)
			newApp, okNew := e.ObjectNew.(*paprikav1.Application)
			if !okOld || !okNew {
				return true
			}
			return !observationOnlyUpdate(oldApp, newApp)
		},
	}
}

// observationOnlyUpdate reports whether newApp differs from oldApp only in when
// and how an unchanged observation was recorded: the write's resourceVersion
// and managed fields, each health check's checkedAt, durationMillis, response
// body and its truncation flag, and the deployment observation's observedAt.
// The outcome of a check (status, message, reason, HTTP code, failure count,
// recent failures, SLO history) is not bookkeeping, nor is anything outside
// status. TestApplicationUpdateFilterReconcilesEveryOtherField enumerates the
// API types by reflection and fails when this list grows or a new field is
// left out of the comparison.
func observationOnlyUpdate(oldApp, newApp *paprikav1.Application) bool {
	if oldApp.ResourceVersion == newApp.ResourceVersion {
		// An informer resync, not a write.
		return false
	}
	// Everything else, metadata (generation included) and spec, is compared
	// whole: only the fields cleared below may differ.
	return equality.Semantic.DeepEqual(withoutObservationBookkeeping(oldApp), withoutObservationBookkeeping(newApp))
}

func withoutObservationBookkeeping(app *paprikav1.Application) *paprikav1.Application {
	out := app.DeepCopy()
	out.ResourceVersion = ""
	out.ManagedFields = nil
	for i := range out.Status.HealthChecks {
		check := &out.Status.HealthChecks[i]
		check.CheckedAt = nil
		check.DurationMillis = 0
		check.HTTPBody = ""
		check.BodyTruncated = false
	}
	if out.Status.DeploymentObservation != nil {
		out.Status.DeploymentObservation.ObservedAt = metav1.Time{}
	}
	return out
}
