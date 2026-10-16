package pipelines

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	kubefake "k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/analysis"
)

type analysisClusterManager struct {
	config            *rest.Config
	namespace, secret string
}

func (m *analysisClusterManager) GetRestConfig(_ context.Context, secret, namespace string) (*rest.Config, error) {
	m.secret, m.namespace = secret, namespace
	return m.config, nil
}
func (*analysisClusterManager) GetClient(context.Context, string, string) (dynamic.Interface, error) {
	return nil, errors.New("unexpected dynamic client lookup")
}

func TestPodAnalysisRunsOnRemoteClusterWithoutChangingSharedAnalyzer(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/namespaces/workloads/pods" || r.URL.Query().Get("labelSelector") != "app=api" {
			t.Errorf("wrong remote request: %s", r.URL)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"api"},"status":{"containerStatuses":[{"name":"api","restartCount":9}]}}]}`)
	}))
	defer remote.Close()
	registered := &clusters.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "registrations", Name: "east"}, Spec: clusters.ClusterSpec{Mode: clusters.ClusterModeDirect, KubeconfigSecretRef: &clusters.SecretRef{Name: "east-kubeconfig", Namespace: "credentials"}}}
	r := routingReconciler(t, registered)
	central := kubefake.NewSimpleClientset(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "workloads", Name: "api", Labels: map[string]string{"app": "api"}}})
	shared := analysis.NewCELAnalyzer(central, "workloads", nil, nil)
	r.Analyzer = shared
	manager := &analysisClusterManager{config: &rest.Config{Host: remote.URL}}
	r.ClusterMgr = manager
	stage := &paprikav1.Stage{Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: "east", Namespace: "registrations"}}}
	checks := []paprikav1.AnalysisCheck{{Name: "restarts", Type: "podMetrics", Metric: "restartRate", Threshold: "1", PodSelector: "app=api"}}
	bound, err := r.analyzerForStage(context.Background(), stage, "workloads", checks)
	if err != nil {
		t.Fatal(err)
	}
	results := bound.RunChecks(context.Background(), "workloads", checks)
	if len(results) != 1 || results[0].Passed {
		t.Fatalf("used healthy central pods instead of failing remote pods: %+v", results)
	}
	if len(central.Actions()) != 0 {
		t.Fatal("analysis read central cluster")
	}
	if r.Analyzer != shared || shared.K8sClient != central || shared.RESTConfig != nil {
		t.Fatal("shared analyzer was mutated")
	}
	if manager.namespace != "credentials" || manager.secret != "east-kubeconfig" {
		t.Fatalf("wrong config lookup: %+v", manager)
	}
}

func TestAgentPodAnalysisFailsBeforeCentralReads(t *testing.T) {
	registered := &clusters.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "registrations", Name: "east"}, Spec: clusters.ClusterSpec{Mode: clusters.ClusterModeAgent}}
	r := routingReconciler(t, registered)
	central := kubefake.NewSimpleClientset()
	r.Analyzer = analysis.NewCELAnalyzer(central, "workloads", nil, nil)
	stage := &paprikav1.Stage{Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: "east", Namespace: "registrations", AgentAddress: "https://agent.example"}}}
	if _, err := r.analyzerForStage(context.Background(), stage, "workloads", []paprikav1.AnalysisCheck{{Type: "podMetrics"}}); err == nil {
		t.Fatal("agent analysis silently used central cluster")
	}
	if len(central.Actions()) != 0 {
		t.Fatal("agent analysis read central pods")
	}
	bound, err := r.analyzerForStage(context.Background(), stage, "workloads", []paprikav1.AnalysisCheck{{Type: "http"}})
	if err != nil || bound != r.Analyzer {
		t.Fatal("explicit HTTP analysis endpoint was disabled")
	}
}
