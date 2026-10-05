package arcobserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
)

func testSource() Source {
	return Source{PoolName: "ci-pool", RunnerNamespace: "runners", SystemNamespace: "systems", ControllerDeployment: "controller", ExpectedMaxRunners: 1}
}
func object(kind, namespace, name, uid string) *unstructured.Unstructured {
	o := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "actions.github.com/v1alpha1", "kind": kind, "metadata": map[string]any{"name": name, "namespace": namespace, "uid": uid}}}
	o.SetLabels(map[string]string{scaleSetLabel: "ci-pool"})
	return o
}
func set(o *unstructured.Unstructured, v any, fields ...string) {
	_ = unstructured.SetNestedField(o.Object, v, fields...)
}
func fixture(now time.Time) Snapshot {
	s := testSource()
	rs := object("AutoscalingRunnerSet", s.RunnerNamespace, s.PoolName, "set-id")
	set(rs, int64(1), "spec", "maxRunners")
	d := object("Deployment", s.SystemNamespace, s.ControllerDeployment, "controller-id")
	d.SetAPIVersion("apps/v1")
	d.SetGeneration(1)
	for _, k := range []string{"observedGeneration", "readyReplicas", "availableReplicas"} {
		set(d, int64(1), "status", k)
	}
	p := object("Pod", s.SystemNamespace, "listener", "listener-id")
	p.SetAPIVersion("v1")
	listenerController := true
	p.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "actions.github.com/v1alpha1", Kind: "AutoscalingListener", UID: "listener-owner", Controller: &listenerController}})
	l := p.GetLabels()
	l["app.kubernetes.io/component"] = "runner-scale-set-listener"
	l["actions.github.com/scale-set-namespace"] = s.RunnerNamespace
	p.SetLabels(l)
	set(p, "Running", "status", "phase")
	set(p, []any{map[string]any{"type": "Ready", "status": "True"}}, "status", "conditions")
	return Snapshot{Complete: true, ObservedAt: now, RunnerSet: rs, Controller: d, SystemPods: []unstructured.Unstructured{*p}, RunnerPods: []unstructured.Unstructured{}, EphemeralRunners: []unstructured.Unstructured{}}
}
func addWorker(snap *Snapshot, phase, podPhase string) {
	r := object("EphemeralRunner", "runners", "worker", "runner-id")
	set(r, phase, "status", "phase")
	set(r, true, "status", "ready")
	set(r, "private-job-canary", "status", "jobWorkflowRef")
	set(r, "private-secret-canary", "spec", "githubToken")
	p := object("Pod", "runners", "worker-pod", "pod-id")
	p.SetAPIVersion("v1")
	set(p, podPhase, "status", "phase")
	set(p, "node-a", "spec", "nodeName")
	control := true
	p.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "actions.github.com/v1alpha1", Kind: "EphemeralRunner", UID: types.UID("runner-id"), Controller: &control}})
	snap.EphemeralRunners = append(snap.EphemeralRunners, *r)
	snap.RunnerPods = append(snap.RunnerPods, *p)
}

func TestProjection_TruthAndRedaction(t *testing.T) {
	for _, tc := range []struct {
		name          string
		change        func(*Snapshot)
		state         string
		workers, busy int
		missing       bool
	}{
		{"scale-zero", func(*Snapshot) {}, "healthy", 0, 0, false},
		{"busy", func(s *Snapshot) { addWorker(s, "Running", "Running") }, "healthy", 1, 1, false},
		{"registered-idle", func(s *Snapshot) { addWorker(s, "Pending", "Running") }, "healthy", 1, 0, false},
		{"provisioning", func(s *Snapshot) { addWorker(s, "Pending", "Pending") }, "starting", 1, 0, false},
		{"terminal", func(s *Snapshot) { addWorker(s, "Succeeded", "Succeeded") }, "healthy", 0, 0, false},
		{"lagging-terminal", func(s *Snapshot) { addWorker(s, "Succeeded", "Running") }, "healthy", 1, 0, false},
		{"terminating", func(s *Snapshot) {
			addWorker(s, "Running", "Running")
			ts := metav1.NewTime(time.Now())
			s.RunnerPods[0].SetDeletionTimestamp(&ts)
		}, "healthy", 1, 1, false},
		{"orphan", func(s *Snapshot) { addWorker(s, "Pending", "Running"); s.RunnerPods[0].SetOwnerReferences(nil) }, "inaccessible", 2, 0, false},
		{"duplicate-pod", func(s *Snapshot) {
			addWorker(s, "Running", "Running")
			p := s.RunnerPods[0].DeepCopy()
			p.SetUID("second-pod")
			s.RunnerPods = append(s.RunnerPods, *p)
		}, "inaccessible", 2, 1, false},
		{"unknown-phase", func(s *Snapshot) { addWorker(s, "Unknown", "Running") }, "inaccessible", 1, 0, false},
		{"listener-not-ready", func(s *Snapshot) { set(&s.SystemPods[0], "Pending", "status", "phase") }, "starting", 0, 0, false},
		{"listener-not-owned", func(s *Snapshot) { s.SystemPods[0].SetOwnerReferences(nil) }, "starting", 0, 0, false},
		{"controller-old-generation", func(s *Snapshot) { s.Controller.SetGeneration(2) }, "starting", 0, 0, false},
		{"capacity-drift", func(s *Snapshot) { set(s.RunnerSet, int64(2), "spec", "maxRunners") }, "", 0, 0, true},
		{"missing-max", func(s *Snapshot) { unstructured.RemoveNestedField(s.RunnerSet.Object, "spec", "maxRunners") }, "", 0, 0, true},
		{"partial", func(s *Snapshot) { s.Complete = false }, "", 0, 0, true},
		{"missing-list", func(s *Snapshot) { s.RunnerPods = nil }, "", 0, 0, true},
		{"stale", func(s *Snapshot) { s.ObservedAt = s.ObservedAt.Add(-9 * time.Second) }, "", 0, 0, true},
		{"future", func(s *Snapshot) { s.ObservedAt = s.ObservedAt.Add(time.Second) }, "", 0, 0, true},
		{"wrong-namespace", func(s *Snapshot) { s.RunnerSet.SetNamespace("other") }, "", 0, 0, true},
		{"duplicate-runner", func(s *Snapshot) {
			addWorker(s, "Running", "Running")
			s.EphemeralRunners = append(s.EphemeralRunners, s.EphemeralRunners[0])
		}, "", 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			snap := fixture(now)
			tc.change(&snap)
			o, err := Project(testSource(), snap, now)
			if tc.missing {
				if !errors.Is(err, ErrIncomplete) {
					t.Fatal("incomplete inventory published")
				}
				return
			}
			if err != nil || o.State != tc.state || o.Workers != tc.workers || o.Busy != tc.busy {
				t.Fatalf("wrong projection %+v err=%v", o, err)
			}
			raw, _ := json.Marshal(o)
			if strings.Contains(string(raw), "canary") {
				t.Fatal("raw ARC metadata leaked")
			}
			var fields map[string]any
			_ = json.Unmarshal(raw, &fields)
			if len(fields) > 7 {
				t.Fatal("unexpected outbound fields")
			}
		})
	}
}

func TestConfig_DisabledAndBounded(t *testing.T) {
	if cfg, err := ParseConfig(""); err != nil || len(cfg.Sources) != 0 {
		t.Fatal("observer not disabled by default")
	}
	cfg := Config{Endpoint: "https://control.example", ProjectID: "project-a", Sources: []Source{testSource()}}
	for _, mutate := range []func(*Config){func(c *Config) { c.Endpoint = "http://control.example" }, func(c *Config) { c.Endpoint = "https://user:password@control.example" }, func(c *Config) { c.ProjectID = "*" }, func(c *Config) { c.Sources[0].PoolName = "../other" }, func(c *Config) { c.Sources[0].ExpectedMaxRunners = 0 }, func(c *Config) { c.Sources = append(c.Sources, c.Sources[0]) }} {
		copy := cfg
		copy.Sources = append([]Source(nil), cfg.Sources...)
		mutate(&copy)
		raw, _ := json.Marshal(copy)
		if _, err := ParseConfig(string(raw)); err == nil {
			t.Fatal("unsafe configuration accepted")
		}
	}
	raw, _ := json.Marshal(cfg)
	if _, err := ParseConfig(string(raw)); err != nil {
		t.Fatal(err)
	}
}

func TestCollector_CompletePaginationAndReadOnly(t *testing.T) {
	snap := fixture(time.Now())
	objects := []runtime.Object{snap.RunnerSet, snap.Controller, &snap.SystemPods[0]}
	kinds := map[schema.GroupVersionResource]string{runnerSetGVR: "AutoscalingRunnerSetList", runnerGVR: "EphemeralRunnerList", podGVR: "PodList", deploymentGVR: "DeploymentList"}
	client := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), kinds, objects...)
	pages := 0
	failSecond := false
	client.PrependReactor("list", "ephemeralrunners", func(a ktesting.Action) (bool, runtime.Object, error) {
		if a.GetNamespace() != "runners" {
			t.Fatal("cluster-wide list")
		}
		pages++
		l := &unstructured.UnstructuredList{}
		l.SetResourceVersion("same-snapshot")
		opts := a.(ktesting.ListActionImpl).GetListOptions()
		if opts.Continue == "" {
			l.SetContinue("next-page")
		} else if failSecond {
			return true, nil, errors.New("private-credential-canary")
		}
		return true, l, nil
	})
	c := KubernetesCollector{Client: client}
	got, err := c.Collect(context.Background(), testSource())
	if err != nil || !got.Complete || pages != 2 {
		t.Fatalf("pagination failed pages=%d err=%v", pages, err)
	}
	for _, a := range client.Actions() {
		if a.GetVerb() != "get" && a.GetVerb() != "list" {
			t.Fatalf("unexpected write %s", a.GetVerb())
		}
		if a.GetNamespace() == "" {
			t.Fatal("unbounded read")
		}
	}
	failSecond = true
	got, err = c.Collect(context.Background(), testSource())
	if !errors.Is(err, ErrIncomplete) || got.Complete || strings.Contains(err.Error(), "canary") {
		t.Fatal("partial read or raw error escaped")
	}
}

type fakeCollector struct {
	err  error
	snap Snapshot
}

func (f fakeCollector) Collect(context.Context, Source) (Snapshot, error) { return f.snap, f.err }

type fakePublisher struct {
	calls int
	err   error
	seen  Observation
}

func (f *fakePublisher) Publish(_ context.Context, _ Source, o Observation) error {
	f.calls++
	f.seen = o
	return f.err
}

func TestRunner_MissingDoesNotRenewAndDenialStopsRound(t *testing.T) {
	s := testSource()
	second := s
	second.PoolName = "other-pool"
	p := &fakePublisher{}
	r := Runner{Config: Config{Sources: []Source{s}}, Collector: fakeCollector{err: ErrIncomplete}, Publisher: p, Log: logr.Discard()}
	if err := r.ObserveOnce(context.Background()); err != nil || p.calls != 0 {
		t.Fatal("missing data renewed")
	}
	r.Collector = fakeCollector{err: ErrDenied}
	if err := r.ObserveOnce(context.Background()); !errors.Is(err, ErrDenied) || p.calls != 0 {
		t.Fatal("read authorization denial did not stop the observer")
	}
	snap := fixture(time.Now().UTC())
	r.Collector = fakeCollector{snap: snap}
	if err := r.ObserveOnce(context.Background()); err != nil || p.calls != 1 || !p.seen.ObservedAt.Equal(snap.ObservedAt) {
		t.Fatal("observation timestamp renewed")
	}
	r.Config.Sources = append(r.Config.Sources, second)
	p.calls = 0
	p.err = ErrDenied
	if err := r.ObserveOnce(context.Background()); !errors.Is(err, ErrDenied) || p.calls != 1 {
		t.Fatal("denial did not halt publication")
	}
	if !r.NeedLeaderElection() {
		t.Fatal("observer runs on all replicas")
	}
}

func TestPublisher_BindingRedactionAndNoRedirect(t *testing.T) {
	s := testSource()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("cf_sa_fixture-observation-credential-canary"), 0600); err != nil {
		t.Fatal(err)
	}
	hits := 0
	status := 204
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Method != "POST" || r.URL.Path != "/api/fleet/pools/ci-pool/observations" || r.Header.Get("x-cuttle-project") != "project-a" {
			t.Fatal("incorrect observation authority")
		}
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "credential-canary") {
			t.Fatal("token leaked in payload")
		}
		if status == 302 {
			w.Header().Set("Location", "https://different.example/private")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte("upstream-credential-canary"))
	}))
	defer server.Close()
	cfg := Config{Endpoint: server.URL, ProjectID: "project-a", Sources: []Source{s}}
	p, err := NewHTTPPublisher(cfg, tokenFile, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	o := Observation{ObservedAt: time.Now(), State: "healthy"}
	if err := p.Publish(context.Background(), s, o); err != nil {
		t.Fatal(err)
	}
	other := s
	other.PoolName = "other"
	if err := p.Publish(context.Background(), other, o); err == nil || hits != 1 {
		t.Fatal("unbound pool accepted")
	}
	for _, code := range []int{401, 403, 302, 500} {
		status = code
		err := p.Publish(context.Background(), s, o)
		if err == nil || strings.Contains(err.Error(), "canary") {
			t.Fatal("upstream error leaked")
		}
		if (code == 401 || code == 403) && !errors.Is(err, ErrDenied) {
			t.Fatal("denial not distinguished")
		}
	}
	if hits != 5 {
		t.Fatalf("redirect followed or retry occurred: %d", hits)
	}
}
