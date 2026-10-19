package satellitecontrol

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/satellite"
)

const (
	linkTestToken     = "0123456789abcdef0123456789abcdef"
	linkTestNamespace = "paprika-system"
	linkTestCluster   = "edge-eu"
	linkTestSession   = "session-1"
	linkTestUID       = "cluster-uid-1"
)

func linkTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("add core scheme: %v", err)
	}
	if err := clusters.AddToScheme(scheme); err != nil {
		t.Fatalf("add clusters scheme: %v", err)
	}
	return scheme
}

// linkTestClusterObject is a registration that already accepted a report, so the
// stream has a baseline to extend rather than one to create.
func linkTestClusterObject() *clusters.Cluster {
	return &clusters.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: linkTestCluster, Namespace: linkTestNamespace},
		Spec: clusters.ClusterSpec{
			Mode: clusters.ClusterModeAgent,
			Satellite: &clusters.SatelliteSpec{TokenSecretRef: clusters.SecretRef{
				Name: linkTestCluster + "-satellite-token", Key: "token",
			}},
		},
		Status: clusters.ClusterStatus{Satellite: &clusters.SatelliteStatus{
			ClusterUID: linkTestUID, SessionID: "earlier", Sequence: 1, ReportDigest: "earlier",
		}},
	}
}

func linkTestSecret() *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      linkTestCluster + "-satellite-token",
			Namespace: linkTestNamespace,
			Labels:    map[string]string{CredentialLabel: linkTestCluster},
		},
		Data: map[string][]byte{"token": []byte(linkTestToken)},
	}
}

func linkTestReport(session string, sequence uint64, snapshot bool) []byte {
	body, err := json.Marshal(&satellite.Report{
		ProtocolVersion:  satellite.ProtocolVersion,
		ClusterNamespace: linkTestNamespace,
		ClusterName:      linkTestCluster,
		ClusterUID:       linkTestUID,
		SessionID:        session,
		Sequence:         sequence,
		Snapshot:         snapshot,
		ObservedAt:       time.Unix(1_700_000_000, 0),
		Inventory: clusters.ClusterInventory{
			NodeCount: 1, ReadyNodeCount: 1, PodCount: 1, RunningPodCount: 1, NamespaceCount: 1,
		},
		Capacity: clusters.SatelliteCapacity{
			CPUMillicores: clusters.SatelliteResourceUsage{Allocatable: 4000, UsedKnown: false},
		},
	})
	if err != nil {
		panic(err)
	}
	return body
}

// newLinkTestServer mounts the link handler on an HTTP/2 test server, which is
// what a bidirectional Connect stream requires.
func newLinkTestServer(t *testing.T, hub *Hub) *httptest.Server {
	t.Helper()
	k8sClient := fake.NewClientBuilder().
		WithScheme(linkTestScheme(t)).
		WithStatusSubresource(&clusters.Cluster{}).
		WithObjects(linkTestClusterObject(), linkTestSecret()).
		Build()
	handler := NewHandler(k8sClient)
	_, linkHandler := v1connect.NewSatelliteLinkHandler(NewLinkServer(handler, hub))

	mux := http.NewServeMux()
	mux.Handle(LinkPrefix, linkHandler)

	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	// A bidirectional stream never goes idle on its own, so Close alone would
	// wait for it forever. Drop the connections first.
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})
	return server
}

// tokenRoundTripper adds the satellite credential the control plane requires.
// The stream transport does the same thing from a mounted Secret; a raw test
// client sets the header directly.
type tokenRoundTripper struct {
	base  http.RoundTripper
	token string
}

func (t tokenRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(clone)
}

// linkTestStream opens one authenticated stream, so a test can drive frames by
// hand rather than through the satellite client.
func linkTestStream(t *testing.T, server *httptest.Server) *connect.BidiStreamForClient[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame] {
	t.Helper()
	client := v1connect.NewSatelliteLinkClient(
		&http.Client{Transport: tokenRoundTripper{base: server.Client().Transport, token: linkTestToken}},
		server.URL,
	)
	stream := client.Connect(context.Background())
	t.Cleanup(func() {
		_ = stream.CloseRequest()
		_ = stream.CloseResponse()
	})
	return stream
}

// linkTestSender builds the real satellite client against the test server. It
// mounts a token file the way the chart mounts a Secret, so rotation behaviour
// is exercised rather than stubbed.
func linkTestSender(t *testing.T, server *httptest.Server, executor satellite.TaskExecutor) *satellite.LinkSender {
	t.Helper()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(linkTestToken), 0o600); err != nil {
		t.Fatalf("write token file: %v", err)
	}
	sender, err := satellite.NewLinkSender(&satellite.LinkConfig{
		ControlPlaneURL:  server.URL,
		ClusterNamespace: linkTestNamespace,
		ClusterName:      linkTestCluster,
		TokenFile:        tokenFile,
		Executor:         executor,
		HTTPClient:       server.Client(),
	})
	if err != nil {
		t.Fatalf("build link sender: %v", err)
	}
	t.Cleanup(sender.Close)
	return sender
}

func TestLinkAcceptsAReportAndAcknowledgesIt(t *testing.T) {
	t.Parallel()

	server := newLinkTestServer(t, NewHub())
	sender := linkTestSender(t, server, nil)

	if err := sender.SendEncoded(context.Background(), linkTestReport("earlier", 2, false)); err != nil {
		t.Fatalf("SendEncoded: %v", err)
	}
}

func TestLinkAsksForAResyncOnARejectedBaseline(t *testing.T) {
	t.Parallel()

	server := newLinkTestServer(t, NewHub())
	sender := linkTestSender(t, server, nil)

	// The stored baseline is session "earlier" at sequence 1; a different session
	// that is not a snapshot cannot extend it.
	err := sender.SendEncoded(context.Background(), linkTestReport(linkTestSession, 5, false))
	if !errors.Is(err, satellite.ErrResync) {
		t.Fatalf("err = %v, want ErrResync so the collector opens a new session", err)
	}
}

func TestLinkRefusesAnUnknownToken(t *testing.T) {
	t.Parallel()

	server := newLinkTestServer(t, NewHub())
	client := v1connect.NewSatelliteLinkClient(server.Client(), server.URL)
	stream := client.Connect(context.Background())
	hello := linkTestHello()
	if err := stream.Send(hello); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	// The test server has no token transport, so the handshake carries none.
	if _, err := stream.Receive(); err == nil {
		t.Fatal("an unauthenticated hello was accepted")
	} else if code := connect.CodeOf(err); code != connect.CodePermissionDenied && code != connect.CodeUnauthenticated {
		t.Fatalf("err = %v (code %v), want an authentication refusal", err, code)
	}
}

func TestLinkRunsATaskTheControlPlaneDispatches(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	server := newLinkTestServer(t, hub)
	stream := linkTestStream(t, server)
	if err := stream.Send(linkTestHello()); err != nil {
		t.Fatalf("send hello: %v", err)
	}

	key := types.NamespacedName{Namespace: linkTestNamespace, Name: linkTestCluster}
	waitForLink(t, hub, key)

	// The satellite side of the test: read the task, answer it, and let the hub
	// hand the answer to the waiting dispatch.
	go func() {
		frame, err := stream.Receive()
		if err != nil {
			return
		}
		task := frame.GetTask()
		if task == nil {
			return
		}
		if task.GetApply().GetNamespace() != "checkout" {
			t.Errorf("task namespace = %q, want checkout", task.GetApply().GetNamespace())
		}
		if err := stream.Send(&paprikav1.SatelliteFrame{
			Frame: &paprikav1.SatelliteFrame_TaskResult{TaskResult: &paprikav1.SatelliteTaskResult{
				Id: task.GetId(), Ok: true, Applied: 2,
			}},
		}); err != nil {
			return
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := hub.Dispatch(ctx, key, &paprikav1.SatelliteTask{
		Task: &paprikav1.SatelliteTask_Apply{Apply: &paprikav1.SatelliteApplyTask{
			Namespace: "checkout", AppName: "api", Manifests: []byte("kind: ConfigMap\n"),
		}},
	})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !result.GetOk() || result.GetApplied() != 2 {
		t.Fatalf("result = %#v, want ok with 2 applied", result)
	}
}

func TestLinkDetachesOnDisconnect(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	server := newLinkTestServer(t, hub)
	stream := linkTestStream(t, server)
	if err := stream.Send(linkTestHello()); err != nil {
		t.Fatalf("send hello: %v", err)
	}

	key := types.NamespacedName{Namespace: linkTestNamespace, Name: linkTestCluster}
	waitForLink(t, hub, key)

	if err := stream.CloseRequest(); err != nil {
		t.Logf("close request: %v", err)
	}
	_ = stream.CloseResponse()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !hub.Connected(key) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the hub still reports a link after the stream closed")
}

func linkTestHello() *paprikav1.SatelliteFrame {
	return &paprikav1.SatelliteFrame{
		Frame: &paprikav1.SatelliteFrame_Hello{Hello: &paprikav1.SatelliteHello{
			ClusterNamespace: linkTestNamespace,
			ClusterName:      linkTestCluster,
			ClusterUid:       linkTestUID,
			SessionId:        linkTestSession,
			ProtocolVersion:  int32(satellite.ProtocolVersion),
		}},
	}
}

// waitForLink blocks until the server side has attached the stream, which
// happens after the hello is authenticated.
func waitForLink(t *testing.T, hub *Hub, key types.NamespacedName) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if hub.Connected(key) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the satellite link never attached")
}
