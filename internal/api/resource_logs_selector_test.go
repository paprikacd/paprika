package apiserver

import (
	"testing"

	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8sfake "k8s.io/client-go/kubernetes/fake"
)

func TestResolveLogsPodUsesWorkloadSelector(t *testing.T) {
	t.Parallel()
	metadata := metav1.ObjectMeta{Name: "release-demo-stable", Namespace: "review"}
	cases := []struct {
		kind     string
		workload func(*metav1.LabelSelector) runtime.Object
	}{
		{"Deployment", func(s *metav1.LabelSelector) runtime.Object {
			return &appsv1.Deployment{ObjectMeta: metadata, Spec: appsv1.DeploymentSpec{Selector: s}}
		}},
		{"ReplicaSet", func(s *metav1.LabelSelector) runtime.Object {
			return &appsv1.ReplicaSet{ObjectMeta: metadata, Spec: appsv1.ReplicaSetSpec{Selector: s}}
		}},
		{"StatefulSet", func(s *metav1.LabelSelector) runtime.Object {
			return &appsv1.StatefulSet{ObjectMeta: metadata, Spec: appsv1.StatefulSetSpec{Selector: s}}
		}},
		{"DaemonSet", func(s *metav1.LabelSelector) runtime.Object {
			return &appsv1.DaemonSet{ObjectMeta: metadata, Spec: appsv1.DaemonSetSpec{Selector: s}}
		}},
		{"Job", func(s *metav1.LabelSelector) runtime.Object {
			return &batchv1.Job{ObjectMeta: metadata, Spec: batchv1.JobSpec{Selector: s}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			selector := &metav1.LabelSelector{
				MatchLabels:      map[string]string{"app.kubernetes.io/instance": "sample"},
				MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "track", Operator: metav1.LabelSelectorOpIn, Values: []string{"stable"}}},
			}
			matching := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "correct-pod", Namespace: "review", Labels: map[string]string{"app.kubernetes.io/instance": "sample", "track": "stable"}}}
			decoy := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "decoy", Namespace: "review", Labels: map[string]string{"app": metadata.Name, "app.kubernetes.io/instance": "sample", "track": "canary"}}}
			client := k8sfake.NewSimpleClientset(tc.workload(selector), matching, decoy)
			pod, err := resolveLogsPod(t.Context(), client, tc.kind, metadata.Name, metadata.Namespace)
			require.NoError(t, err)
			require.Equal(t, matching.Name, pod.Name)

			for _, empty := range []*metav1.LabelSelector{nil, {}} {
				emptyClient := k8sfake.NewSimpleClientset(tc.workload(empty), matching, decoy)
				_, emptyErr := resolveLogsPod(t.Context(), emptyClient, tc.kind, metadata.Name, metadata.Namespace)
				require.ErrorContains(t, emptyErr, "no pod selector configured")
				for _, action := range emptyClient.Actions() {
					require.NotEqual(t, "list", action.GetVerb(), "an absent selector must not list every pod")
				}
			}

			missing := k8sfake.NewSimpleClientset(matching, decoy)
			_, err = resolveLogsPod(t.Context(), missing, tc.kind, metadata.Name, metadata.Namespace)
			require.ErrorContains(t, err, "reading selector")
		})
	}
}
