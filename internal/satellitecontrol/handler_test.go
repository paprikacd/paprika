package satellitecontrol

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/obsstore"
	"github.com/benebsworth/paprika/internal/satellite"
)

const testToken = "01234567890123456789012345678901token"

func testRegistry(t *testing.T) (client.Client, *Handler) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := clusters.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: "paprika-system", Name: "east-satellite-token", Labels: map[string]string{CredentialLabel: "east"}}, Data: map[string][]byte{"token": []byte(testToken)}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusters.Cluster{}).WithObjects(secret).Build()
	return c, NewHandler(c)
}
func baseline() satellite.Report {
	return satellite.Report{ProtocolVersion: 1, ClusterNamespace: "paprika-system", ClusterName: "east", ClusterUID: "physical-east", SessionID: "session1", Sequence: 1, Snapshot: true, ObservedAt: time.Now(), KubernetesVersion: "v1.36.2", Inventory: clusters.ClusterInventory{NodeCount: 3, ReadyNodeCount: 3}, Applications: []satellite.Application{{Namespace: "shop", Name: "api", Health: "Healthy", Project: "default", ResourceCount: 2}, {Namespace: "other", Name: "api", Health: "Degraded", Project: "default", ResourceCount: 1}}}
}
func send(t *testing.T, h http.Handler, r satellite.Report, token string) int {
	t.Helper()
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, satellite.ReportPath, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code
}
func loadCluster(t *testing.T, c client.Client) *clusters.Cluster {
	t.Helper()
	var cluster clusters.Cluster
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "paprika-system", Name: "east"}, &cluster); err != nil {
		t.Fatal(err)
	}
	return &cluster
}

func TestSatelliteOnboardingDeltasAndRestart(t *testing.T) {
	c, h := testRegistry(t)
	r := baseline()
	if got := send(t, h, r, testToken); got != 204 {
		t.Fatalf("onboard: %d", got)
	}
	cluster := loadCluster(t, c)
	if cluster.Spec.Mode != clusters.ClusterModeAgent || cluster.Spec.Satellite.TokenSecretRef.Name != "east-satellite-token" || cluster.Status.Satellite.ClusterUID != "physical-east" || len(cluster.Status.Satellite.Applications) != 2 || cluster.Status.Inventory.NodeCount != 3 {
		t.Fatalf("wrong cluster: %+v", cluster)
	}
	if got := send(t, h, r, testToken); got != 204 {
		t.Fatalf("lost ack replay: %d", got)
	}
	if loadCluster(t, c).ResourceVersion != cluster.ResourceVersion {
		t.Fatal("duplicate report performed another write")
	}
	r.Sequence = 2
	r.Snapshot = false
	r.Applications = []satellite.Application{{Namespace: "shop", Name: "api", Health: "Failed", Project: "default", ResourceCount: 3}}
	r.DeletedApplications = []string{"other/api"}
	// A new API replica reads the persisted baseline rather than requiring a
	// new snapshot or losing the delete/update applied by the first replica.
	if got := send(t, NewHandler(c), r, testToken); got != 204 {
		t.Fatalf("delta after API restart: %d", got)
	}
	cluster = loadCluster(t, c)
	if len(cluster.Status.Satellite.Applications) != 1 || cluster.Status.Satellite.Applications[0].Health != "Failed" || cluster.Status.Satellite.Sequence != 2 {
		t.Fatalf("delta lost: %+v", cluster.Status.Satellite)
	}
	r = baseline()
	r.SessionID = "session2"
	r.Applications = nil
	if got := send(t, h, r, testToken); got != 204 {
		t.Fatalf("reconnect snapshot: %d", got)
	}
	if len(loadCluster(t, c).Status.Satellite.Applications) != 0 {
		t.Fatal("snapshot failed to remove stale applications")
	}
	if got := send(t, h, baseline(), testToken); got != 409 {
		t.Fatalf("retired session accepted: %d", got)
	}
}

func TestSatelliteRefusesInvalidIdentityAndSequences(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*satellite.Report)
		want   int
	}{
		{"gap", func(r *satellite.Report) { r.Snapshot = false; r.Sequence = 3 }, 409},
		{"changed replay", func(r *satellite.Report) { r.Inventory.NodeCount = 4 }, 409},
		{"different physical cluster", func(r *satellite.Report) { r.ClusterUID = "physical-west"; r.SessionID = "session2" }, 409},
		{"different registration", func(r *satellite.Report) { r.ClusterName = "west" }, 401},
		{"duplicate app", func(r *satellite.Report) { r.Applications = append(r.Applications, r.Applications[0]) }, 400},
		{"invalid namespace", func(r *satellite.Report) { r.Applications[0].Namespace = "shop/other" }, 400},
		{"invalid snapshot sequence", func(r *satellite.Report) { r.Sequence = 2 }, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, h := testRegistry(t)
			r := baseline()
			if send(t, h, r, testToken) != 204 {
				t.Fatal("setup")
			}
			before := loadCluster(t, c).ResourceVersion
			tc.mutate(&r)
			if got := send(t, h, r, testToken); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
			if loadCluster(t, c).ResourceVersion != before {
				t.Fatal("rejected report changed accepted state")
			}
		})
	}
}

func TestSatelliteCredentialsAndDisabledCluster(t *testing.T) {
	c, h := testRegistry(t)
	r := baseline()
	if got := send(t, h, r, "wrong"); got != 401 {
		t.Fatalf("wrong token: %d", got)
	}
	var clustersList clusters.ClusterList
	if err := c.List(context.Background(), &clustersList); err != nil {
		t.Fatal(err)
	}
	if len(clustersList.Items) != 0 {
		t.Fatal("unauthenticated request onboarded cluster")
	}
	if send(t, h, r, testToken) != 204 {
		t.Fatal("setup")
	}
	cluster := loadCluster(t, c)
	cluster.Spec.Disabled = true
	if err := c.Update(context.Background(), cluster); err != nil {
		t.Fatal(err)
	}
	if got := send(t, h, r, testToken); got != 403 {
		t.Fatalf("disabled cluster: %d", got)
	}
	cluster.Spec.Disabled = false
	if err := c.Update(context.Background(), cluster); err != nil {
		t.Fatal(err)
	}
	var secret corev1.Secret
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "paprika-system", Name: "east-satellite-token"}, &secret); err != nil {
		t.Fatal(err)
	}
	newToken := testToken + "rotated"
	secret.Data["token"] = []byte(newToken)
	if err := c.Update(context.Background(), &secret); err != nil {
		t.Fatal(err)
	}
	if got := send(t, h, r, testToken); got != 401 {
		t.Fatalf("old credential after rotation: %d", got)
	}
	if got := send(t, h, r, newToken); got != 204 {
		t.Fatalf("rotated credential: %d", got)
	}
}

func TestSatelliteBoundsCompressedAndJSONPayloads(t *testing.T) {
	_, h := testRegistry(t)
	for _, payload := range []string{strings.Repeat(" ", satellite.MaxReportBytes+1), `{"unexpected":1}`, `{} {}`} {
		var zipped bytes.Buffer
		gz := gzip.NewWriter(&zipped)
		if _, err := gz.Write([]byte(payload)); err != nil {
			t.Fatal(err)
		}
		if err := gz.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequestWithContext(context.Background(), "POST", satellite.ReportPath, &zipped)
		req.Header.Set("Content-Encoding", "gzip")
		req.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Fatalf("invalid compressed report accepted: %d", w.Code)
		}
	}
	body, _ := json.Marshal(baseline())
	var zipped bytes.Buffer
	gz := gzip.NewWriter(&zipped)
	_, _ = gz.Write(body)
	_ = gz.Close()
	req := httptest.NewRequestWithContext(context.Background(), "POST", satellite.ReportPath, &zipped)
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 204 {
		t.Fatalf("valid gzip rejected: %d (%s)", w.Code, w.Body.String())
	}
}

func TestSatelliteConcurrentReplicasAcknowledgeOneBaseline(t *testing.T) {
	c, h := testRegistry(t)
	r := baseline()
	if send(t, h, r, testToken) != 204 {
		t.Fatal("setup")
	}
	r.Sequence = 2
	r.Snapshot = false
	r.Applications[0].Health = "Degraded"
	var group sync.WaitGroup
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() { defer group.Done(); codes <- send(t, NewHandler(c), r, testToken) }()
	}
	group.Wait()
	close(codes)
	for code := range codes {
		if code != 204 {
			t.Fatalf("concurrent duplicate report: %d", code)
		}
	}
	state := loadCluster(t, c).Status.Satellite
	if state.Sequence != 2 || state.Applications[1].Health != "Degraded" {
		t.Fatalf("replicas lost baseline: %+v", state)
	}
}

func TestSatelliteDirectTransportAndMountedTokenNewline(t *testing.T) {
	c, h := testRegistry(t)
	var secret corev1.Secret
	key := client.ObjectKey{Namespace: "paprika-system", Name: "east-satellite-token"}
	if err := c.Get(context.Background(), key, &secret); err != nil {
		t.Fatal(err)
	}
	secret.Data["token"] = []byte(testToken + "\n")
	if err := c.Update(context.Background(), &secret); err != nil {
		t.Fatal(err)
	}
	r := baseline()
	if got := send(t, h, r, testToken); got != 204 {
		t.Fatalf("mounted token newline: %d", got)
	}
	cluster := loadCluster(t, c)
	cluster.Spec.Mode = clusters.ClusterModeDirect
	cluster.Spec.KubeconfigSecretRef = &clusters.SecretRef{Name: "remote-kubeconfig"}
	if err := c.Update(context.Background(), cluster); err != nil {
		t.Fatal(err)
	}
	r.Sequence = 2
	r.Snapshot = false
	if got := send(t, h, r, testToken); got != 204 {
		t.Fatalf("direct cluster observation rejected: %d", got)
	}
	cluster = loadCluster(t, c)
	if cluster.Spec.Mode != clusters.ClusterModeDirect || cluster.Spec.KubeconfigSecretRef.Name != "remote-kubeconfig" {
		t.Fatal("report changed deployment transport")
	}
}

// TestHandlerMovesTheApplicationListToTheStore covers the read/write cutover:
// with a store configured, status keeps a summary and the store carries the
// merged application list, including the baseline a delta merges onto.
func TestHandlerMovesTheApplicationListToTheStore(t *testing.T) {
	t.Parallel()

	c, h := testRegistry(t)
	store := obsstore.NewMemory()
	h.Store = store
	ctx := context.Background()

	if got := send(t, h, baseline(), testToken); got != 204 {
		t.Fatalf("onboard: %d", got)
	}
	cluster := loadCluster(t, c)
	if len(cluster.Status.Satellite.Applications) != 0 {
		t.Fatalf("status must carry a summary, not %d applications", len(cluster.Status.Satellite.Applications))
	}
	observations, err := store.List(ctx)
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if len(observations) != 1 || len(observations[0].Report.Applications) != 2 {
		t.Fatalf("store must hold the merged list, got %+v", observations)
	}

	delta := baseline()
	delta.Snapshot = false
	delta.Sequence = 2
	delta.Applications = []satellite.Application{{Namespace: "shop", Name: "web", Health: "Healthy", ResourceCount: 1}}
	if got := send(t, h, delta, testToken); got != 204 {
		t.Fatalf("delta: %d", got)
	}
	observations, err = store.List(ctx)
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if len(observations) != 1 || len(observations[0].Report.Applications) != 3 {
		t.Fatalf("the delta must merge onto the stored baseline, got %+v", observations[0].Report.Applications)
	}
	if cluster = loadCluster(t, c); len(cluster.Status.Satellite.Applications) != 0 {
		t.Fatalf("status still carries %d applications", len(cluster.Status.Satellite.Applications))
	}
}
