package satellitecontrol

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func testDispatchServer(t *testing.T, hub *Hub, token string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(NewInternalHandler(hub, token))
	t.Cleanup(server.Close)
	return server
}

// answerTasks stands in for a satellite: every task that arrives is completed
// with the same id, which is what the real link pumps back.
func answerTasks(link *Link) {
	go func() {
		for task := range link.out {
			link.complete(&paprikav1.SatelliteTaskResult{Id: task.GetId(), Ok: true, Applied: 3})
		}
	}()
}

// TestRemoteDispatcherRoundTrip covers split mode's whole conversation: the
// controller asks which links exist, then sends a task down one.
func TestRemoteDispatcherRoundTrip(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	link := hub.Attach(key)
	t.Cleanup(func() { hub.Detach(key, link) })
	answerTasks(link)

	server := testDispatchServer(t, hub, "0123456789abcdef")
	dispatcher := NewRemoteDispatcher(server.URL, "0123456789abcdef")

	if !dispatcher.Connected(key) {
		t.Fatal("an attached link must read as connected")
	}
	if dispatcher.Connected(types.NamespacedName{Namespace: "paprika-system", Name: "absent"}) {
		t.Fatal("an unattached registration must not read as connected")
	}

	result, err := dispatcher.Dispatch(context.Background(), key, &paprikav1.SatelliteTask{
		Task: &paprikav1.SatelliteTask_Apply{Apply: &paprikav1.SatelliteApplyTask{Namespace: "checkout", AppName: "web"}},
	})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !result.GetOk() || result.GetApplied() != 3 {
		t.Fatalf("result = %+v, want the satellite's answer", result)
	}
}

// TestRemoteDispatcherMapsAnOfflineLink keeps split mode's failure mode the
// same as the in-process hub's: a task for a cluster with no link is the
// sentinel, not a generic transport error.
func TestRemoteDispatcherMapsAnOfflineLink(t *testing.T) {
	t.Parallel()

	server := testDispatchServer(t, NewHub(), "0123456789abcdef")
	dispatcher := NewRemoteDispatcher(server.URL, "0123456789abcdef")

	_, err := dispatcher.Dispatch(context.Background(),
		types.NamespacedName{Namespace: "paprika-system", Name: "edge"},
		&paprikav1.SatelliteTask{Task: &paprikav1.SatelliteTask_Apply{Apply: &paprikav1.SatelliteApplyTask{}}})
	if !errors.Is(err, ErrSatelliteOffline) {
		t.Fatalf("err = %v, want ErrSatelliteOffline", err)
	}
}

// TestInternalDispatchRefusesWithoutTheToken is the security boundary: the
// listener is in-cluster, but any workload in the cluster must not be able to
// push manifests into satellites through it.
func TestInternalDispatchRefusesWithoutTheToken(t *testing.T) {
	t.Parallel()

	server := testDispatchServer(t, NewHub(), "0123456789abcdef")

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+InternalDispatchPrefix+"links", http.NoBody)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}

	wrong := NewRemoteDispatcher(server.URL, "wrong-token")
	if wrong.Connected(types.NamespacedName{Namespace: "paprika-system", Name: "edge"}) {
		t.Fatal("a refused credential must not read as a connected link")
	}
}

// TestInternalDispatchRefusesWhenUnconfigured fails closed: a listener that
// came up without a token serves nothing rather than serving everyone.
func TestInternalDispatchRefusesWhenUnconfigured(t *testing.T) {
	t.Parallel()

	server := testDispatchServer(t, NewHub(), "")
	dispatcher := NewRemoteDispatcher(server.URL, "")

	if dispatcher.Connected(types.NamespacedName{Namespace: "paprika-system", Name: "edge"}) {
		t.Fatal("an unconfigured listener must not answer")
	}
}

// TestRemoteDispatcherCachesLinkSnapshots keeps target resolution off the API
// server's hot path: Connected is asked on every apply, and a round trip per
// call would put a second service in the way of work that rarely needs it.
func TestRemoteDispatcherCachesLinkSnapshots(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	key := types.NamespacedName{Namespace: "paprika-system", Name: "edge"}
	link := hub.Attach(key)
	t.Cleanup(func() { hub.Detach(key, link) })
	answerTasks(link)

	requests := make(chan struct{}, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		NewInternalHandler(hub, "0123456789abcdef").ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)

	dispatcher := NewRemoteDispatcher(server.URL, "0123456789abcdef")
	for i := 0; i < 5; i++ {
		if !dispatcher.Connected(key) {
			t.Fatalf("call %d: link must read as connected", i)
		}
	}
	if got := len(requests); got != 1 {
		t.Fatalf("link snapshot requests = %d, want 1 within the cache window", got)
	}

	// Once the window passes the next call refreshes.
	dispatcher.now = func() time.Time { return time.Now().Add(connectedTTL + time.Second) }
	if !dispatcher.Connected(key) {
		t.Fatal("link must still read as connected after a refresh")
	}
	if got := len(requests); got != 2 {
		t.Fatalf("link snapshot requests = %d, want 2 after the cache expires", got)
	}
}
