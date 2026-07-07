package apiserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	appsv1 "k8s.io/api/apps/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/source"
)

// fakeRenderer stubs the SourceResolvingRenderer interface for GetResource tests.
type fakeRenderer struct {
	manifests []byte
	err       error
}

func (f *fakeRenderer) Render(_ context.Context, _ *pipelinesv1alpha1.Template, _ map[string]string) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.manifests, nil
}

func (f *fakeRenderer) RenderAll(_ context.Context, _ []pipelinesv1alpha1.Template, _ map[string]string) ([]byte, error) {
	return f.manifests, nil
}

func (f *fakeRenderer) RenderHelmChart(_ context.Context, _, _, _ string, _ map[string]string) ([]byte, error) {
	return f.manifests, nil
}

func (f *fakeRenderer) ResolveSource(_ context.Context, _ *pipelinesv1alpha1.Template) (*source.ResolveResult, error) {
	return &source.ResolveResult{}, nil
}

func newResourceTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	return scheme
}

const desiredManifests = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-deployment
  namespace: test-ns
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
      - name: app
        image: nginx:latest
---
apiVersion: v1
kind: Service
metadata:
  name: demo-service
  namespace: test-ns
spec:
  selector:
    app: demo
  ports:
  - port: 80
    targetPort: 80
`

func setupGetResourceTest(t *testing.T) (*PaprikaServer, client.Client) {
	t.Helper()
	scheme := newResourceTestScheme(t)

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "default",
			Source: pipelinesv1alpha1.ApplicationSource{
				Type: "git",
			},
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase:      "Healthy",
			ReleaseRef: "demo-app-release",
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "demo-deployment", Namespace: "test-ns", Status: "Synced"},
				{Kind: "Service", Name: "demo-service", Namespace: "test-ns", Status: "Synced"},
				{Kind: "Widget", Name: "demo-widget", Namespace: "test-ns", Status: "Synced"},
			},
			ResourceHealth: []pipelinesv1alpha1.ResourceHealth{
				{Kind: "Deployment", Name: "demo-deployment", Namespace: "test-ns", Health: "Healthy", Message: "Deployment has minimum availability"},
				{Kind: "Service", Name: "demo-service", Namespace: "test-ns", Health: "Healthy"},
				{Kind: "Widget", Name: "demo-widget", Namespace: "test-ns", Health: "Degraded", Message: "custom status failed"},
			},
		},
	}

	tmpl := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app-template", Namespace: "test-ns"},
		Spec: pipelinesv1alpha1.TemplateSpec{
			Type: "git",
		},
	}

	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app-release", Namespace: "test-ns"},
		Spec: pipelinesv1alpha1.ReleaseSpec{
			Parameters: map[string]string{"replicaCount": "1"},
		},
	}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app, tmpl, release).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).
		Build()

	// Fake dynamic client with a live Deployment.
	replicas := int32(1)
	liveDeployment := &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{Name: "demo-deployment", Namespace: "test-ns"},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "demo"}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "demo"}},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{Name: "app", Image: "nginx:latest"},
					},
				},
			},
		},
	}
	liveWidget := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.io/v1",
		"kind":       "Widget",
		"metadata": map[string]any{
			"name":        "demo-widget",
			"namespace":   "test-ns",
			"uid":         "widget-uid",
			"labels":      map[string]any{"app.kubernetes.io/name": "demo"},
			"annotations": map[string]any{"paprika.io/source": "test"},
		},
		"spec": map[string]any{"enabled": true},
	}}

	// Register built-in types so the dynamic fake client's RESTMapper can resolve GVRs.
	dynScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(dynScheme))

	dynClient := dynamicfake.NewSimpleDynamicClient(dynScheme, liveDeployment, liveWidget)

	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{
		{Group: "example.io", Version: "v1"},
	})
	mapper.AddSpecific(
		schema.GroupVersionKind{Group: "example.io", Version: "v1", Kind: "Widget"},
		schema.GroupVersionResource{Group: "example.io", Version: "v1", Resource: "widgets"},
		schema.GroupVersionResource{Group: "example.io", Version: "v1", Resource: "widget"},
		meta.RESTScopeNamespace,
	)

	// Fake k8s clientset with events.
	eventList := &corev1.EventList{
		Items: []corev1.Event{
			{
				ObjectMeta:    metav1.ObjectMeta{Name: "event-1", Namespace: "test-ns"},
				Type:          "Normal",
				Reason:        "Scheduled",
				Message:       "Successfully assigned test-ns/demo-deployment to node-1",
				Count:         1,
				LastTimestamp: metav1.Time{},
				InvolvedObject: corev1.ObjectReference{
					Kind:      "Deployment",
					Name:      "demo-deployment",
					Namespace: "test-ns",
				},
			},
			{
				ObjectMeta: metav1.ObjectMeta{Name: "event-2", Namespace: "test-ns"},
				Type:       "Warning",
				Reason:     "FailedScheduling",
				Message:    "Insufficient cpu",
				Count:      3,
				InvolvedObject: corev1.ObjectReference{
					Kind:      "Deployment",
					Name:      "demo-deployment",
					Namespace: "test-ns",
				},
			},
		},
	}
	k8sClient := k8sfake.NewSimpleClientset(eventList)

	srv := NewPaprikaServer(c, nil,
		WithRenderer(&fakeRenderer{manifests: []byte(desiredManifests)}),
		WithDynamicClient(dynClient),
		WithRESTMapper(mapper),
		WithK8sClient(k8sClient),
	)

	return srv, c
}

func TestGetResource_CustomResourceResolvedByRESTMapper(t *testing.T) {
	ctx := context.Background()
	srv, _ := setupGetResourceTest(t)

	req := connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Widget",
		ResourceName:         "demo-widget",
		ResourceNamespace:    "test-ns",
	})

	resp, err := srv.GetResource(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)

	require.Equal(t, "Widget", resp.Msg.Kind)
	require.Equal(t, "example.io/v1", resp.Msg.ApiVersion)
	require.Equal(t, "example.io", resp.Msg.Group)
	require.Equal(t, "v1", resp.Msg.Version)
	require.Equal(t, "widgets", resp.Msg.Resource)
	require.Equal(t, "widget-uid", resp.Msg.Uid)
	require.Equal(t, "demo", resp.Msg.Labels["app.kubernetes.io/name"])
	require.Equal(t, "test", resp.Msg.Annotations["paprika.io/source"])
	require.Equal(t, "Synced", resp.Msg.SyncStatus)
	require.Equal(t, "Degraded", resp.Msg.HealthStatus)
	require.Contains(t, resp.Msg.LiveManifest, "kind: Widget")
	require.Contains(t, resp.Msg.LiveManifest, "enabled: true")
}

func TestGetResource_Deployment(t *testing.T) {
	ctx := context.Background()
	srv, _ := setupGetResourceTest(t)

	req := connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Deployment",
		ResourceName:         "demo-deployment",
		ResourceNamespace:    "test-ns",
	})

	resp, err := srv.GetResource(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)

	// Identity fields.
	require.Equal(t, "Deployment", resp.Msg.Kind)
	require.Equal(t, "demo-deployment", resp.Msg.Name)
	require.Equal(t, "test-ns", resp.Msg.Namespace)

	// Sync status from Application CR.
	require.Equal(t, "Synced", resp.Msg.SyncStatus)

	// Health from Application CR.
	require.Equal(t, "Healthy", resp.Msg.HealthStatus)
	require.Contains(t, resp.Msg.HealthMessage, "minimum availability")

	// Live manifest should be present and contain the deployment.
	require.NotEmpty(t, resp.Msg.LiveManifest)
	require.Contains(t, resp.Msg.LiveManifest, "Deployment")
	require.Contains(t, resp.Msg.LiveManifest, "demo-deployment")

	// Live manifest should NOT contain server-managed fields.
	require.NotContains(t, resp.Msg.LiveManifest, "uid")
	require.NotContains(t, resp.Msg.LiveManifest, "resourceVersion")
	require.NotContains(t, resp.Msg.LiveManifest, "managedFields")

	// Desired manifest should be present.
	require.NotEmpty(t, resp.Msg.DesiredManifest)
	require.Contains(t, resp.Msg.DesiredManifest, "Deployment")
	require.Contains(t, resp.Msg.DesiredManifest, "nginx:latest")

	// Diff should be minimal (both have the same spec).
	// It may not be empty due to K8s-added defaults on the live side,
	// but it should exist.
	require.NotEmpty(t, resp.Msg.Diff)

	// Events should include the 2 seeded events.
	require.Len(t, resp.Msg.Events, 2)
	// Events are returned in order, most relevant first.
	require.Equal(t, "Scheduled", resp.Msg.Events[0].Reason)
	require.Equal(t, "Normal", resp.Msg.Events[0].Type)
	require.Equal(t, "FailedScheduling", resp.Msg.Events[1].Reason)
	require.Equal(t, "Warning", resp.Msg.Events[1].Type)
	require.Equal(t, int32(3), resp.Msg.Events[1].Count)
}

func TestGetResource_Service(t *testing.T) {
	ctx := context.Background()
	srv, _ := setupGetResourceTest(t)

	req := connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Service",
		ResourceName:         "demo-service",
		ResourceNamespace:    "test-ns",
	})

	resp, err := srv.GetResource(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)

	require.Equal(t, "Service", resp.Msg.Kind)
	require.Equal(t, "demo-service", resp.Msg.Name)
	require.Equal(t, "Synced", resp.Msg.SyncStatus)
	require.Equal(t, "Healthy", resp.Msg.HealthStatus)

	// Desired manifest should contain the service.
	require.NotEmpty(t, resp.Msg.DesiredManifest)
	require.Contains(t, resp.Msg.DesiredManifest, "Service")
	require.Contains(t, resp.Msg.DesiredManifest, "demo-service")

	// Live manifest might be empty (no live Service in the fake dynamic client).
	// That's fine — desired + diff just won't populate.
}

func TestGetResource_AppNotFound(t *testing.T) {
	ctx := context.Background()
	srv, _ := setupGetResourceTest(t)

	req := connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "nonexistent",
		ResourceKind:         "Deployment",
		ResourceName:         "demo-deployment",
		ResourceNamespace:    "test-ns",
	})

	_, err := srv.GetResource(ctx, req)
	require.Error(t, err)
}

func TestGetResource_ResourceNotInDesiredManifests(t *testing.T) {
	ctx := context.Background()
	srv, _ := setupGetResourceTest(t)

	req := connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Deployment",
		ResourceName:         "nonexistent-deployment",
		ResourceNamespace:    "test-ns",
	})

	resp, err := srv.GetResource(ctx, req)
	require.NoError(t, err)
	// Should still return sync status from Application CR, just no desired manifest.
	require.Equal(t, "", resp.Msg.SyncStatus) // not found in resources list
	require.Empty(t, resp.Msg.DesiredManifest)
}

func TestGetResource_LiveManifestStripsServerFields(t *testing.T) {
	ctx := context.Background()
	srv, _ := setupGetResourceTest(t)

	req := connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Deployment",
		ResourceName:         "demo-deployment",
		ResourceNamespace:    "test-ns",
	})

	resp, err := srv.GetResource(ctx, req)
	require.NoError(t, err)

	// Verify that the cleaned manifest does not contain server-managed metadata fields.
	live := resp.Msg.LiveManifest
	require.NotContains(t, live, "uid:")
	require.NotContains(t, live, "resourceVersion:")
	require.NotContains(t, live, "creationTimestamp:")
	require.NotContains(t, live, "generation:")
	require.NotContains(t, live, "managedFields:")
}

// Ensure imports compile.
var _ *httptest.Server
var _ *http.Request
var _ dynamic.Interface
var _ kubernetes.Interface
var _ = logr.Discard()
