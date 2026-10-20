package satellite

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

type fakeExecutor struct {
	applied [][]string
	err     error
}

func (f *fakeExecutor) Apply(_ context.Context, namespace, appName string, _ []byte) (int, []string, error) {
	f.applied = append(f.applied, []string{namespace, appName})
	return 1, nil, f.err
}

type clock struct{ now time.Time }

func (c *clock) Now() time.Time          { return c.now }
func (c *clock) advance(d time.Duration) { c.now = c.now.Add(d) }
func (c *clock) newAutonomy(t *testing.T, cfg AutonomyConfig) *Autonomy {
	t.Helper()
	cfg.Now = c.Now
	a, err := NewAutonomy(&cfg)
	if err != nil {
		t.Fatalf("NewAutonomy: %v", err)
	}
	return a
}

// seededStore returns a store holding one application.
func seededStore(t *testing.T) *ConfigMapBundleStore {
	t.Helper()
	client := fake.NewSimpleClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "bundles", Namespace: "paprika-satellite"},
		Data:       map[string]string{"checkout.web": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web\n"},
	})
	return NewConfigMapBundleStore(client, "paprika-satellite", "bundles")
}

// TestObserveOnlyNeverReconciles is the safety property: a satellite in this
// mode must not mutate its cluster, however long the control plane is away.
func TestObserveOnlyNeverReconciles(t *testing.T) {
	t.Parallel()

	connected := false
	executor := &fakeExecutor{}
	c := &clock{now: time.Unix(1800000000, 0)}
	autonomy := c.newAutonomy(t, AutonomyConfig{
		Mode:      clustersv1alpha1.AutonomyObserveOnly,
		Store:     seededStore(t),
		Executor:  executor,
		Connected: func() bool { return connected },
	})

	c.advance(time.Hour)
	autonomy.Tick(context.Background())
	if len(executor.applied) != 0 {
		t.Fatalf("observe-only applied %v", executor.applied)
	}
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnecting {
		t.Fatalf("state = %q, want Connecting while the control plane is away", got)
	}

	connected = true
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnected {
		t.Fatalf("state = %q, want Connected", got)
	}
}

// TestFailoverWaitsOutTheGraceWindow pins the handover: no local reconcile
// while the control plane may still be restarting, then takeover after the
// timeout.
func TestFailoverWaitsOutTheGraceWindow(t *testing.T) {
	t.Parallel()

	connected := true
	executor := &fakeExecutor{}
	c := &clock{now: time.Unix(1800000000, 0)}
	autonomy := c.newAutonomy(t, AutonomyConfig{
		Mode:            clustersv1alpha1.AutonomyFailover,
		FailoverTimeout: time.Minute,
		Store:           seededStore(t),
		Executor:        executor,
		Connected:       func() bool { return connected },
	})

	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnected {
		t.Fatalf("state = %q, want Connected", got)
	}

	connected = false
	c.advance(30 * time.Second)
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnected {
		t.Fatalf("state = %q, want Connected inside the grace window", got)
	}
	if len(executor.applied) != 0 {
		t.Fatalf("applied inside the grace window: %v", executor.applied)
	}

	c.advance(31 * time.Second)
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingAutonomous {
		t.Fatalf("state = %q, want Autonomous after the timeout", got)
	}
	if len(executor.applied) != 1 {
		t.Fatalf("applied = %v, want the remembered bundle re-applied once", executor.applied)
	}
	if executor.applied[0][0] != "checkout" || executor.applied[0][1] != "web" {
		t.Fatalf("applied %v, want checkout/web", executor.applied[0])
	}
}

// TestFailoverReportsAnOverrideAfterReconnecting keeps local work visible. The
// control plane must learn the cluster changed underneath it before the
// satellite claims to be a quiet follower again.
func TestFailoverReportsAnOverrideAfterReconnecting(t *testing.T) {
	t.Parallel()

	connected := false
	executor := &fakeExecutor{}
	c := &clock{now: time.Unix(1800000000, 0)}
	autonomy := c.newAutonomy(t, AutonomyConfig{
		Mode:            clustersv1alpha1.AutonomyFailover,
		FailoverTimeout: time.Minute,
		Store:           seededStore(t),
		Executor:        executor,
		Connected:       func() bool { return connected },
	})

	autonomy.Tick(context.Background())
	c.advance(2 * time.Minute)
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingAutonomous {
		t.Fatalf("state = %q, want Autonomous", got)
	}

	connected = true
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingOverrideHeld {
		t.Fatalf("state = %q, want OverrideHeld after local work", got)
	}

	c.advance(overrideHoldWindow + time.Second)
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnected {
		t.Fatalf("state = %q, want Connected once the hold window passes", got)
	}
}

// TestDelegatedReconcilesWhileConnected covers the mode where the satellite is
// the reconciler all the time and the control plane only observes.
func TestDelegatedReconcilesWhileConnected(t *testing.T) {
	t.Parallel()

	executor := &fakeExecutor{}
	c := &clock{now: time.Unix(1800000000, 0)}
	autonomy := c.newAutonomy(t, AutonomyConfig{
		Mode:      clustersv1alpha1.AutonomyDelegated,
		Store:     seededStore(t),
		Executor:  executor,
		Connected: func() bool { return true },
	})

	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnected {
		t.Fatalf("state = %q, want Connected", got)
	}
	if len(executor.applied) != 1 {
		t.Fatalf("applied = %v, want one reconcile while connected", executor.applied)
	}

	// Acting is the arrangement, not an override: nothing to hold on reconnect.
	c.advance(DefaultAutonomyInterval)
	autonomy.Tick(context.Background())
	if got := autonomy.State(); got != clustersv1alpha1.SatelliteOperatingConnected {
		t.Fatalf("state = %q, want Connected, not OverrideHeld", got)
	}
}

// TestRecordingExecutorRemembersSuccessfulApplies keeps the store to what was
// actually applied: a failed apply must not become the state the satellite
// enforces on itself.
func TestRecordingExecutorRemembersSuccessfulApplies(t *testing.T) {
	t.Parallel()

	store := NewConfigMapBundleStore(fake.NewSimpleClientset(), "paprika-satellite", "bundles")
	recorder := &RecordingExecutor{Inner: &fakeExecutor{}, Store: store}

	if _, _, err := recorder.Apply(context.Background(), "checkout", "web", []byte("bundle-one")); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	bundles, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(bundles) != 1 || bundles[0].Application != "web" {
		t.Fatalf("bundles = %+v, want the applied one", bundles)
	}

	failing := &RecordingExecutor{Inner: &fakeExecutor{err: errTestApply{}}, Store: store}
	if _, _, err := failing.Apply(context.Background(), "checkout", "api", []byte("bundle-two")); err == nil {
		t.Fatal("a failing apply must return its error")
	}
	bundles, listErr := store.List(context.Background())
	if listErr != nil {
		t.Fatalf("List: %v", listErr)
	}
	if len(bundles) != 1 {
		t.Fatalf("bundles = %+v, a failed apply must not be remembered", bundles)
	}
}

// TestConfigMapBundleStoreRoundTrip covers restart durability: the store is
// what a satellite re-reads after a reboot during an outage.
func TestConfigMapBundleStoreRoundTrip(t *testing.T) {
	t.Parallel()

	client := fake.NewSimpleClientset()
	store := NewConfigMapBundleStore(client, "paprika-satellite", "bundles")

	for _, app := range []string{"web", "api"} {
		if err := store.Put(context.Background(), &Bundle{
			Namespace: "checkout", Application: app, Manifests: []byte("kind: ConfigMap"),
		}); err != nil {
			t.Fatalf("Put %s: %v", app, err)
		}
	}

	bundles, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(bundles) != 2 {
		t.Fatalf("bundles = %+v, want both applications", bundles)
	}
	seen := map[string]bool{}
	for _, bundle := range bundles {
		seen[bundle.Namespace+"/"+bundle.Application] = true
	}
	if !seen["checkout/web"] || !seen["checkout/api"] {
		t.Fatalf("bundles = %+v, want checkout/web and checkout/api", bundles)
	}

	// A second store instance reads what the first wrote, which is what a
	// restarted satellite does.
	restarted := NewConfigMapBundleStore(client, "paprika-satellite", "bundles")
	if bundles, err := restarted.List(context.Background()); err != nil || len(bundles) != 2 {
		t.Fatalf("after restart: bundles = %+v, err = %v", bundles, err)
	}
}

type errTestApply struct{}

func (errTestApply) Error() string { return "apply failed" }
