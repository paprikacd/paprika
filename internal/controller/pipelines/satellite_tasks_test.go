package pipelines

import (
	"context"
	"errors"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1proto "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

type fakeDispatcher struct {
	connected  map[types.NamespacedName]bool
	dispatched []*paprikav1proto.SatelliteTask
	result     *paprikav1proto.SatelliteTaskResult
	err        error
}

func (f *fakeDispatcher) Connected(key types.NamespacedName) bool {
	return f.connected[key]
}

func (f *fakeDispatcher) Dispatch(
	_ context.Context,
	_ types.NamespacedName,
	task *paprikav1proto.SatelliteTask,
) (*paprikav1proto.SatelliteTaskResult, error) {
	f.dispatched = append(f.dispatched, task)
	return f.result, f.err
}

func TestApplyViaSatelliteLinkDispatchesWhenConnected(t *testing.T) {
	t.Parallel()

	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	dispatcher := &fakeDispatcher{
		connected: map[types.NamespacedName]bool{key: true},
		result:    &paprikav1proto.SatelliteTaskResult{Ok: true, Applied: 4},
	}
	r := &ReleaseReconciler{SatelliteTasks: dispatcher}

	handled, err := r.applyViaSatelliteLink(context.Background(),
		&paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"},
		"checkout", "api", []byte("kind: ConfigMap\n"))
	if err != nil {
		t.Fatalf("applyViaSatelliteLink: %v", err)
	}
	if !handled {
		t.Fatal("a connected cluster must report the dispatch as handled")
	}
	if len(dispatcher.dispatched) != 1 {
		t.Fatalf("dispatched %d tasks, want 1", len(dispatcher.dispatched))
	}
	apply := dispatcher.dispatched[0].GetApply()
	if apply.GetNamespace() != "checkout" || apply.GetAppName() != "api" {
		t.Errorf("task = %#v", apply)
	}
	if string(apply.GetManifests()) != "kind: ConfigMap\n" {
		t.Errorf("manifests = %q", apply.GetManifests())
	}
}

func TestApplyViaSatelliteLinkFallsBackWhenNoLink(t *testing.T) {
	t.Parallel()

	dispatcher := &fakeDispatcher{connected: map[types.NamespacedName]bool{}}
	r := &ReleaseReconciler{SatelliteTasks: dispatcher}

	handled, err := r.applyViaSatelliteLink(context.Background(),
		&paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"},
		"checkout", "api", nil)
	if err != nil {
		t.Fatalf("applyViaSatelliteLink: %v", err)
	}
	if handled {
		t.Fatal("an unattached cluster must not report a dispatch")
	}
	if len(dispatcher.dispatched) != 0 {
		t.Error("nothing may be dispatched to a cluster with no link")
	}
}

func TestApplyViaSatelliteLinkDoesNotFallBackAfterAFailedApply(t *testing.T) {
	t.Parallel()

	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	dispatcher := &fakeDispatcher{
		connected: map[types.NamespacedName]bool{key: true},
		result:    &paprikav1proto.SatelliteTaskResult{Ok: false, Error: "apply failed", Errors: []string{"configmaps is forbidden"}},
	}
	r := &ReleaseReconciler{SatelliteTasks: dispatcher}

	handled, err := r.applyViaSatelliteLink(context.Background(),
		&paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"},
		"checkout", "api", nil)
	if !handled {
		t.Fatal("a failed apply over a live link must still count as handled")
	}
	if err == nil {
		t.Fatal("a failed apply must be reported")
	}
	// The message carries the satellite's own account, which is what an operator
	// needs to fix it.
	for _, want := range []string{"apply failed", "configmaps is forbidden"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
}

func TestApplyViaSatelliteLinkPropagatesDispatchErrors(t *testing.T) {
	t.Parallel()

	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	dispatcher := &fakeDispatcher{
		connected: map[types.NamespacedName]bool{key: true},
		err:       errors.New("link dropped"),
	}
	r := &ReleaseReconciler{SatelliteTasks: dispatcher}

	handled, err := r.applyViaSatelliteLink(context.Background(),
		&paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"},
		"checkout", "api", nil)
	if !handled {
		t.Fatal("a dispatch error must not be retried over a second transport")
	}
	if err == nil || !strings.Contains(err.Error(), "link dropped") {
		t.Fatalf("err = %v, want the dispatch failure", err)
	}
}

func TestApplyViaSatelliteLinkIgnoresUnnamedTargets(t *testing.T) {
	t.Parallel()

	dispatcher := &fakeDispatcher{connected: map[types.NamespacedName]bool{}}
	r := &ReleaseReconciler{SatelliteTasks: dispatcher}

	handled, err := r.applyViaSatelliteLink(context.Background(), &paprikav1.ClusterRef{}, "checkout", "api", nil)
	if err != nil || handled {
		t.Fatalf("handled = %v, err = %v; an unnamed target has no registration to address", handled, err)
	}
}

func TestApplyViaSatelliteLinkWithoutADispatcher(t *testing.T) {
	t.Parallel()

	r := &ReleaseReconciler{}
	handled, err := r.applyViaSatelliteLink(context.Background(),
		&paprikav1.ClusterRef{Name: "edge", Namespace: "paprika-system"}, "checkout", "api", nil)
	if err != nil || handled {
		t.Fatalf("handled = %v, err = %v; split mode leaves the dispatcher nil", handled, err)
	}
}
