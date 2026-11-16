package apiserver

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/kube"
)

// The application manages a Deployment whose ReplicaSet and Pod it owns, a
// Deployment whose selector matches a stray pod, a CronJob whose Job and Pod it
// owns, and a bare Pod. Everything else in the namespace, and everything in
// another namespace, is outside the application's tree.

const logsScopeNamespace = "shop"

func logsScopeApplication(cluster *pipelinesv1alpha1.ClusterRef) *pipelinesv1alpha1.Application {
	stage := pipelinesv1alpha1.ApplicationPromotionStage{Name: "prod", Ring: 1}
	if cluster != nil {
		stage.Cluster = *cluster
	}
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "shop-app", Namespace: "platform"},
		Spec:       pipelinesv1alpha1.ApplicationSpec{Stages: []pipelinesv1alpha1.ApplicationPromotionStage{stage}},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "api", Namespace: logsScopeNamespace, Status: "Synced"},
				{Kind: "Deployment", Name: "legacy", Namespace: logsScopeNamespace, Status: "Synced"},
				{Kind: "Deployment", Name: "web", Namespace: logsScopeNamespace, Status: "Synced"},
				{Kind: "CronJob", Name: "nightly", Namespace: logsScopeNamespace, Status: "Synced"},
				{Kind: "Pod", Name: "bootstrap-0", Namespace: logsScopeNamespace, Status: "Synced"},
			},
		},
	}
}

func logsScopeOwned(kind, name string) []metav1.OwnerReference {
	return []metav1.OwnerReference{{APIVersion: "v1", Kind: kind, Name: name, UID: types.UID("uid-" + kind + "-" + name)}}
}

func logsScopeSelector(key, value string) *metav1.LabelSelector {
	return &metav1.LabelSelector{MatchLabels: map[string]string{key: value}}
}

// logsScopeChain is the application's own workload tree in one namespace: the
// Deployment api, its ReplicaSet, and the Pod that ReplicaSet owns.
func logsScopeChain(namespace string) []runtime.Object {
	return []runtime.Object{
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: namespace},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "api")}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9", Namespace: namespace,
			OwnerReferences: logsScopeOwned("Deployment", "api")},
			Spec: appsv1.ReplicaSetSpec{Selector: logsScopeSelector("app", "api")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9-x1", Namespace: namespace,
			Labels: map[string]string{"app": "api"}, OwnerReferences: logsScopeOwned("ReplicaSet", "api-7d9")}},
	}
}

// logsScopeDestination is the destination cluster's view of the application.
func logsScopeDestination() []runtime.Object {
	objects := logsScopeChain(logsScopeNamespace)
	objects = append(objects,
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "legacy", Namespace: logsScopeNamespace},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "legacy")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "legacy-stray", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "legacy"}}},
		// A managed Deployment whose selector also matches a pod that sorts first
		// by name and is not in the tree.
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: logsScopeNamespace},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "web")}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "web-5c", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Deployment", "web")},
			Spec: appsv1.ReplicaSetSpec{Selector: logsScopeSelector("app", "web")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web-000-canary", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "web"}}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web-abc-x", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "web"}, OwnerReferences: logsScopeOwned("ReplicaSet", "web-5c")}},
		&batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "nightly", Namespace: logsScopeNamespace}},
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "nightly-28", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("CronJob", "nightly")},
			Spec: batchv1.JobSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"job-name": "nightly-28"}}}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "nightly-28-abc", Namespace: logsScopeNamespace,
			Labels: map[string]string{"job-name": "nightly-28"}, OwnerReferences: logsScopeOwned("Job", "nightly-28")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "bootstrap-0", Namespace: logsScopeNamespace}},
		// Pods that a managed Deployment or CronJob owns directly, with no
		// ReplicaSet or Job between them. The tree does not discover these.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-direct", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Deployment", "api")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "nightly-direct", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("CronJob", "nightly")}},
		// An unmanaged Deployment with its own ReplicaSet and Pod in the same namespace.
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "unrelated", Namespace: logsScopeNamespace},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "unrelated")}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "unrelated-5f", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Deployment", "unrelated")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "unrelated-5f-zz", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "unrelated"}, OwnerReferences: logsScopeOwned("ReplicaSet", "unrelated-5f")}},
		// A pod in the application's namespace that no managed resource owns.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "stray", Namespace: logsScopeNamespace}},
		// A Job and a ReplicaSet in the application's namespace that no managed
		// resource owns. Each has a missing counterpart name in the cases below.
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "stray-job", Namespace: logsScopeNamespace}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "unrelated-rs", Namespace: logsScopeNamespace}},
		// Pods whose owner is a missing ReplicaSet or Job, and pods whose owner
		// exists but is outside the tree.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pod-of-ghost-rs", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("ReplicaSet", "ghost-rs")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pod-of-unrelated-rs", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("ReplicaSet", "unrelated-rs")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pod-of-ghost-job", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Job", "ghost-job")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pod-of-stray-job", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Job", "stray-job")}},
		// The same pod name as the application's pod, in another namespace, with
		// an owner that has the same name as the application's ReplicaSet.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9-x1", Namespace: "other",
			OwnerReferences: logsScopeOwned("ReplicaSet", "api-7d9")}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9", Namespace: "other",
			OwnerReferences: logsScopeOwned("Deployment", "api")}},
	)
	return objects
}

func logsScopeClientset(objects ...runtime.Object) *k8sfake.Clientset {
	cs := k8sfake.NewSimpleClientset(objects...)
	listPodsInNameOrder(cs)
	return cs
}

// listPodsInNameOrder makes the fake return matching pods in name order, as the
// API server does. The fake's own order follows a map, so without this the
// first match is not stable, and a test that depends on it can pass by luck.
func listPodsInNameOrder(cs *k8sfake.Clientset) {
	cs.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		list, ok := action.(k8stesting.ListAction)
		if !ok {
			return false, nil, nil
		}
		obj, err := cs.Tracker().List(corev1.SchemeGroupVersion.WithResource("pods"), corev1.SchemeGroupVersion.WithKind("Pod"), list.GetNamespace())
		if err != nil {
			return true, nil, err
		}
		podList, ok := obj.(*corev1.PodList)
		if !ok {
			return true, nil, errors.New("tracker returned a non-pod list")
		}
		selector := list.GetListRestrictions().Labels
		out := &corev1.PodList{}
		for _, pod := range podList.Items {
			if selector.Matches(labels.Set(pod.Labels)) {
				out.Items = append(out.Items, pod)
			}
		}
		slices.SortFunc(out.Items, func(a, b corev1.Pod) int { return strings.Compare(a.Name, b.Name) })
		// The API server returns at most Limit items, so the fake does too.
		if la, ok := action.(k8stesting.ListActionImpl); ok && la.ListOptions.Limit > 0 && int64(len(out.Items)) > la.ListOptions.Limit {
			out.Items = out.Items[:la.ListOptions.Limit]
		}
		return true, out, nil
	})
}

// logsScopeServer serves the real PaprikaService over connect, so both log
// handlers run through their request and response paths.
func logsScopeServer(t *testing.T, app *pipelinesv1alpha1.Application, extra []runtime.Object, opts ...ServerOption) v1connect.PaprikaServiceClient {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	// The fake client builder writes resource versions into the objects it is
	// given. Parallel subtests share fixtures, so each server gets its own copies.
	objects := make([]runtime.Object, 0, 1+len(extra))
	objects = append(objects, app.DeepCopy())
	for _, o := range extra {
		objects = append(objects, o.DeepCopyObject())
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(objects...).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
	srv := NewPaprikaServer(c, nil, opts...)
	_, handler := v1connect.NewPaprikaServiceHandler(srv)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return v1connect.NewPaprikaServiceClient(ts.Client(), ts.URL)
}

// logsScopeCase is one request identity and the outcome the tree dictates.
type logsScopeCase struct {
	name      string
	kind      string
	resource  string
	namespace string
	allowed   bool
	// podName is the pod the request must read when allowed.
	podName string
	// noPods marks a managed workload whose selector matches only pods outside
	// the tree. The request gets the same answer as a workload with no pods.
	noPods bool
}

var logsScopeCases = []logsScopeCase{
	{name: "pod in a workload owner chain", kind: "Pod", resource: "api-7d9-x1", namespace: logsScopeNamespace, allowed: true, podName: "api-7d9-x1"},
	{name: "deployment resolves its owned pod", kind: "Deployment", resource: "api", namespace: logsScopeNamespace, allowed: true, podName: "api-7d9-x1"},
	{name: "replicaset resolves its owned pod", kind: "ReplicaSet", resource: "api-7d9", namespace: logsScopeNamespace, allowed: true, podName: "api-7d9-x1"},
	{name: "managed bare pod", kind: "Pod", resource: "bootstrap-0", namespace: logsScopeNamespace, allowed: true, podName: "bootstrap-0"},
	{name: "pod in a cronjob owner chain", kind: "Pod", resource: "nightly-28-abc", namespace: logsScopeNamespace, allowed: true, podName: "nightly-28-abc"},
	{name: "pod owned directly by a managed deployment", kind: "Pod", resource: "api-direct", namespace: logsScopeNamespace},
	{name: "pod owned directly by a managed cronjob", kind: "Pod", resource: "nightly-direct", namespace: logsScopeNamespace},
	{name: "job resolves its owned pod", kind: "Job", resource: "nightly-28", namespace: logsScopeNamespace, allowed: true, podName: "nightly-28-abc"},
	{name: "pod with the same name in another namespace", kind: "Pod", resource: "api-7d9-x1", namespace: "other"},
	{name: "unrelated pod in the application namespace", kind: "Pod", resource: "unrelated-5f-zz", namespace: logsScopeNamespace},
	{name: "unowned pod in the application namespace", kind: "Pod", resource: "stray", namespace: logsScopeNamespace},
	{name: "unmanaged deployment", kind: "Deployment", resource: "unrelated", namespace: logsScopeNamespace},
	{name: "managed deployment whose selector matches only a foreign pod", kind: "Deployment", resource: "legacy", namespace: logsScopeNamespace, noPods: true},
	{name: "managed deployment whose first matching pod is foreign", kind: "Deployment", resource: "web", namespace: logsScopeNamespace, allowed: true, podName: "web-abc-x"},
	{name: "nonexistent pod", kind: "Pod", resource: "ghost", namespace: logsScopeNamespace},
	{name: "nonexistent deployment", kind: "Deployment", resource: "ghost-deploy", namespace: logsScopeNamespace},
}

// logsScopeMessage returns a connect error's message without its code prefix.
func logsScopeMessage(t *testing.T, err error) string {
	t.Helper()
	var ce *connect.Error
	require.ErrorAs(t, err, &ce)
	return ce.Message()
}

// noPodsMessage is the answer for a workload whose selector matches no pod in the tree.
func noPodsMessage(kind, name string) string {
	return fmt.Sprintf("no pods found for %s/%s", kind, name)
}

// logsScopeOutsideMessage is the one message for a resource outside the tree.
func logsScopeOutsideMessage(kind, namespace, name string) string {
	return fmt.Sprintf("%s %s/%s was not found in this application's resource tree", kind, namespace, name)
}

func TestResolveApplicationLogsPodFollowsTheResourceTree(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	typed := logsScopeClientset(logsScopeDestination()...)
	for _, tc := range logsScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			pod, err := resolveApplicationLogsPod(t.Context(), typed, app, tc.kind, tc.resource, tc.namespace)
			if tc.allowed {
				require.NoError(t, err)
				require.Equal(t, tc.podName, pod.Name)
				require.Equal(t, tc.namespace, pod.Namespace)
				return
			}
			require.Error(t, err)
			if tc.noPods {
				require.NotEqual(t, connect.CodeNotFound, connect.CodeOf(err))
				require.Equal(t, noPodsMessage(tc.kind, tc.resource), err.Error())
				return
			}
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
			require.Equal(t, logsScopeOutsideMessage(tc.kind, tc.namespace, tc.resource), logsScopeMessage(t, err))
		})
	}
}

func TestResourceLogsScopeIsEnforcedByBothHandlers(t *testing.T) {
	t.Parallel()
	client := logsScopeServer(t, logsScopeApplication(nil), nil, WithK8sClient(logsScopeClientset(logsScopeDestination()...)))
	for _, tc := range logsScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ctx := t.Context()
			unary, unaryErr := client.GetResourceLogs(ctx, connect.NewRequest(&paprikav1.GetResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: tc.kind, ResourceName: tc.resource, ResourceNamespace: tc.namespace,
			}))
			stream, err := client.StreamResourceLogs(ctx, connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: tc.kind, ResourceName: tc.resource, ResourceNamespace: tc.namespace,
			}))
			require.NoError(t, err)
			chunks := 0
			for stream.Receive() {
				chunks++
			}
			streamErr := stream.Err()
			require.NoError(t, stream.Close())

			if tc.allowed {
				require.NoError(t, unaryErr)
				require.Empty(t, unary.Msg.Error)
				require.Equal(t, tc.podName, unary.Msg.PodName)
				require.NoError(t, streamErr)
				require.Positive(t, chunks)
				return
			}
			if tc.noPods {
				require.NoError(t, unaryErr, "unary handler")
				require.Equal(t, noPodsMessage(tc.kind, tc.resource), unary.Msg.Error, "unary handler")
				require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(streamErr), "stream handler")
				require.Equal(t, noPodsMessage(tc.kind, tc.resource), logsScopeMessage(t, streamErr), "stream handler")
				require.Zero(t, chunks, "a denied stream must send no log lines")
				return
			}
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(unaryErr), "unary handler")
			require.Equal(t, logsScopeOutsideMessage(tc.kind, tc.namespace, tc.resource), logsScopeMessage(t, unaryErr))
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(streamErr), "stream handler")
			require.Equal(t, logsScopeOutsideMessage(tc.kind, tc.namespace, tc.resource), logsScopeMessage(t, streamErr))
			require.Zero(t, chunks, "a denied stream must send no log lines")
		})
	}
}

func TestResourceLogsScopeGivesOneErrorForMissingAndUnrelatedResources(t *testing.T) {
	t.Parallel()
	client := logsScopeServer(t, logsScopeApplication(nil), nil, WithK8sClient(logsScopeClientset(logsScopeDestination()...)))

	// Each pair is a name that does not exist and a name that exists outside the
	// tree, for one kind. Each name must get the same code and message shape.
	pairs := []struct{ kind, missing, unrelated string }{
		{"Pod", "ghost", "stray"},
		{"Pod", "ghost", "unrelated-5f-zz"},
		{"Deployment", "ghost-deploy", "unrelated"},
		{"ReplicaSet", "ghost-rs", "unrelated-rs"},
		{"Job", "ghost-job", "stray-job"},
		{"Pod", "pod-of-ghost-rs", "pod-of-unrelated-rs"},
		{"Pod", "pod-of-ghost-job", "pod-of-stray-job"},
	}
	for _, pair := range pairs {
		for _, name := range []string{pair.missing, pair.unrelated} {
			want := logsScopeOutsideMessage(pair.kind, logsScopeNamespace, name)

			_, unaryErr := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: pair.kind, ResourceName: name, ResourceNamespace: logsScopeNamespace,
			}))
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(unaryErr), name)
			require.Equal(t, want, logsScopeMessage(t, unaryErr), name)

			stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: pair.kind, ResourceName: name, ResourceNamespace: logsScopeNamespace,
			}))
			require.NoError(t, err)
			require.False(t, stream.Receive(), name)
			streamErr := stream.Err()
			require.NoError(t, stream.Close())
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(streamErr), name)
			require.Equal(t, want, logsScopeMessage(t, streamErr), name)
		}
	}
}

// TestResourceLogsScopeTreatsAnEmptyStatusNamespaceAsTheApplicationNamespace
// covers a managed entry with no namespace: the tree places it in the
// application's namespace, and so must the log scope.
func TestResourceLogsScopeTreatsAnEmptyStatusNamespaceAsTheApplicationNamespace(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Pod", Name: "defaulted", Status: "Synced"})
	typed := logsScopeClientset(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "defaulted", Namespace: "platform"}})
	client := logsScopeServer(t, app, nil, WithK8sClient(typed))

	unary, err := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
		ApplicationNamespace: "platform", ApplicationName: "shop-app",
		ResourceKind: "Pod", ResourceName: "defaulted",
	}))
	require.NoError(t, err)
	require.Empty(t, unary.Msg.Error)
	require.Equal(t, "defaulted", unary.Msg.PodName)
}

// TestResourceLogsScopeKeepsAnEmptyStatusNamespaceInTheApplicationNamespace
// checks that a managed entry with no namespace does not spread to the namespace
// a request names. The entry is platform/x, so other/x, which nothing owns, is
// outside the tree even though other is an application namespace.
func TestResourceLogsScopeKeepsAnEmptyStatusNamespaceInTheApplicationNamespace(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "ConfigMap", Name: "cfg", Namespace: "other", Status: "Synced"},
		pipelinesv1alpha1.ResourceSync{Kind: "Pod", Name: "x", Status: "Synced"})
	cs := logsScopeClientset(
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "x", Namespace: "platform"}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "x", Namespace: "other"}},
	)

	pod, err := resolveApplicationLogsPod(t.Context(), cs, app, "Pod", "x", "platform")
	require.NoError(t, err)
	require.Equal(t, "platform", pod.Namespace)

	_, err = resolveApplicationLogsPod(t.Context(), cs, app, "Pod", "x", "other")
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	require.Equal(t, logsScopeOutsideMessage("Pod", "other", "x"), logsScopeMessage(t, err))
}

func TestResourceLogsScopeReadsTheApplicationsDestinationCluster(t *testing.T) {
	t.Parallel()
	cluster := &pipelinesv1alpha1.ClusterRef{Name: "edge", Namespace: "paprika-system"}
	// Each subtest builds its own cluster object: the fake client builder writes
	// resource versions into the objects it is given, so a shared one races.
	newEdge := func() *clustersv1alpha1.Cluster {
		return &clustersv1alpha1.Cluster{
			ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "paprika-system"},
			Spec: clustersv1alpha1.ClusterSpec{
				Mode:   clustersv1alpha1.ClusterModeDirect,
				Server: "https://edge.example:6443",
			},
		}
	}
	const edgeHost = "https://edge.example:6443"
	newRequest := func() *paprikav1.GetResourceLogsRequest {
		return &paprikav1.GetResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: "Pod", ResourceName: "api-7d9-x1", ResourceNamespace: logsScopeNamespace,
		}
	}

	// Each case puts the chain pod on one cluster and an unowned pod with the
	// same name on the other. The answer must come from the destination.
	cases := []struct {
		name        string
		controlPane []runtime.Object
		destination []runtime.Object
		allowed     bool
	}{
		{
			name:        "destination holds the owned pod",
			controlPane: []runtime.Object{&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9-x1", Namespace: logsScopeNamespace}}},
			destination: logsScopeChain(logsScopeNamespace),
			allowed:     true,
		},
		{
			name:        "control plane holds the owned pod, destination does not",
			controlPane: logsScopeChain(logsScopeNamespace),
			destination: []runtime.Object{&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9-x1", Namespace: logsScopeNamespace}}},
			allowed:     false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var dialed []string
			destination := logsScopeClientset(tc.destination...)
			clients := kube.NewClientsWithBuilder(func(cfg *rest.Config) (kubernetes.Interface, *http.Client, error) {
				dialed = append(dialed, cfg.Host)
				if cfg.Host != edgeHost {
					return nil, nil, fmt.Errorf("unexpected cluster %s", cfg.Host)
				}
				return destination, &http.Client{}, nil
			})
			app := logsScopeApplication(cluster)
			client := logsScopeServer(t, app, []runtime.Object{newEdge()},
				WithK8sClient(logsScopeClientset(tc.controlPane...)),
				WithKubeClients(clients))

			unary, err := client.GetResourceLogs(t.Context(), connect.NewRequest(newRequest()))
			require.Equal(t, []string{edgeHost}, dialed, "the read must dial the application's destination cluster")
			if tc.allowed {
				require.NoError(t, err)
				require.Empty(t, unary.Msg.Error)
				require.Equal(t, "api-7d9-x1", unary.Msg.PodName)
			} else {
				require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
			}

			// The stream handler reads the same cluster, so it must give the same answer.
			stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: "Pod", ResourceName: "api-7d9-x1", ResourceNamespace: logsScopeNamespace,
			}))
			require.NoError(t, err)
			chunks := 0
			for stream.Receive() {
				chunks++
			}
			streamErr := stream.Err()
			require.NoError(t, stream.Close())
			require.Equal(t, []string{edgeHost}, dialed, "the stream must use the same destination client")
			if tc.allowed {
				require.NoError(t, streamErr)
				require.Positive(t, chunks)
				return
			}
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(streamErr))
			require.Zero(t, chunks)
		})
	}
}

// getsOf counts the get calls the fake clientset served for one resource.
func getsOf(cs *k8sfake.Clientset, resource string) int {
	n := 0
	for _, action := range cs.Actions() {
		if action.GetVerb() == "get" && action.GetResource().Resource == resource {
			n++
		}
	}
	return n
}

func TestResourceLogsScopeBoundsTheOwnerWalk(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)

	t.Run("pod with many owner references is denied within a bounded number of reads", func(t *testing.T) {
		t.Parallel()
		owners := make([]metav1.OwnerReference, 0, 2000)
		for i := range 1999 {
			owners = append(owners, metav1.OwnerReference{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: fmt.Sprintf("missing-%d", i)})
		}
		// The managed ReplicaSet is last. The bound stops the walk before it, so
		// the answer shows the bound, not the tree.
		owners = append(owners, logsScopeOwned("ReplicaSet", "api-7d9")...)
		objects := append(logsScopeDestination(), &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Name: "crowded", Namespace: logsScopeNamespace, OwnerReferences: owners}})
		cs := logsScopeClientset(objects...)

		_, err := resolveApplicationLogsPod(t.Context(), cs, app, "Pod", "crowded", logsScopeNamespace)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		require.Equal(t, logsScopeOutsideMessage("Pod", logsScopeNamespace, "crowded"), logsScopeMessage(t, err))
		require.LessOrEqual(t, getsOf(cs, "replicasets"), logsTreeMaxOwnerRefs)
	})

	t.Run("workload candidates that share an owner read it once", func(t *testing.T) {
		t.Parallel()
		objects := append(logsScopeDestination(),
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "wide", Namespace: logsScopeNamespace},
				Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "wide")}})
		for i := range 40 {
			objects = append(objects, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
				Name: fmt.Sprintf("shared-%02d", i), Namespace: logsScopeNamespace,
				Labels: map[string]string{"app": "wide"}, OwnerReferences: logsScopeOwned("ReplicaSet", "shared-rs")}})
		}
		objects = append(objects, &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "shared-rs", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Deployment", "unrelated")}})
		cs := logsScopeClientset(objects...)
		managed := logsScopeApplication(nil)
		managed.Status.Resources = append(managed.Status.Resources,
			pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "wide", Namespace: logsScopeNamespace, Status: "Synced"})

		_, err := resolveApplicationLogsPod(t.Context(), cs, managed, "Deployment", "wide", logsScopeNamespace)
		require.EqualError(t, err, noPodsMessage("Deployment", "wide"))
		require.Equal(t, 1, getsOf(cs, "replicasets"))
	})

	t.Run("workload candidates stop at the read budget", func(t *testing.T) {
		t.Parallel()
		objects := append(logsScopeDestination(),
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "wide", Namespace: logsScopeNamespace},
				Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "wide")}})
		for i := range 40 {
			rs := fmt.Sprintf("wide-rs-%02d", i)
			objects = append(objects,
				&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: rs, Namespace: logsScopeNamespace,
					OwnerReferences: logsScopeOwned("Deployment", "unrelated")}},
				&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
					Name: fmt.Sprintf("wide-pod-%02d", i), Namespace: logsScopeNamespace,
					Labels: map[string]string{"app": "wide"}, OwnerReferences: logsScopeOwned("ReplicaSet", rs)}})
		}
		cs := logsScopeClientset(objects...)
		managed := logsScopeApplication(nil)
		managed.Status.Resources = append(managed.Status.Resources,
			pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "wide", Namespace: logsScopeNamespace, Status: "Synced"})

		_, err := resolveApplicationLogsPod(t.Context(), cs, managed, "Deployment", "wide", logsScopeNamespace)
		require.EqualError(t, err, noPodsMessage("Deployment", "wide"))
		require.Equal(t, logsTreeMaxReads, getsOf(cs, "replicasets"))
	})
}

func TestResourceLogsScopeHidesReadErrorDetails(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	const detail = `pods "broken" is forbidden: User "reader-user" cannot get resource`
	cs := logsScopeClientset(append(logsScopeDestination(),
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "broken", Namespace: logsScopeNamespace}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "forbidden", Namespace: logsScopeNamespace}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "locked-owner", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("ReplicaSet", "locked-rs")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "broken-owner", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("ReplicaSet", "broken-rs")}},
	)...)
	cs.PrependReactor("get", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		switch name := getActionName(action); name {
		case "broken":
			return true, nil, apierrors.NewInternalError(errors.New(detail))
		case "forbidden":
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, name, errors.New(detail))
		}
		return false, nil, nil
	})
	cs.PrependReactor("get", "replicasets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		switch name := getActionName(action); name {
		case "locked-rs":
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "apps", Resource: "replicasets"}, name, errors.New(detail))
		case "broken-rs":
			return true, nil, apierrors.NewInternalError(errors.New(detail))
		}
		return false, nil, nil
	})

	// A read failure the caller must not see gets the generic message. A forbidden
	// read cannot show the tree either, so it gets the outside-the-tree answer.
	for _, tc := range []struct {
		name, resource string
		want           string
		code           connect.Code
	}{
		{name: "pod read fails", resource: "broken", want: errLogsReadFailed.Error(), code: connect.CodeUnknown},
		{name: "owner read fails", resource: "broken-owner", want: errLogsReadFailed.Error(), code: connect.CodeUnknown},
		{name: "pod read forbidden", resource: "forbidden", want: logsScopeOutsideMessage("Pod", logsScopeNamespace, "forbidden"), code: connect.CodeNotFound},
		{name: "owner read forbidden", resource: "locked-owner", want: logsScopeOutsideMessage("Pod", logsScopeNamespace, "locked-owner"), code: connect.CodeNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := resolveApplicationLogsPod(t.Context(), cs, app, "Pod", tc.resource, logsScopeNamespace)
			require.Error(t, err)
			require.Equal(t, tc.code, connect.CodeOf(err))
			message := err.Error()
			if tc.code == connect.CodeNotFound {
				message = logsScopeMessage(t, err)
			}
			require.Equal(t, tc.want, message)
			require.NotContains(t, message, "is forbidden")
			require.NotContains(t, message, "reader-user")
		})
	}
}

// getActionName returns the object name of a get action, or "" for another action.
func getActionName(action k8stesting.Action) string {
	if get, ok := action.(k8stesting.GetAction); ok {
		return get.GetName()
	}
	return ""
}

// TestResourceLogsScopeAllowsExactlyTheTreePods checks the log scope against the
// tree the console renders: every pod GetResourceTreeDetailed lists is readable,
// and every other pod in the cluster is not.
func TestResourceLogsScopeAllowsExactlyTheTreePods(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	dynScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(dynScheme))
	dyn := dynamicfake.NewSimpleDynamicClient(dynScheme, logsScopeDestination()...)
	typed := logsScopeClientset(logsScopeDestination()...)
	client := logsScopeServer(t, app, nil, WithK8sClient(typed), WithDynamicClient(dyn))

	tree, err := client.GetResourceTreeDetailed(t.Context(), connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: "platform", ApplicationName: "shop-app",
	}))
	require.NoError(t, err)
	inTree := make(map[string]bool)
	for _, node := range tree.Msg.Nodes {
		if node.Kind == "Pod" {
			inTree[node.Namespace+"/"+node.Name] = true
		}
	}
	require.NotEmpty(t, inTree)

	pods, err := typed.CoreV1().Pods(metav1.NamespaceAll).List(t.Context(), metav1.ListOptions{})
	require.NoError(t, err)
	allowed := 0
	for _, pod := range pods.Items {
		key := pod.Namespace + "/" + pod.Name
		_, readErr := resolveApplicationLogsPod(t.Context(), typed, app, "Pod", pod.Name, pod.Namespace)
		require.Equal(t, inTree[key], readErr == nil, key)
		if readErr == nil {
			allowed++
		}
	}
	require.Equal(t, len(inTree), allowed)
	require.Less(t, allowed, len(pods.Items), "the fixture must include pods outside the tree")
}

// TestResourceLogsScopeChecksEveryManagedNamespace covers an application whose
// managed resources span two namespaces. Same-named chains in the second
// namespace are outside the tree, because the tree keeps each owner chain in its
// own namespace.
func TestResourceLogsScopeChecksEveryManagedNamespace(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "ConfigMap", Name: "cfg", Namespace: "other", Status: "Synced"})
	cs := logsScopeClientset(append(logsScopeDestination(),
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "other"},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "api")}})...)
	client := logsScopeServer(t, app, nil, WithK8sClient(cs))

	for _, tc := range []struct{ kind, name string }{
		{"Pod", "api-7d9-x1"},
		{"Deployment", "api"},
		{"ReplicaSet", "api-7d9"},
	} {
		want := logsScopeOutsideMessage(tc.kind, "other", tc.name)

		_, err := resolveApplicationLogsPod(t.Context(), cs, app, tc.kind, tc.name, "other")
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), tc.kind)
		require.Equal(t, want, logsScopeMessage(t, err), tc.kind)

		_, unaryErr := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: tc.kind, ResourceName: tc.name, ResourceNamespace: "other",
		}))
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(unaryErr), "unary handler "+tc.kind)
		require.Equal(t, want, logsScopeMessage(t, unaryErr), "unary handler "+tc.kind)

		stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: tc.kind, ResourceName: tc.name, ResourceNamespace: "other",
		}))
		require.NoError(t, err)
		require.False(t, stream.Receive(), tc.kind)
		streamErr := stream.Err()
		require.NoError(t, stream.Close())
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(streamErr), "stream handler "+tc.kind)
		require.Equal(t, want, logsScopeMessage(t, streamErr), "stream handler "+tc.kind)
	}
}

// TestResourceLogsScopeAllowsAManagedChainInASecondNamespace checks the other
// side of the namespace rule: a chain the tree shows in a second managed
// namespace is readable through the resolver and both handlers.
func TestResourceLogsScopeAllowsAManagedChainInASecondNamespace(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "api2", Namespace: "other", Status: "Synced"})
	cs := logsScopeClientset(append(logsScopeDestination(),
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api2", Namespace: "other"},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "api2")}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "api2-1", Namespace: "other",
			OwnerReferences: logsScopeOwned("Deployment", "api2")},
			Spec: appsv1.ReplicaSetSpec{Selector: logsScopeSelector("app", "api2")}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api2-1-x", Namespace: "other",
			Labels: map[string]string{"app": "api2"}, OwnerReferences: logsScopeOwned("ReplicaSet", "api2-1")}},
	)...)
	client := logsScopeServer(t, app, nil, WithK8sClient(cs))

	for _, tc := range []struct{ kind, name string }{
		{"Pod", "api2-1-x"},
		{"Deployment", "api2"},
		{"ReplicaSet", "api2-1"},
	} {
		pod, err := resolveApplicationLogsPod(t.Context(), cs, app, tc.kind, tc.name, "other")
		require.NoError(t, err, tc.kind)
		require.Equal(t, "api2-1-x", pod.Name, tc.kind)
		require.Equal(t, "other", pod.Namespace, tc.kind)

		unary, err := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: tc.kind, ResourceName: tc.name, ResourceNamespace: "other",
		}))
		require.NoError(t, err, "unary handler "+tc.kind)
		require.Empty(t, unary.Msg.Error, "unary handler "+tc.kind)
		require.Equal(t, "api2-1-x", unary.Msg.PodName, "unary handler "+tc.kind)

		stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
			ApplicationNamespace: "platform", ApplicationName: "shop-app",
			ResourceKind: tc.kind, ResourceName: tc.name, ResourceNamespace: "other",
		}))
		require.NoError(t, err, "stream handler "+tc.kind)
		chunks := 0
		for stream.Receive() {
			chunks++
		}
		streamErr := stream.Err()
		require.NoError(t, stream.Close())
		require.NoError(t, streamErr, "stream handler "+tc.kind)
		require.Positive(t, chunks, "stream handler "+tc.kind)
	}
}

// TestResourceLogsScopeSendsNothingToANamespaceTheApplicationDoesNotUse checks
// that a namespace with no managed resource is refused before any cluster read.
func TestResourceLogsScopeSendsNothingToANamespaceTheApplicationDoesNotUse(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	for _, kind := range []string{"Pod", "Deployment", "ReplicaSet"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			cs := logsScopeClientset(logsScopeDestination()...)
			_, err := resolveApplicationLogsPod(t.Context(), cs, app, kind, "api-7d9-x1", "staging")
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
			require.Equal(t, logsScopeOutsideMessage(kind, "staging", "api-7d9-x1"), logsScopeMessage(t, err))
			require.Empty(t, cs.Actions(), "a namespace the application does not use must not reach the cluster")

			client := logsScopeServer(t, app, nil, WithK8sClient(cs))
			_, unaryErr := client.GetResourceLogs(t.Context(), connect.NewRequest(&paprikav1.GetResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: kind, ResourceName: "api-7d9-x1", ResourceNamespace: "staging",
			}))
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(unaryErr))
			require.Empty(t, cs.Actions(), "the unary handler must not reach the cluster either")

			stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
				ApplicationNamespace: "platform", ApplicationName: "shop-app",
				ResourceKind: kind, ResourceName: "api-7d9-x1", ResourceNamespace: "staging",
			}))
			require.NoError(t, err)
			require.False(t, stream.Receive())
			streamErr := stream.Err()
			require.NoError(t, stream.Close())
			require.Equal(t, connect.CodeNotFound, connect.CodeOf(streamErr))
			require.Equal(t, logsScopeOutsideMessage(kind, "staging", "api-7d9-x1"), logsScopeMessage(t, streamErr))
			require.Empty(t, cs.Actions(), "the stream handler must not reach the cluster either")
		})
	}
}

// TestResourceLogsScopeResolvesEachDeploymentToItsOwnPod covers two in-tree
// Deployments whose selectors match the same pods. Each Deployment resolves to a
// pod its own ReplicaSet owns, even when the other Deployment's pod sorts first.
func TestResourceLogsScopeResolvesEachDeploymentToItsOwnPod(t *testing.T) {
	t.Parallel()
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "api-canary", Namespace: logsScopeNamespace, Status: "Synced"})
	cs := logsScopeClientset(append(logsScopeDestination(),
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api-canary", Namespace: logsScopeNamespace},
			Spec: appsv1.DeploymentSpec{Selector: logsScopeSelector("app", "api")}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "api-canary-1", Namespace: logsScopeNamespace,
			OwnerReferences: logsScopeOwned("Deployment", "api-canary")}},
		// api-0-canary sorts before api-7d9-x1, so a Deployment that accepted any
		// ReplicaSet-owned pod would pick it for api.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-0-canary", Namespace: logsScopeNamespace,
			Labels: map[string]string{"app": "api"}, OwnerReferences: logsScopeOwned("ReplicaSet", "api-canary-1")}},
	)...)

	for _, tc := range []struct{ name, want string }{
		{"api", "api-7d9-x1"},
		{"api-canary", "api-0-canary"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			pod, err := resolveApplicationLogsPod(t.Context(), cs, app, "Deployment", tc.name, logsScopeNamespace)
			require.NoError(t, err)
			require.Equal(t, tc.want, pod.Name)
		})
	}
}
