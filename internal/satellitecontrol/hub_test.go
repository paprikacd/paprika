package satellitecontrol

import (
	"context"
	"errors"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func TestHubDispatchCorrelatesByTaskID(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	link := hub.Attach(key)
	defer hub.Detach(key, link)

	go func() {
		task := <-link.out
		link.complete(&paprikav1.SatelliteTaskResult{Id: task.GetId(), Ok: true, Applied: 3})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := hub.Dispatch(ctx, key, &paprikav1.SatelliteTask{
		Task: &paprikav1.SatelliteTask_Apply{Apply: &paprikav1.SatelliteApplyTask{
			Namespace: "checkout", AppName: "api", Manifests: []byte("kind: ConfigMap\n"),
		}},
	})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !result.GetOk() || result.GetApplied() != 3 {
		t.Fatalf("result = %#v, want ok with 3 applied", result)
	}
	if result.GetId() == "" {
		t.Error("the hub must assign the task id it correlates on")
	}
}

func TestHubDispatchWithoutALink(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	_, err := hub.Dispatch(context.Background(), types.NamespacedName{Namespace: "paprika-system", Name: "edge"},
		&paprikav1.SatelliteTask{})
	if !errors.Is(err, ErrSatelliteOffline) {
		t.Fatalf("err = %v, want ErrSatelliteOffline", err)
	}
}

func TestHubReplacementClosesThePreviousLink(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	first := hub.Attach(key)
	second := hub.Attach(key)

	// A restart attaches a new stream; a dispatch must go to the live one, and a
	// stale detach must not remove it.
	hub.Detach(key, first)

	if !hub.Connected(key) {
		t.Fatal("a stale detach removed the live link")
	}
	go func() {
		task := <-second.out
		second.complete(&paprikav1.SatelliteTaskResult{Id: task.GetId(), Ok: true})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := hub.Dispatch(ctx, key, &paprikav1.SatelliteTask{}); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
}

func TestHubDispatchAfterDetachIsOffline(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	link := hub.Attach(key)
	hub.Detach(key, link)

	_, err := hub.Dispatch(context.Background(), key, &paprikav1.SatelliteTask{})
	if !errors.Is(err, ErrSatelliteOffline) {
		t.Fatalf("err = %v, want ErrSatelliteOffline", err)
	}
}

func TestHubDispatchHonoursContextDeadline(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	link := hub.Attach(key)
	defer hub.Detach(key, link)

	// Nobody answers: the caller's deadline is the only thing that can end the
	// wait, and a satellite that vanished must not pin it forever.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	go func() {
		<-link.out
	}()

	_, err := hub.Dispatch(ctx, key, &paprikav1.SatelliteTask{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want a deadline error", err)
	}
}

func TestSatelliteLinkDropsResultsNobodyWaitsFor(t *testing.T) {
	t.Parallel()

	link := newSatelliteLink()
	// A duplicate or late result has no listener; completing must not block or
	// panic.
	link.complete(&paprikav1.SatelliteTaskResult{Id: "unknown"})
}
