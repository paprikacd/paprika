package controller

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
)

const pruneTestAppName = "prune-test-app"

var pruneTestApp = &pipelinesv1alpha1.Application{
	ObjectMeta: metav1.ObjectMeta{
		Name:      pruneTestAppName,
		Namespace: "default",
	},
	Status: pipelinesv1alpha1.ApplicationStatus{
		ReleaseRef: "release-10",
	},
}

func newPruneTestClient(objs ...client.Object) client.Client {
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

func releaseWithPhase(name string, ts time.Time, phase pipelinesv1alpha1.ReleasePhase) *pipelinesv1alpha1.Release {
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         "default",
			CreationTimestamp: metav1.Time{Time: ts},
			Labels: map[string]string{
				engine.ApplicationNameLabelKey: pruneTestAppName,
			},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase: phase,
		},
	}
}

func buildReleases(base time.Time, phases []pipelinesv1alpha1.ReleasePhase) []client.Object {
	objs := make([]client.Object, 0, len(phases))
	for i, phase := range phases {
		objs = append(objs, releaseWithPhase(fmt.Sprintf("release-%02d", i), base.Add(time.Duration(i)*time.Hour), phase))
	}
	return objs
}

func countReleases(ctx context.Context, t *testing.T, r *ApplicationReconciler) int {
	t.Helper()
	var list pipelinesv1alpha1.ReleaseList
	if err := r.List(ctx, &list, client.InNamespace("default"), client.MatchingLabels{engine.ApplicationNameLabelKey: pruneTestAppName}); err != nil {
		t.Fatalf("list releases: %v", err)
	}
	return len(list.Items)
}

func releaseNames(list *pipelinesv1alpha1.ReleaseList) map[string]bool {
	names := make(map[string]bool, len(list.Items))
	for i := range list.Items {
		names[list.Items[i].Name] = true
	}
	return names
}

func TestApplicationReconciler_pruneOldReleases_noPruningWhenBelowLimit(t *testing.T) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := make([]pipelinesv1alpha1.ReleasePhase, 5)
	for i := range phases {
		phases[i] = pipelinesv1alpha1.ReleaseSuperseded
	}
	recorder := record.NewFakeRecorder(10)
	r := &ApplicationReconciler{Client: newPruneTestClient(buildReleases(base, phases)...), EventRecorder: recorder}

	if err := r.pruneOldReleases(ctx, pruneTestApp); err != nil {
		t.Fatalf("pruneOldReleases failed: %v", err)
	}

	if got := countReleases(ctx, t, r); got != 5 {
		t.Fatalf("expected 5 releases, got %d", got)
	}

	select {
	case ev := <-recorder.Events:
		t.Fatalf("unexpected event: %s", ev)
	default:
	}
}

func TestApplicationReconciler_pruneOldReleases_prunesOldAndProtectsActiveAndLatest(t *testing.T) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := []pipelinesv1alpha1.ReleasePhase{
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded, // release-10 is active (still protected as active)
		pipelinesv1alpha1.ReleaseComplete,   // release-11 is latest non-superseded
	}
	recorder := record.NewFakeRecorder(10)
	r := &ApplicationReconciler{Client: newPruneTestClient(buildReleases(base, phases)...), EventRecorder: recorder}

	if err := r.pruneOldReleases(ctx, pruneTestApp); err != nil {
		t.Fatalf("pruneOldReleases failed: %v", err)
	}

	if got := countReleases(ctx, t, r); got != maxReleaseHistory {
		t.Fatalf("expected %d releases, got %d", maxReleaseHistory, got)
	}

	var list pipelinesv1alpha1.ReleaseList
	if err := r.List(ctx, &list, client.InNamespace("default"), client.MatchingLabels{engine.ApplicationNameLabelKey: pruneTestAppName}); err != nil {
		t.Fatalf("list releases: %v", err)
	}
	kept := releaseNames(&list)

	if !kept["release-10"] {
		t.Fatalf("active release release-10 was pruned")
	}
	if !kept["release-11"] {
		t.Fatalf("latest non-superseded release release-11 was pruned")
	}
	if kept["release-0"] || kept["release-1"] {
		t.Fatalf("oldest releases should have been pruned: got release-0=%v release-1=%v", kept["release-0"], kept["release-1"])
	}

	select {
	case ev := <-recorder.Events:
		want := "Normal PrunedReleases Pruned 2 old releases"
		if diff := cmp.Diff(want, ev); diff != "" {
			t.Fatalf("unexpected event (-want +got):\n%s", diff)
		}
	default:
		t.Fatalf("expected PrunedReleases event")
	}
}

func TestApplicationReconciler_pruneOldReleases_missingActiveStillPrunesSafely(t *testing.T) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := make([]pipelinesv1alpha1.ReleasePhase, 12)
	for i := range phases {
		phases[i] = pipelinesv1alpha1.ReleaseSuperseded
	}
	app := pruneTestApp.DeepCopy()
	app.Status.ReleaseRef = "does-not-exist"
	recorder := record.NewFakeRecorder(10)
	r := &ApplicationReconciler{Client: newPruneTestClient(buildReleases(base, phases)...), EventRecorder: recorder}

	if err := r.pruneOldReleases(ctx, app); err != nil {
		t.Fatalf("pruneOldReleases failed: %v", err)
	}

	if got := countReleases(ctx, t, r); got != maxReleaseHistory {
		t.Fatalf("expected %d releases, got %d", maxReleaseHistory, got)
	}
}

func TestApplicationReconciler_recordEvent(t *testing.T) {
	t.Run("records event when recorder is present", func(t *testing.T) {
		recorder := record.NewFakeRecorder(1)
		r := &ApplicationReconciler{EventRecorder: recorder}
		app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"}}

		r.recordEvent(app, corev1.EventTypeNormal, "TestReason", "test message")

		select {
		case ev := <-recorder.Events:
			if ev == "" {
				t.Fatalf("expected non-empty event")
			}
		default:
			t.Fatalf("expected event to be recorded")
		}
	})

	t.Run("no panic when recorder is nil", func(t *testing.T) {
		r := &ApplicationReconciler{}
		app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"}}
		r.recordEvent(app, corev1.EventTypeNormal, "TestReason", "test message")
	})
}

func TestApplicationReconciler_handleSyncTrigger(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name       string
		annotation string
	}{
		{"sync annotation", "paprika.io/sync"},
		{"legacy resync annotation", "paprika.io/resync"},
		{"legacy webhook trigger annotation", "paprika.io/webhook-trigger"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:        "sync-app",
					Namespace:   "default",
					Annotations: map[string]string{tc.annotation: "123"},
				},
				Status: pipelinesv1alpha1.ApplicationStatus{
					Phase: pipelinesv1alpha1.ApplicationHealthy,
				},
			}

			scheme := runtime.NewScheme()
			_ = pipelinesv1alpha1.AddToScheme(scheme)
			c := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(app).
				WithStatusSubresource(&pipelinesv1alpha1.Application{}).
				Build()

			r := &ApplicationReconciler{Client: c}
			_, err := r.handleSyncTrigger(ctx, app)
			if err != nil {
				t.Fatalf("handleSyncTrigger failed: %v", err)
			}

			var updated pipelinesv1alpha1.Application
			if err := c.Get(ctx, client.ObjectKey{Name: "sync-app", Namespace: "default"}, &updated); err != nil {
				t.Fatalf("get application: %v", err)
			}
			if len(updated.Annotations) > 0 {
				t.Fatalf("expected trigger annotations to be removed, got %v", updated.Annotations)
			}
			if updated.Status.Phase != pipelinesv1alpha1.ApplicationPending {
				t.Fatalf("expected phase Pending, got %s", updated.Status.Phase)
			}
		})
	}
}

func TestApplicationReconciler_hasSyncTrigger(t *testing.T) {
	cases := []struct {
		name string
		ann  map[string]string
		want bool
	}{
		{"sync annotation", map[string]string{"paprika.io/sync": "1"}, true},
		{"legacy resync annotation", map[string]string{"paprika.io/resync": "1"}, true},
		{"legacy webhook trigger annotation", map[string]string{"paprika.io/webhook-trigger": "1"}, true},
		{"no annotations", nil, false},
		{"unrelated annotation", map[string]string{"other": "1"}, false},
	}

	r := &ApplicationReconciler{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:        "app",
					Namespace:   "default",
					Annotations: tc.ann,
				},
			}
			if got := r.hasSyncTrigger(app); got != tc.want {
				t.Fatalf("hasSyncTrigger = %v, want %v", got, tc.want)
			}
		})
	}
}
