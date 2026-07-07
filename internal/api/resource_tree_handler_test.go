package apiserver

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func setupResourceTreeTest(t *testing.T) *PaprikaServer {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	uid := types.UID("deploy-uid-123")
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase: "Healthy",
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "demo-deploy", Namespace: "test-ns", Status: "Synced"},
			},
			ResourceHealth: []pipelinesv1alpha1.ResourceHealth{
				{Kind: "Deployment", Name: "demo-deploy", Namespace: "test-ns", Health: "Healthy"},
			},
		},
	}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).
		Build()

	// Live Deployment + child ReplicaSet + grandchild Pod.
	replicas := int32(1)
	liveDeploy := &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{Name: "demo-deploy", Namespace: "test-ns", UID: uid},
		Spec:       appsv1.DeploymentSpec{Replicas: &replicas},
	}
	liveReplicaSet := &appsv1.ReplicaSet{
		TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "ReplicaSet"},
		ObjectMeta: metav1.ObjectMeta{
			Name: "demo-deploy-abc12", Namespace: "test-ns",
			OwnerReferences: []metav1.OwnerReference{
				{Kind: "Deployment", Name: "demo-deploy"},
			},
		},
	}
	livePod := &corev1.Pod{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
		ObjectMeta: metav1.ObjectMeta{
			Name: "demo-deploy-abc12-xyz34", Namespace: "test-ns",
			OwnerReferences: []metav1.OwnerReference{
				{Kind: "ReplicaSet", Name: "demo-deploy-abc12"},
			},
		},
	}

	dynScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(dynScheme))
	dynClient := dynamicfake.NewSimpleDynamicClient(dynScheme, liveDeploy, liveReplicaSet, livePod)

	srv := NewPaprikaServer(c, nil, WithDynamicClient(dynClient))
	return srv
}

func TestGetResourceTree_DeploymentWithChildren(t *testing.T) {
	ctx := context.Background()
	srv := setupResourceTreeTest(t)

	resp, err := srv.GetResourceTree(ctx, connect.NewRequest(&paprikav1.GetResourceTreeRequest{
		Namespace: "test-ns",
		Name:      "demo-app",
	}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)

	// Should have: Deployment (managed root) + ReplicaSet (child) + Pod (grandchild).
	require.GreaterOrEqual(t, len(resp.Msg.Nodes), 1)

	// Verify the managed Deployment root.
	var deployNode *paprikav1.ResourceNode
	for _, n := range resp.Msg.Nodes {
		if n.Kind == "Deployment" && n.Name == "demo-deploy" {
			deployNode = n
		}
	}
	require.NotNil(t, deployNode, "managed Deployment root should be in tree")
	require.True(t, deployNode.Managed)
	require.Equal(t, "Synced", deployNode.SyncStatus)
	require.Equal(t, "Healthy", deployNode.Health)

	// Verify the ReplicaSet child was discovered.
	var rsNode *paprikav1.ResourceNode
	for _, n := range resp.Msg.Nodes {
		if n.Kind == "ReplicaSet" && n.Name == "demo-deploy-abc12" {
			rsNode = n
		}
	}
	require.NotNil(t, rsNode, "child ReplicaSet should be discovered via ownerReferences")
	require.False(t, rsNode.Managed)
	require.Equal(t, "Deployment", rsNode.ParentKind)
	require.Equal(t, "demo-deploy", rsNode.ParentName)

	// Verify the Pod grandchild was discovered.
	var podNode *paprikav1.ResourceNode
	for _, n := range resp.Msg.Nodes {
		if n.Kind == "Pod" && n.Name == "demo-deploy-abc12-xyz34" {
			podNode = n
		}
	}
	require.NotNil(t, podNode, "grandchild Pod should be discovered via ownerReferences")
	require.False(t, podNode.Managed)
	require.Equal(t, "ReplicaSet", podNode.ParentKind)
}

func TestGetResourceTree_AppNotFound(t *testing.T) {
	ctx := context.Background()
	srv := setupResourceTreeTest(t)

	_, err := srv.GetResourceTree(ctx, connect.NewRequest(&paprikav1.GetResourceTreeRequest{
		Namespace: "test-ns",
		Name:      "nonexistent",
	}))
	require.Error(t, err)
}

func TestGetResourceTree_NoDynamicClient(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
			Status: pipelinesv1alpha1.ApplicationStatus{
				Resources: []pipelinesv1alpha1.ResourceSync{
					{Kind: "Deployment", Name: "demo-deploy", Namespace: "test-ns", Status: "Synced"},
				},
			},
		},
	).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()

	// No dynamic client — should return only managed resources without children.
	srv := NewPaprikaServer(c, nil)

	resp, err := srv.GetResourceTree(ctx, connect.NewRequest(&paprikav1.GetResourceTreeRequest{
		Namespace: "test-ns",
		Name:      "demo-app",
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Nodes, 1)
	require.True(t, resp.Msg.Nodes[0].Managed)
}

func TestHasOwnerRef(t *testing.T) {
	obj := &unstructured.Unstructured{}
	obj.SetKind("Deployment")
	obj.SetName("test")
	obj.SetNamespace("test-ns")
	obj.SetOwnerReferences([]metav1.OwnerReference{
		{Kind: "ReplicaSet", Name: "parent-rs"},
	})
	require.True(t, hasOwnerRef(obj, "ReplicaSet", "parent-rs"))
	require.False(t, hasOwnerRef(obj, "Deployment", "other-deploy"))
}

func TestGetResourceTreeDetailed_DeploymentWithReplicas(t *testing.T) {
	ctx := context.Background()
	srv := setupResourceTreeTest(t)

	// Inject a typed clientset with a Deployment that reports 2/3 ready.
	// (We don't extend setupResourceTreeTest because that helper uses only the
	// dynamic client.)
	deploy := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-deploy", Namespace: "test-ns"},
		Status: appsv1.DeploymentStatus{
			Replicas:      3,
			ReadyReplicas: 2,
		},
	}
	k8sScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(k8sScheme))
	k8s := k8sfake.NewSimpleClientset(deploy)
	srv = NewPaprikaServer(
		mustExistingClient(t),
		nil,
		WithDynamicClient(srv.dynamicClient),
		WithK8sClient(k8s),
	)

	resp, err := srv.GetResourceTreeDetailed(ctx, connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
	}))
	require.NoError(t, err)

	var node *paprikav1.ResourceTreeNode
	for _, n := range resp.Msg.Nodes {
		if n.Kind == "Deployment" && n.Name == "demo-deploy" {
			node = n
		}
	}
	require.NotNil(t, node)
	require.Equal(t, int32(2), node.Ready)
	require.Equal(t, int32(3), node.Total)
}

// mustExistingClient constructs a fake controller-runtime client with a minimal
// demo-app Application. Used by detailed-tree tests that layer on top of
// setupResourceTreeTest's discovery but need their own k8s clientsets.
func mustExistingClient(t *testing.T) client.Client { //nolint:unused // (when k8sClient test refs differ)
	// Implementation provided by re-creating from scratch below.
	t.Helper()
	return buildDetHarnessClient(t)
}

func buildDetHarnessClient(t *testing.T) client.Client {
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase: "Healthy",
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "demo-deploy", Namespace: "test-ns", Status: "Synced"},
			},
			ResourceHealth: []pipelinesv1alpha1.ResourceHealth{
				{Kind: "Deployment", Name: "demo-deploy", Namespace: "test-ns", Health: "Healthy"},
			},
		},
	}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
}

func TestGetResourceTreeDetailed_PodPhase(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Pod", Name: "demo-pod", Namespace: "test-ns", Status: "Synced"},
			},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()

	k8sScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(k8sScheme))
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-pod", Namespace: "test-ns"},
		Spec: corev1.PodSpec{Containers: []corev1.Container{
			{Name: "app"},
		}},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "app", Ready: true},
			},
		},
	}
	k8s := k8sfake.NewSimpleClientset(pod)
	srv := NewPaprikaServer(c, nil, WithK8sClient(k8s))

	resp, err := srv.GetResourceTreeDetailed(ctx, connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
	}))
	require.NoError(t, err)

	var node *paprikav1.ResourceTreeNode
	for _, n := range resp.Msg.Nodes {
		if n.Kind == "Pod" && n.Name == "demo-pod" {
			node = n
		}
	}
	require.NotNil(t, node)
	require.Equal(t, "Running", node.Phase)
	require.Equal(t, int32(1), node.Ready)
	require.Equal(t, int32(1), node.Total)
}
