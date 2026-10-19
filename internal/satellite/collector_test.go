package satellite

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func nextReport(t *testing.T, reports <-chan Report, match func(Report) bool) Report {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case report := <-reports:
			if match(report) {
				return report
			}
		case <-deadline.C:
			t.Fatal("timed out waiting for satellite report")
			return Report{}
		}
	}
}

func TestCollectorSnapshotsWatchDeltasDeletesAndHeartbeat(t *testing.T) {
	reports := make(chan Report, 30)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		reports <- decodeTestReport(t, request)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	core := kubernetesfake.NewClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: "stable-cluster-uid"}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "prod", UID: "prod"}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node", UID: "node"}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
		healthyDeployment("prod", "web", "shop"),
	)
	collector, err := NewCollector(core, nil, Config{ControlPlaneURL: server.URL, ClusterName: "remote", ClusterNamespace: "paprika", TokenFile: testTokenFile(t, "token"), BatchInterval: 100 * time.Millisecond, HeartbeatInterval: 300 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- collector.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if runErr := <-finished; runErr != nil {
			t.Error(runErr)
		}
	})
	initial := nextReport(t, reports, func(report Report) bool { return report.Snapshot })
	assertInitialSnapshot(t, &initial)
	if !collector.Ready() {
		t.Fatal("collector not ready after initial snapshot")
	}
	workload, err := core.AppsV1().Deployments("prod").Get(ctx, "web", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	workload.Status.AvailableReplicas = 0
	if _, err := core.AppsV1().Deployments("prod").Update(ctx, workload, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	delta := nextReport(t, reports, func(report Report) bool {
		return !report.Snapshot && len(report.Applications) == 1 && report.Applications[0].Health == "Degraded"
	})
	if delta.SessionID != initial.SessionID || delta.Sequence <= initial.Sequence {
		t.Fatalf("ordered delta = %#v", delta)
	}
	if err := core.AppsV1().Deployments("prod").Delete(ctx, "web", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	deleted := nextReport(t, reports, func(report Report) bool { return len(report.DeletedApplications) == 1 })
	if deleted.DeletedApplications[0] != "prod/shop" {
		t.Fatalf("deleted = %#v", deleted)
	}
	heartbeat := nextReport(t, reports, func(report Report) bool {
		return report.Sequence > deleted.Sequence && len(report.Applications) == 0 && len(report.DeletedApplications) == 0
	})
	if heartbeat.Snapshot || heartbeat.Inventory.NodeCount != 1 {
		t.Fatalf("heartbeat = %#v", heartbeat)
	}
}

func assertInitialSnapshot(t *testing.T, initial *Report) {
	t.Helper()
	if initial.Sequence != 1 || initial.ClusterUID != "stable-cluster-uid" || len(initial.Applications) != 1 || initial.Inventory.NodeCount != 1 || initial.Inventory.NamespaceCount != 2 {
		t.Fatalf("initial snapshot = %#v", initial)
	}
}

func TestCollectorReceiverResyncStartsNewFullSession(t *testing.T) {
	reports := make(chan Report, 20)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		report := decodeTestReport(t, request)
		reports <- report
		if calls.Add(1) == 2 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	core := kubernetesfake.NewClientset(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: "cluster-uid"}}, healthyDeployment("prod", "web", "shop"))
	collector, err := NewCollector(core, nil, Config{ControlPlaneURL: server.URL, ClusterName: "remote", ClusterNamespace: "paprika", TokenFile: testTokenFile(t, "token"), BatchInterval: 100 * time.Millisecond, HeartbeatInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- collector.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if runErr := <-finished; runErr != nil {
			t.Error(runErr)
		}
	})
	initial := nextReport(t, reports, func(report Report) bool { return report.Snapshot })
	resync := nextReport(t, reports, func(report Report) bool { return report.Snapshot && report.SessionID != initial.SessionID })
	if resync.Sequence != 1 || len(resync.Applications) != 1 || resync.ClusterUID != initial.ClusterUID {
		t.Fatalf("resync = %#v", resync)
	}
	if !collector.Ready() {
		t.Fatal("central resync changed local readiness")
	}
}

func TestCollectorRetriesSameReportThenCoalescesOfflineChanges(t *testing.T) {
	reports := make(chan Report, 20)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		reports <- decodeTestReport(t, request)
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	collector, err := NewCollector(kubernetesfake.NewClientset(), nil, Config{ControlPlaneURL: server.URL, ClusterName: "remote", ClusterNamespace: "paprika", TokenFile: testTokenFile(t, "token"), BatchInterval: 100 * time.Millisecond, HeartbeatInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	collector.clusterUID = "stable-cluster"
	workload := healthyDeployment("prod", "web", "shop")
	collector.state.upsert(workload)
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- collector.publish(ctx) }()
	t.Cleanup(func() {
		cancel()
		if runErr := <-finished; runErr != nil {
			t.Error(runErr)
		}
		collector.client.Close()
	})
	initial := nextReport(t, reports, func(report Report) bool { return report.Snapshot })
	// Several offline watch changes occupy one compact slot and are delivered
	// after the in-flight report is acknowledged, without dropping its retry.
	workload.Status.AvailableReplicas = 0
	collector.state.upsert(workload)
	workload.Status.AvailableReplicas = 1
	collector.state.upsert(workload)
	workload.Status.AvailableReplicas = 0
	collector.state.upsert(workload)
	retried := nextReport(t, reports, func(report Report) bool { return report.Sequence == 1 })
	if !reflect.DeepEqual(retried, initial) {
		t.Fatalf("ambiguous delivery changed retry: %#v vs %#v", retried, initial)
	}
	delta := nextReport(t, reports, func(report Report) bool { return report.Sequence == 2 && len(report.Applications) == 1 })
	if delta.Snapshot || delta.SessionID != initial.SessionID || delta.Applications[0].Health != "Degraded" {
		t.Fatalf("offline changes were not coalesced: %#v", delta)
	}
}

func TestOptionalApplicationCRDIsDiscoveredAfterStartup(t *testing.T) {
	core := kubernetesfake.NewClientset()
	application := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "pipelines.paprika.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": "shop", "namespace": "prod", "uid": "app"},
		"status":   map[string]any{"health": "Healthy", "phase": "Healthy"},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{applicationResource: "ApplicationList"}, application)
	appWatch := watch.NewRaceFreeFake()
	defer appWatch.Stop()
	watchStarted := make(chan struct{}, 1)
	dyn.PrependWatchReactor("applications", func(k8stesting.Action) (bool, watch.Interface, error) {
		select {
		case watchStarted <- struct{}{}:
		default:
		}
		return true, appWatch, nil
	})
	var available atomic.Bool
	dyn.PrependReactor("list", "applications", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if !available.Load() {
			return true, nil, apierrors.NewNotFound(applicationResource.GroupResource(), "")
		}
		return false, nil, nil
	})
	collector, err := NewCollector(core, dyn, Config{ControlPlaneURL: "https://central.example.com", ClusterName: "remote", ClusterNamespace: "paprika", TokenFile: testTokenFile(t, "token")})
	if err != nil {
		t.Fatal(err)
	}
	defer collector.client.Close()
	collector.applicationProbeInterval = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	ready, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); collector.runOptionalApplications(ctx, ready) }()
	t.Cleanup(func() { cancel(); <-finished })
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("missing CRD blocked optional readiness")
	}
	_, apps := collector.state.snapshot()
	if len(apps) != 0 {
		t.Fatalf("missing CRD yielded applications: %#v", apps)
	}
	available.Store(true)
	deadline := time.Now().Add(3 * time.Second)
	observed := false
	for time.Now().Before(deadline) {
		_, apps = collector.state.snapshot()
		if apps["prod/shop"].Health == "Healthy" {
			observed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observed {
		t.Fatal("application CRD installed after startup was not discovered")
	}
	select {
	case <-watchStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("optional Application watch did not start")
	}
	available.Store(false)
	appWatch.Error(&metav1.Status{Status: metav1.StatusFailure, Reason: metav1.StatusReasonForbidden, Code: http.StatusForbidden})
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, apps = collector.state.snapshot()
		if len(apps) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("optional Application watch failure retained stale CR health")
}

func TestCoreClientInterceptsErrorsReflectorWouldRetry(t *testing.T) {
	core := kubernetesfake.NewClientset()
	failures := make(chan error, 2)
	observed := &observedKubernetes{Interface: core, fail: func(err error) { failures <- err }}
	core.PrependWatchReactor("nodes", func(k8stesting.Action) (bool, watch.Interface, error) { return true, nil, syscall.ECONNREFUSED })
	if _, err := observed.CoreV1().Nodes().Watch(context.Background(), metav1.ListOptions{}); err == nil {
		t.Fatal("expected connection failure")
	}
	select {
	case <-failures:
	default:
		t.Fatal("connection refusal was left to Reflector's unbounded retry")
	}
	core.PrependReactor("list", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "nodes"}, "", nil)
	})
	if _, err := observed.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{}); err == nil {
		t.Fatal("expected revoked list permission")
	}
	select {
	case <-failures:
	default:
		t.Fatal("revoked list permission was not intercepted")
	}
}

func TestCoreWatchFailureStopsReportsAndClearsReadiness(t *testing.T) {
	reports := make(chan Report, 20)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		reports <- decodeTestReport(t, request)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	core := kubernetesfake.NewClientset(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: "cluster-uid"}})
	nodesWatch := watch.NewRaceFreeFake()
	defer nodesWatch.Stop()
	core.PrependWatchReactor("nodes", func(k8stesting.Action) (bool, watch.Interface, error) { return true, nodesWatch, nil })
	collector, err := NewCollector(core, nil, Config{ControlPlaneURL: server.URL, ClusterName: "remote", ClusterNamespace: "paprika", TokenFile: testTokenFile(t, "token"), BatchInterval: 100 * time.Millisecond, HeartbeatInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- collector.Run(ctx) }()
	stopped := false
	t.Cleanup(func() {
		cancel()
		if !stopped {
			<-finished
		}
	})
	nextReport(t, reports, func(report Report) bool { return report.Snapshot })
	if !collector.Ready() {
		t.Fatal("collector was not initially ready")
	}
	nodesWatch.Error(&metav1.Status{Status: metav1.StatusFailure, Reason: metav1.StatusReasonForbidden, Code: http.StatusForbidden, Message: "sensitive remote details"})
	select {
	case err := <-finished:
		stopped = true
		if err == nil || err.Error() != "satellite local Kubernetes watch failed; a fresh snapshot is required" {
			t.Fatalf("watch failure = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("core watch failure did not stop collector")
	}
	if collector.Ready() {
		t.Fatal("stale core cache remained ready")
	}
	count := calls.Load()
	time.Sleep(300 * time.Millisecond)
	if calls.Load() != count {
		t.Fatal("collector continued heartbeats from a stale core cache")
	}
}

func TestNormalCoreWatchExpirationDoesNotFailCollector(t *testing.T) {
	collector := &Collector{coreWatchErrors: make(chan error, 1)}
	collector.ready.Store(true)
	collector.coreWatchError(nil, io.EOF)
	collector.coreWatchError(nil, apierrors.NewResourceExpired("watch revision expired"))
	select {
	case err := <-collector.coreWatchErrors:
		t.Fatalf("normal watch expiration failed collector: %v", err)
	default:
	}
	if !collector.Ready() {
		t.Fatal("normal watch expiration changed readiness")
	}
}

func TestWorkloadInvalidIdentityLabelsAreIgnored(t *testing.T) {
	workload := healthyDeployment("prod", "web", "Invalid_App")
	workload.Labels["app.paprika.io/identity"] = "Invalid_ID"
	workload.Labels["app.paprika.io/project"] = "Invalid_Project"
	projected, ok := projectObject(workload)
	if !ok || projected.app.Name != "web" || projected.app.Identity != "" || projected.app.Project != "" {
		t.Fatalf("invalid labels blocked safe fallback: %#v", projected)
	}
	workload.Labels["app.paprika.io/name"] = "store"
	workload.Labels["app.kubernetes.io/name"] = "web-ui"
	projected, _ = projectObject(workload)
	if projected.app.Name != "store" {
		t.Fatalf("Paprika label priority lost: %#v", projected)
	}
}

func TestStatefulAndDaemonWorkloadsAreProjected(t *testing.T) {
	one := int32(1)
	objects := []any{
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "prod", Generation: 1}, Spec: appsv1.StatefulSetSpec{Replicas: &one}, Status: appsv1.StatefulSetStatus{ObservedGeneration: 1, CurrentReplicas: 1, UpdatedReplicas: 1, ReadyReplicas: 1}},
		&appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{Name: "logger", Namespace: "prod", Generation: 1}, Status: appsv1.DaemonSetStatus{ObservedGeneration: 1, DesiredNumberScheduled: 2, UpdatedNumberScheduled: 2, NumberAvailable: 2}},
	}
	for _, object := range objects {
		compact, err := compactObject(object)
		if err != nil {
			t.Fatal(err)
		}
		projection, ok := projectObject(compact)
		if !ok || projection.app.Health != "Healthy" {
			t.Fatalf("workload projection = %#v", projection)
		}
	}
}

// TestOperatingStateOnlyClaimsWhatItCanObserve pins the report's connectivity
// field to the satellite's own evidence.
//
// Autonomous and OverrideHeld describe local reconciliation this build does not
// run. Reporting one because the control plane looks unreachable would tell an
// operator to stand down while nothing is enforcing the application, so the
// satellite reports Connecting until the control plane acknowledges a report.
func TestOperatingStateOnlyClaimsWhatItCanObserve(t *testing.T) {
	t.Parallel()

	collector := &Collector{}
	if got := collector.operatingState(); got != clusters.SatelliteOperatingConnecting {
		t.Fatalf("before the first acknowledgement: state = %q, want Connecting", got)
	}
	collector.delivered.Store(true)
	if got := collector.operatingState(); got != clusters.SatelliteOperatingConnected {
		t.Fatalf("after an acknowledgement: state = %q, want Connected", got)
	}
}
