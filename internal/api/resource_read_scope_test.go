package apiserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/mcp"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// The Secret values below appear in the destination objects and in the desired
// manifest. A response that carries one of them fails the assertions.
const (
	treeScopeDesiredValue = "desired-secret-value"
	treeScopeLiveValue    = "live-secret-value"
	treeScopeRotatedValue = "rotated-secret-value"
	treeScopeStrayValue   = "stray-secret-value"
	// treeScopeOddKeyValue and treeScopeOddKeyDataValue sit under keys that YAML
	// reads as a number and a boolean. The controller reads those keys as strings.
	treeScopeOddKeyValue     = "odd-key-secret-value"
	treeScopeOddKeyDataValue = "odd-key-data-value"
)

// treeScopeOddKeyManifests renders the managed Secret with keys that YAML reads
// as a number and a boolean, next to the usual key. The controller applies it
// with string keys, so the values must be redacted on every path.
const treeScopeOddKeyManifests = `apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  namespace: shop
stringData:
  8443: odd-key-secret-value
  true: odd-key-secret-value
  password: desired-secret-value
data:
  9: b2RkLWtleS1kYXRhLXZhbHVl
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  template:
    spec:
      containers:
      - name: app
        image: nginx:latest
`

// treeScopeManifests is what the template renders for the application: the
// managed Secret with its desired value, and the Deployment it manages.
const treeScopeManifests = `apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  namespace: shop
stringData:
  password: desired-secret-value
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  template:
    spec:
      containers:
      - name: app
        image: nginx:latest
`

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// treeScopeApplication is logsScopeApplication plus the managed Secret.
func treeScopeApplication() *pipelinesv1alpha1.Application {
	app := logsScopeApplication(nil)
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Secret", Name: "shop-creds", Namespace: logsScopeNamespace, Status: "OutOfSync"})
	return app
}

// treeScopeDestination is the destination's objects: the logs tree plus two
// Secrets. shop-creds is managed; stray-creds is not in the tree.
func treeScopeDestination() []runtime.Object {
	objects := logsScopeDestination()
	objects = append(objects,
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "shop-creds", Namespace: logsScopeNamespace,
				Labels: map[string]string{"app.paprika.io/name": "shop-app", "app.paprika.io/managed-by": "paprika"},
				// kubectl keeps the whole object, values included, in this annotation.
				Annotations: map[string]string{lastAppliedConfigAnnotation: `{"data":{"password":"` + b64(treeScopeLiveValue) + `"}}`}},
			Data: map[string][]byte{"password": []byte(treeScopeLiveValue)},
		},
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "stray-creds", Namespace: logsScopeNamespace},
			Data:       map[string][]byte{"token": []byte(treeScopeStrayValue)},
		},
	)
	return objects
}

// treeScopeServer builds the server for one application. The destination's
// objects are served through the typed and the dynamic client, as they would
// be on one cluster. The template renders treeScopeManifests.
func treeScopeServer(t *testing.T, app *pipelinesv1alpha1.Application, destination []runtime.Object, opts ...ServerOption) (*PaprikaServer, *k8sfake.Clientset) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	template := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: app.Name + "-template", Namespace: app.Namespace},
		Spec:       pipelinesv1alpha1.TemplateSpec{Type: "git"},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithRuntimeObjects(app.DeepCopy(), template).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
	typedObjs := make([]runtime.Object, 0, len(destination))
	dynObjs := make([]runtime.Object, 0, len(destination))
	for _, o := range destination {
		typedObjs = append(typedObjs, o.DeepCopyObject())
		dynObjs = append(dynObjs, o.DeepCopyObject())
	}
	typed := logsScopeClientset(typedObjs...)
	dyn := dynamicfake.NewSimpleDynamicClient(scheme, dynObjs...)
	all := append([]ServerOption{
		WithRenderer(&fakeRenderer{manifests: []byte(treeScopeManifests)}),
		WithDynamicClient(dyn),
		WithK8sClient(typed),
	}, opts...)
	return NewPaprikaServer(c, nil, all...), typed
}

// listsOf counts the list actions a fake clientset served for a resource.
func listsOf(cs *k8sfake.Clientset, resource string) int {
	count := 0
	for _, action := range cs.Actions() {
		if action.GetVerb() == "list" && action.GetResource().Resource == resource {
			count++
		}
	}
	return count
}

// logReadsOf counts the pod log reads a fake clientset served.
func logReadsOf(cs *k8sfake.Clientset) int {
	count := 0
	for _, action := range cs.Actions() {
		if action.GetVerb() == "get" && action.GetResource().Resource == "pods" && action.GetSubresource() == "log" {
			count++
		}
	}
	return count
}

func getResourceReq(kind, name, namespace string) *connect.Request[paprikav1.GetResourceRequest] {
	return connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         kind,
		ResourceName:         name,
		ResourceNamespace:    namespace,
	})
}

// assertNoSecretValues fails if any Secret value from the fixtures appears in text.
func assertNoSecretValues(t *testing.T, text string) {
	t.Helper()
	for _, value := range []string{treeScopeDesiredValue, treeScopeLiveValue, treeScopeRotatedValue, treeScopeStrayValue, treeScopeOddKeyValue, treeScopeOddKeyDataValue} {
		require.NotContains(t, text, value)
		require.NotContains(t, text, b64(value))
	}
}

func TestGetResourceReturnsAnObjectInTheTree(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	for _, tc := range []struct{ kind, name, namespace string }{
		{"Deployment", "api", logsScopeNamespace},
		{"ReplicaSet", "api-7d9", logsScopeNamespace},
		{"Pod", "api-7d9-x1", logsScopeNamespace},
		{"Pod", "nightly-28-abc", logsScopeNamespace},
	} {
		resp, err := srv.GetResource(context.Background(), getResourceReq(tc.kind, tc.name, tc.namespace))
		require.NoError(t, err, "%s/%s", tc.kind, tc.name)
		require.Contains(t, resp.Msg.LiveManifest, "name: "+tc.name, "%s/%s", tc.kind, tc.name)
	}
}

func TestGetResourceGivesOutOfTreeAndMissingObjectsTheSameError(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	for _, tc := range []struct{ kind, name, namespace string }{
		{"Pod", "unrelated-5f-zz", logsScopeNamespace}, // exists, owned by an unmanaged ReplicaSet
		{"Pod", "stray", logsScopeNamespace},           // exists, no owner
		{"Deployment", "unrelated", logsScopeNamespace},
		{"Secret", "stray-creds", logsScopeNamespace}, // exists, not in the tree
		{"Pod", "api-7d9-x1", "other"},                // same name as a tree pod, another namespace
		{"Pod", "ghost", logsScopeNamespace},          // does not exist
		{"Deployment", "ghost-deploy", logsScopeNamespace},
		{"Secret", "ghost-creds", logsScopeNamespace},
		{"Widget", "w-1", logsScopeNamespace}, // a kind the destination does not know
	} {
		resp, err := srv.GetResource(context.Background(), getResourceReq(tc.kind, tc.name, tc.namespace))
		require.Nil(t, resp, "%s/%s/%s", tc.namespace, tc.kind, tc.name)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "%s/%s/%s", tc.namespace, tc.kind, tc.name)
		require.Equal(t, logsScopeOutsideMessage(tc.kind, tc.namespace, tc.name), logsScopeMessage(t, err))
	}
}

func TestGetResourceReadsNoEventForAnObjectOutsideTheTree(t *testing.T) {
	t.Parallel()
	srv, typed := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	_, err := srv.GetResource(context.Background(), getResourceReq("Pod", "unrelated-5f-zz", logsScopeNamespace))
	require.Error(t, err)
	require.Zero(t, listsOf(typed, "events"), "an out-of-tree object must not have its events listed")

	_, err = srv.GetResource(context.Background(), getResourceReq("Pod", "api-7d9-x1", logsScopeNamespace))
	require.NoError(t, err)
	require.Equal(t, 1, listsOf(typed, "events"), "an in-tree object has its events listed once")
}

func TestGetResourceRedactsASecretInTheTree(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	msg := resp.Msg

	// Keys stay. The fixture's desired and live values differ, so the changed key
	// carries the differing marker on both sides, and the diff is not empty.
	require.Contains(t, msg.LiveManifest, "password:")
	require.Contains(t, msg.LiveManifest, liveDiffersValue)
	require.Contains(t, msg.DesiredManifest, "password:")
	require.Contains(t, msg.DesiredManifest, desiredDiffersValue)
	require.Contains(t, msg.Diff, desiredDiffersValue)
	require.Contains(t, msg.Diff, liveDiffersValue)
	// The response carries the object's annotations too, and kubectl keeps the
	// values in the last-applied annotation. Every field is checked.
	require.Contains(t, msg.Annotations[lastAppliedConfigAnnotation], redactedSecretValue)
	assertNoSecretValues(t, msg.String())
}

// A managed resource whose name is legal for its kind, but not a DNS-1123
// subdomain, is read like any other managed resource.
func TestGetResourceReturnsAManagedNameThatIsNotADNSSubdomain(t *testing.T) {
	t.Parallel()
	app := treeScopeApplication()
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "ClusterRole", Name: "shop:reader", Status: "Synced"})
	destination := append(treeScopeDestination(), &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: "shop:reader"}})
	srv, _ := treeScopeServer(t, app, destination)

	resp, err := srv.GetResource(context.Background(), getResourceReq("ClusterRole", "shop:reader", ""))
	require.NoError(t, err)
	require.Contains(t, resp.Msg.LiveManifest, "name: shop:reader")
}

// A managed pod that no longer exists keeps the application's view. Investigate
// still runs, with no logs, and does not fail.
func TestInvestigateManagedPodThatIsGoneRunsWithoutLogs(t *testing.T) {
	t.Parallel()
	app := treeScopeApplication()
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Pod", Name: "gone-0", Namespace: logsScopeNamespace, Status: "Synced"})
	srv, typed := treeScopeServer(t, app, treeScopeDestination())

	_, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         "Pod",
		ResourceName:         "gone-0",
		ResourceNamespace:    logsScopeNamespace,
	}))
	require.NoError(t, err)
	require.Zero(t, logReadsOf(typed))
}

// An application-level investigation names no resource. It reads nothing about a
// resource, and the detectors run on the application alone.
func TestInvestigateApplicationLevelReadsNoResource(t *testing.T) {
	t.Parallel()
	srv, typed := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
	}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)
	require.Zero(t, logReadsOf(typed))
	require.Zero(t, listsOf(typed, "events"))
}

// The application health view runs the application-level investigation. Its
// section must report an investigation, not an error.
func TestGetApplicationHealthInvestigationOverMCPIsNotAnError(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())
	client := treeScopeClient(t, srv)
	registry := mcp.NewRegistry()
	require.NoError(t, mcp.RegisterReadTools(registry))

	health, ok := registry.Lookup("get_application_health")
	require.True(t, ok)
	out, err := health.Invoke(context.Background(), client, json.RawMessage(`{
		"name":"shop-app","namespace":"platform","include_investigation":true}`))
	require.NoError(t, err)
	fields, ok := out.(map[string]any)
	require.True(t, ok)
	section, ok := fields["investigation"].(map[string]any)
	require.True(t, ok)
	require.NotEqual(t, "error", section["status"], "investigation section: %v", section)
}

// A managed resource the template does not render is still read from the
// destination. Only its desired manifest is absent.
func TestGetResourceKeepsALiveManagedObjectTheTemplateDoesNotRender(t *testing.T) {
	t.Parallel()
	app := treeScopeApplication()
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "ConfigMap", Name: "legacy-cfg", Namespace: logsScopeNamespace, Status: "Synced"})
	destination := append(treeScopeDestination(), &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "legacy-cfg", Namespace: logsScopeNamespace}})
	srv, _ := treeScopeServer(t, app, destination)

	resp, err := srv.GetResource(context.Background(), getResourceReq("ConfigMap", "legacy-cfg", logsScopeNamespace))
	require.NoError(t, err)
	require.Contains(t, resp.Msg.LiveManifest, "name: legacy-cfg")
	require.Empty(t, resp.Msg.DesiredManifest)
}

func TestGetResourceRefusesASecretOutsideTheTree(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "stray-creds", logsScopeNamespace))
	require.Nil(t, resp)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	assertNoSecretValues(t, err.Error())
}

// patchServer serves the destination for ApplyResourcePatch tests. The application
// lists the Deployment web as managed, and the destination holds it with the app's
// labels, next to labelled Deployments the tree does not hold.
func patchServer(t *testing.T, extra ...runtime.Object) (*PaprikaServer, *dynamicfake.FakeDynamicClient) {
	t.Helper()
	app := treeScopeApplication()
	app.Status.Resources = append(app.Status.Resources,
		pipelinesv1alpha1.ResourceSync{Kind: "Deployment", Name: "web", Namespace: logsScopeNamespace, Status: "Synced"})
	// The logs fixture has an unlabelled Deployment named web. The patch fixture
	// replaces it with the labelled one.
	var destination []runtime.Object
	for _, o := range treeScopeDestination() {
		if d, ok := o.(*appsv1.Deployment); ok && d.Name == "web" {
			continue
		}
		destination = append(destination, o)
	}
	destination = append(destination, patchDeployment("web", logsScopeNamespace, "shop-app"))
	destination = append(destination, extra...)
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "apps", Version: "v1"}})
	mapper.AddSpecific(
		schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"},
		schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"},
		schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployment"},
		meta.RESTScopeNamespace,
	)
	mapper.Add(corev1.SchemeGroupVersion.WithKind("Secret"), meta.RESTScopeNamespace)
	srv, _ := treeScopeServer(t, app, destination, WithRESTMapper(mapper))
	dyn, ok := srv.dynamicClient.(*dynamicfake.FakeDynamicClient)
	require.True(t, ok)
	return srv, dyn
}

// patchDeployment is a Deployment carrying the labels an application puts on its resources.
func patchDeployment(name, namespace, app string) *appsv1.Deployment {
	return &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace,
			Labels: map[string]string{"app.paprika.io/name": app, "app.paprika.io/managed-by": "paprika"}},
		Spec: appsv1.DeploymentSpec{Replicas: ptrInt32(1)},
	}
}

func ptrInt32(v int32) *int32 { return &v }

// patchRequest builds an ApplyResourcePatch request for a resource of the
// application. kind decides the group: Secrets are core, workloads are apps/v1.
// The "json" patch type copies a Secret value into an annotation, which is the
// copy case the refusal must cover.
func patchRequest(kind, name, namespace, patchType string, confirm bool) *connect.Request[paprikav1.ApplyResourcePatchRequest] {
	group := "apps"
	if kind == "Secret" {
		group = ""
	}
	pt := paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH
	patch := `{"spec":{"replicas":5}}`
	if patchType == "json" {
		pt = paprikav1.PatchType_PATCH_TYPE_JSON_PATCH
		patch = `[{"op":"copy","from":"/data/password","path":"/metadata/annotations/copied"}]`
	}
	return connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
		Namespace: "platform", Name: "shop-app", Group: group, Version: "v1", Kind: kind,
		ResourceName: name, ResourceNamespace: namespace, PatchType: pt, Patch: patch, Confirm: confirm,
	})
}

// patchVerbs counts the patch calls the destination served.
func patchVerbs(dyn *dynamicfake.FakeDynamicClient) int {
	count := 0
	for _, action := range dyn.Actions() {
		if action.GetVerb() == "patch" {
			count++
		}
	}
	return count
}

// A managed Deployment in the tree is patched, so the refusals below are the tree
// and label checks at work rather than a broken fixture.
func TestApplyResourcePatchAcceptsAManagedRootOfTheTree(t *testing.T) {
	t.Parallel()
	srv, _ := patchServer(t)
	for _, confirm := range []bool{false, true} {
		resp, err := srv.ApplyResourcePatch(context.Background(), patchRequest("Deployment", "web", logsScopeNamespace, "merge", confirm))
		require.NoError(t, err, "confirm=%v", confirm)
		require.Equal(t, confirm, resp.Msg.Applied)
		// A non-Secret dry-run preview is not redacted: its diff carries the patched field as written.
		if !confirm {
			require.Contains(t, resp.Msg.Diff, "replicas: 5")
		}
	}
}

// A labelled object the tree does not hold is refused for a dry run and for a
// confirmed patch, whether it sits in another namespace or in the same one. No
// patch is sent to the destination.
func TestApplyResourcePatchRefusesALabelledObjectOutsideTheTree(t *testing.T) {
	t.Parallel()
	srv, dyn := patchServer(t,
		patchDeployment("web", "tenant-b", "shop-app"),
		patchDeployment("unmanaged-web", logsScopeNamespace, "shop-app"),
	)
	for _, tc := range []struct{ name, namespace string }{
		{"web", "tenant-b"},
		{"unmanaged-web", logsScopeNamespace},
	} {
		for _, confirm := range []bool{false, true} {
			resp, err := srv.ApplyResourcePatch(context.Background(), patchRequest("Deployment", tc.name, tc.namespace, "merge", confirm))
			require.Nil(t, resp, "%s/%s confirm=%v", tc.namespace, tc.name, confirm)
			require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%s/%s confirm=%v", tc.namespace, tc.name, confirm)
		}
	}
	require.Zero(t, patchVerbs(dyn), "no out-of-tree object is patched")
}

// A Secret is refused for every patch type, dry run or confirmed, before any read.
// A JSON-patch copy from a Secret's value is one such patch.
func TestApplyResourcePatchRefusesASecret(t *testing.T) {
	t.Parallel()
	srv, dyn := patchServer(t)
	for _, patchType := range []string{"merge", "json"} {
		for _, confirm := range []bool{false, true} {
			resp, err := srv.ApplyResourcePatch(context.Background(), patchRequest("Secret", "shop-creds", logsScopeNamespace, patchType, confirm))
			require.Nil(t, resp, "%s confirm=%v", patchType, confirm)
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "%s confirm=%v", patchType, confirm)
			require.NotContains(t, err.Error(), treeScopeLiveValue)
		}
	}
	require.Zero(t, patchVerbs(dyn))
	for _, action := range dyn.Actions() {
		require.NotEqual(t, "secrets", action.GetResource().Resource, "a Secret is not read for a patch")
	}
}

func TestRenderRedactsSecretValues(t *testing.T) {
	t.Parallel()
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " +
		treeScopeDesiredValue + "\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n"
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	srv := NewPaprikaServer(fake.NewClientBuilder().WithScheme(scheme).Build(), nil,
		WithRenderer(&fakeRenderer{manifests: []byte(rendered)}))

	resp, err := srv.Render(context.Background(), connect.NewRequest(&paprikav1.RenderRequest{
		Type: "git", SpecJson: []byte("{}"), Namespace: "shop", Name: "shop-app",
	}))
	require.NoError(t, err)
	out := string(resp.Msg.Manifests)
	require.Contains(t, out, "password: <redacted>")
	require.Contains(t, out, "name: api", "documents other than Secrets are returned as rendered")
	require.NotContains(t, out, treeScopeDesiredValue)
}

// Each rendered shape keeps its Secret values out of the output. The documents
// around a Secret are kept, whatever the separator and line endings.
func TestRedactSecretManifestsCoversEveryDocumentShape(t *testing.T) {
	t.Parallel()
	secret := "kind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " + treeScopeDesiredValue + "\n"
	deployment := "kind: Deployment\nmetadata:\n  name: api\n"
	for _, tc := range []struct {
		name  string
		input string
		keeps []string
	}{
		{
			name:  "a List of Secrets",
			input: "kind: List\nitems:\n- " + strings.ReplaceAll(secret, "\n", "\n  ") + "\n",
			keeps: []string{"kind: List", "password: <redacted>"},
		},
		{
			name:  "a separator with a trailing space",
			input: secret + "--- \n" + deployment,
			keeps: []string{"name: api", "password: <redacted>"},
		},
		{
			name:  "a separator followed by a comment",
			input: secret + "--- # next document\n" + deployment,
			keeps: []string{"name: api", "password: <redacted>"},
		},
		{
			name:  "CRLF line endings",
			input: strings.ReplaceAll(secret+"---\n"+deployment, "\n", "\r\n"),
			keeps: []string{"name: api", "password: <redacted>"},
		},
		{
			name:  "a Secret before a document that follows it",
			input: secret + "---\n" + deployment + "---\nkind: ConfigMap\nmetadata:\n  name: cfg\n",
			keeps: []string{"name: api", "name: cfg", "password: <redacted>"},
		},
		{
			name:  "a Secret with numeric and boolean keys",
			input: "kind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  8443: " + treeScopeOddKeyValue + "\n  true: " + treeScopeOddKeyValue + "\n",
			keeps: []string{"<redacted>", "name: shop-creds"},
		},
		{
			name:  "a SecretList whose items have no kind",
			input: "kind: SecretList\nitems:\n- metadata:\n    name: shop-creds\n  stringData:\n    8443: " + treeScopeOddKeyValue + "\n",
			keeps: []string{"kind: SecretList", "<redacted>", "name: shop-creds"},
		},
		{
			name:  "a List with a Secret among other items",
			input: "kind: List\nitems:\n- kind: ConfigMap\n  metadata:\n    name: cfg\n- " + strings.ReplaceAll(secret, "\n", "\n  ") + "\n",
			keeps: []string{"name: cfg", "password: <redacted>"},
		},
		{
			name:  "a List whose ConfigMap item copies a Secret value",
			input: "kind: List\nitems:\n- " + strings.ReplaceAll(secret, "\n", "\n  ") + "\n- kind: ConfigMap\n  metadata:\n    name: cfg\n    annotations:\n      copied: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: cfg", "password: <redacted>"},
		},
		{
			name:  "a document that is not a Secret, with a duplicate key",
			input: "kind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  a: one\n  a: two\n---\n" + secret,
			keeps: []string{"name: cfg", "password: <redacted>"},
		},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.NoError(t, err, tc.name)
		require.NotContains(t, string(out), treeScopeDesiredValue, tc.name)
		require.NotContains(t, string(out), b64(treeScopeDesiredValue), tc.name)
		for _, want := range tc.keeps {
			require.Contains(t, string(out), want, tc.name)
		}
	}
}

func TestRedactSecretValuesKeepsKeysAndLeavesOtherKinds(t *testing.T) {
	t.Parallel()
	secret := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":        "creds",
			"annotations": map[string]any{lastAppliedConfigAnnotation: `{"data":{"a":"x"}}`, "keep": "me"},
		},
		"data":       map[string]any{"a": "eA=="},
		"stringData": map[string]any{"b": "plain"},
	}
	redactSecretValues(secret)
	require.Equal(t, map[string]any{"a": redactedSecretValue}, secret["data"])
	require.Equal(t, map[string]any{"b": redactedSecretValue}, secret["stringData"])
	meta, ok := secret["metadata"].(map[string]any)
	require.True(t, ok)
	annotations, ok := meta["annotations"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, redactedSecretValue, annotations[lastAppliedConfigAnnotation])
	require.Equal(t, "me", annotations["keep"])

	configMap := map[string]any{
		"kind": "ConfigMap",
		"data": map[string]any{"a": "visible"},
	}
	redactSecretValues(configMap)
	require.Equal(t, map[string]any{"a": "visible"}, configMap["data"])
}

func TestRedactSecretManifestsFailsWithoutQuotingAnUnreadableDocument(t *testing.T) {
	t.Parallel()
	broken := []byte("kind: Secret\nstringData:\n  password: " + treeScopeDesiredValue + "\n  bad: [\n")
	out, err := redactSecretManifests(broken)
	require.Error(t, err)
	require.Nil(t, out)
	require.NotContains(t, err.Error(), treeScopeDesiredValue)
}

func TestInvestigateOutsideTheTreeReadsNoLogsOrEvents(t *testing.T) {
	t.Parallel()
	srv, typed := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         "Pod",
		ResourceName:         "unrelated-5f-zz",
		ResourceNamespace:    logsScopeNamespace,
	}))
	require.Nil(t, resp)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	require.Equal(t, logsScopeOutsideMessage("Pod", logsScopeNamespace, "unrelated-5f-zz"), logsScopeMessage(t, err))
	require.Zero(t, logReadsOf(typed), "an out-of-tree pod's logs must not be read")
	require.Zero(t, listsOf(typed, "events"), "an out-of-tree pod's events must not be listed")
}

func TestInvestigateInTreePodReadsItsLogsAndEvents(t *testing.T) {
	t.Parallel()
	srv, typed := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	_, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         "Pod",
		ResourceName:         "api-7d9-x1",
		ResourceNamespace:    logsScopeNamespace,
	}))
	require.NoError(t, err)
	require.Equal(t, 1, logReadsOf(typed))
	require.Equal(t, 1, listsOf(typed, "events"))
	// The pod is read once, by the tree check. Its logs are read from that object.
	require.Zero(t, podObjectGetsOf(typed), "the pod object is not read again through the typed client")
}

// podObjectGetsOf counts the gets of pod objects, not of their logs, that a fake
// clientset served.
func podObjectGetsOf(cs *k8sfake.Clientset) int {
	count := 0
	for _, action := range cs.Actions() {
		if action.GetVerb() == "get" && action.GetResource().Resource == "pods" && action.GetSubresource() == "" {
			count++
		}
	}
	return count
}

func TestInvestigateRedactsSecretValuesInItsDiff(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())

	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         "Secret",
		ResourceName:         "shop-creds",
		ResourceNamespace:    logsScopeNamespace,
	}))
	require.NoError(t, err)
	// The desired and live Secrets differ in shape (stringData against data), so a
	// diff is built and reaches the config-drift finding.
	found := false
	for _, f := range resp.Msg.Findings {
		if f.Id == "config_drift_shop-creds" {
			found = true
		}
	}
	require.True(t, found, "expected a config drift finding for the Secret")
	assertNoSecretValues(t, resp.Msg.String())
}

func TestInvestigateOutsideTheTreeGetsNotFoundOverMCP(t *testing.T) {
	t.Parallel()
	srv, typed := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())
	client := treeScopeClient(t, srv)
	registry := mcp.NewRegistry()
	require.NoError(t, mcp.RegisterReadTools(registry))

	investigate, ok := registry.Lookup("investigate")
	require.True(t, ok)
	args := func(name string) json.RawMessage {
		return json.RawMessage(`{
		"application_namespace":"platform","application_name":"shop-app",
		"resource_kind":"Pod","resource_name":"` + name + `","resource_namespace":"shop"}`)
	}
	_, outside := investigate.Invoke(context.Background(), client, args("unrelated-5f-zz"))
	_, missing := investigate.Invoke(context.Background(), client, args("ghost"))
	var outsideErr, missingErr *connect.Error
	require.True(t, errors.As(outside, &outsideErr))
	require.True(t, errors.As(missing, &missingErr))
	require.Equal(t, connect.CodeNotFound, outsideErr.Code())
	require.Equal(t, missingErr.Code(), outsideErr.Code())
	// The message names the pod the caller asked for, and is otherwise the same
	// text the tree answer gives for any such pod.
	require.Equal(t, logsScopeOutsideMessage("Pod", logsScopeNamespace, "unrelated-5f-zz"), outsideErr.Message())
	require.Equal(t, logsScopeOutsideMessage("Pod", logsScopeNamespace, "ghost"), missingErr.Message())
	require.Zero(t, logReadsOf(typed), "no log of an outside pod is read")
	require.Zero(t, listsOf(typed, "events"), "no event of an outside pod is listed")

	logs, ok := registry.Lookup("get_logs")
	require.True(t, ok)
	_, err := logs.Invoke(context.Background(), client, json.RawMessage(`{
		"kind":"resource","tail_lines":20,"application_namespace":"platform","application_name":"shop-app",
		"resource_kind":"Pod","resource_name":"unrelated-5f-zz","resource_namespace":"shop"}`))
	var ce *connect.Error
	require.True(t, errors.As(err, &ce))
	require.Equal(t, connect.CodeNotFound, ce.Code())
	require.Zero(t, logReadsOf(typed))
}

func TestInvestigateRedactsSecretValuesOverMCP(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())
	client := treeScopeClient(t, srv)
	registry := mcp.NewRegistry()
	require.NoError(t, mcp.RegisterReadTools(registry))

	investigate, ok := registry.Lookup("investigate")
	require.True(t, ok)
	out, err := investigate.Invoke(context.Background(), client, json.RawMessage(`{
		"application_namespace":"platform","application_name":"shop-app",
		"resource_kind":"Secret","resource_name":"shop-creds","resource_namespace":"shop"}`))
	require.NoError(t, err)
	encoded, err := json.Marshal(out)
	require.NoError(t, err)
	assertNoSecretValues(t, string(encoded))
	require.True(t, strings.Contains(string(encoded), "config_drift_shop-creds"))
}

// treeScopeClient serves the server over connect, so MCP tools run their real request path.
func treeScopeClient(t *testing.T, srv *PaprikaServer) v1connect.PaprikaServiceClient {
	t.Helper()
	_, handler := v1connect.NewPaprikaServiceHandler(srv)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return v1connect.NewPaprikaServiceClient(ts.Client(), ts.URL)
}

// A rendered Secret with keys that YAML reads as a number and a boolean keeps its
// values out of Render, as it does for any other key.
func TestRenderRedactsSecretsWithNonStringKeys(t *testing.T) {
	t.Parallel()
	rendered := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  a: one\n  a: two\n---\n" + treeScopeOddKeyManifests
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	srv := NewPaprikaServer(fake.NewClientBuilder().WithScheme(scheme).Build(), nil,
		WithRenderer(&fakeRenderer{manifests: []byte(rendered)}))

	resp, err := srv.Render(context.Background(), connect.NewRequest(&paprikav1.RenderRequest{
		Type: "git", SpecJson: []byte("{}"), Namespace: "shop", Name: "shop-app",
	}))
	require.NoError(t, err, "a ConfigMap with a duplicate key must not fail the render")
	out := string(resp.Msg.Manifests)
	require.Contains(t, out, "name: cfg")
	require.Contains(t, out, "name: api")
	require.Contains(t, out, redactedSecretValue)
	assertNoSecretValues(t, out)
}

// The desired manifest of a managed Secret with non-string keys is redacted.
func TestGetResourceRedactsSecretsWithNonStringKeys(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination(),
		WithRenderer(&fakeRenderer{manifests: []byte(treeScopeOddKeyManifests)}))

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	require.Contains(t, resp.Msg.DesiredManifest, "password:")
	require.Contains(t, resp.Msg.DesiredManifest, desiredDiffersValue)
	require.Contains(t, resp.Msg.Diff, desiredDiffersValue)
	require.Contains(t, resp.Msg.Diff, liveDiffersValue)
	assertNoSecretValues(t, resp.Msg.String())
}

// A config-drift finding for a Secret with non-string keys carries no value.
func TestInvestigateRedactsSecretsWithNonStringKeys(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination(),
		WithRenderer(&fakeRenderer{manifests: []byte(treeScopeOddKeyManifests)}))

	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         "Secret",
		ResourceName:         "shop-creds",
		ResourceNamespace:    logsScopeNamespace,
	}))
	require.NoError(t, err)
	found := false
	for _, f := range resp.Msg.Findings {
		if f.Id == "config_drift_shop-creds" {
			found = true
		}
	}
	require.True(t, found, "expected a config drift finding for the Secret")
	assertNoSecretValues(t, resp.Msg.String())
}

// The MCP investigate tool carries the same redaction for a Secret with non-string keys.
func TestInvestigateRedactsSecretsWithNonStringKeysOverMCP(t *testing.T) {
	t.Parallel()
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination(),
		WithRenderer(&fakeRenderer{manifests: []byte(treeScopeOddKeyManifests)}))
	client := treeScopeClient(t, srv)
	registry := mcp.NewRegistry()
	require.NoError(t, mcp.RegisterReadTools(registry))

	investigate, ok := registry.Lookup("investigate")
	require.True(t, ok)
	out, err := investigate.Invoke(context.Background(), client, json.RawMessage(`{
		"application_namespace":"platform","application_name":"shop-app",
		"resource_kind":"Secret","resource_name":"shop-creds","resource_namespace":"shop"}`))
	require.NoError(t, err)
	encoded, err := json.Marshal(out)
	require.NoError(t, err)
	assertNoSecretValues(t, string(encoded))
	require.Contains(t, string(encoded), "config_drift_shop-creds")
}

// A kind no application tree can hold, such as a Secret that is not managed, is
// answered before the destination is read. Its listing and reads stay at zero.
func TestGetResourceReadsNothingForAnUnmanagedKindThatCannotBeInTheTree(t *testing.T) {
	t.Parallel()
	srv, typed := treeScopeServer(t, treeScopeApplication(), treeScopeDestination())
	dyn, ok := srv.dynamicClient.(*dynamicfake.FakeDynamicClient)
	require.True(t, ok)

	for _, tc := range []struct{ kind, name string }{
		{"Secret", "stray-creds"},
		{"Deployment", "unrelated"},
		{"Widget", "w-1"},
	} {
		_, err := srv.GetResource(context.Background(), getResourceReq(tc.kind, tc.name, logsScopeNamespace))
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "%s/%s", tc.kind, tc.name)
	}
	require.Empty(t, dyn.Actions(), "no live object of an unmanaged kind is read")
	require.Zero(t, listsOf(typed, "events"))
}

// shopCredsDestination is treeScopeDestination with shop-creds replaced: its data
// and annotations are the given ones, and it carries no last-applied annotation,
// so a desired Secret with the same values has an empty diff.
func shopCredsDestination(data map[string][]byte, annotations map[string]string) []runtime.Object {
	var out []runtime.Object
	for _, o := range treeScopeDestination() {
		if s, ok := o.(*corev1.Secret); ok && s.Name == "shop-creds" {
			out = append(out, &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "shop-creds", Namespace: logsScopeNamespace,
					Labels:      map[string]string{"app.paprika.io/name": "shop-app", "app.paprika.io/managed-by": "paprika"},
					Annotations: annotations},
				Data: data,
			})
			continue
		}
		out = append(out, o)
	}
	return out
}

// A managed Secret whose live values equal the desired values has no diff, and
// the drawer's "No differences" is correct for it.
func TestGetResourceGivesNoDiffForASecretWhoseValuesMatch(t *testing.T) {
	t.Parallel()
	// The desired Secret is written with data, as the live object is, and carries
	// the labels the live object has, so only a value could make a diff.
	desired := `apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  namespace: shop
  labels:
    app.paprika.io/name: shop-app
    app.paprika.io/managed-by: paprika
data:
  password: ` + b64(treeScopeDesiredValue) + `
`
	destination := shopCredsDestination(map[string][]byte{"password": []byte(treeScopeDesiredValue)}, nil)
	srv, _ := treeScopeServer(t, treeScopeApplication(), destination,
		WithRenderer(&fakeRenderer{manifests: []byte(desired)}))

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	require.Empty(t, resp.Msg.Diff, "a Secret whose values match has no diff: %s", resp.Msg.Diff)
	require.Contains(t, resp.Msg.DesiredManifest, redactedSecretValue)
	require.Contains(t, resp.Msg.LiveManifest, redactedSecretValue)
	assertNoSecretValues(t, resp.Msg.String())
}

// A value copied into an annotation, the way kapp keeps its original object, is
// redacted where it sits, in raw and base64 form.
func TestGetResourceRedactsASecretValueCopiedIntoAnAnnotation(t *testing.T) {
	t.Parallel()
	original := `{"kind":"Secret","data":{"password":"` + b64(treeScopeLiveValue) + `"},"stringData":{"token":"` + treeScopeLiveValue + `"}}`
	destination := shopCredsDestination(
		map[string][]byte{"password": []byte(treeScopeLiveValue)},
		map[string]string{
			"kapp.k14s.io/original": original,
			"copied-b64":            b64(treeScopeLiveValue),
			"owner":                 "team-a",
		})
	srv, _ := treeScopeServer(t, treeScopeApplication(), destination)

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	require.Equal(t, redactedSecretValue, resp.Msg.Annotations["kapp.k14s.io/original"])
	require.Equal(t, redactedSecretValue, resp.Msg.Annotations["copied-b64"])
	require.Equal(t, "team-a", resp.Msg.Annotations["owner"], "an annotation without a value is kept")
	assertNoSecretValues(t, resp.Msg.String())
}

// Render keeps the fields and comments of a Secret document, and redacts only its values.
func TestRenderKeepsTheFieldsAndCommentsOfASecret(t *testing.T) {
	t.Parallel()
	rendered := `# managed secret
apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  finalizers:
  - example.com/guard
  ownerReferences:
  - apiVersion: v1
    kind: ConfigMap
    name: owner
    uid: owner-uid
stringData:
  password: ` + treeScopeDesiredValue + `
`
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	srv := NewPaprikaServer(fake.NewClientBuilder().WithScheme(scheme).Build(), nil,
		WithRenderer(&fakeRenderer{manifests: []byte(rendered)}))

	resp, err := srv.Render(context.Background(), connect.NewRequest(&paprikav1.RenderRequest{
		Type: "git", SpecJson: []byte("{}"), Namespace: "shop", Name: "shop-app",
	}))
	require.NoError(t, err)
	out := string(resp.Msg.Manifests)
	require.Contains(t, out, "# managed secret")
	require.Contains(t, out, "example.com/guard")
	require.Contains(t, out, "ownerReferences:")
	require.Contains(t, out, "name: owner")
	require.Contains(t, out, "password: <redacted>")
	assertNoSecretValues(t, out)
}

// The values of a Secret in a List are kept out of the other items of the List.
func TestRenderKeepsASecretValueOutOfAListItemThatCopiesIt(t *testing.T) {
	t.Parallel()
	rendered := "kind: List\nitems:\n- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " +
		treeScopeDesiredValue + "\n- kind: ConfigMap\n  metadata:\n    name: cfg\n    annotations:\n      copied: " + treeScopeDesiredValue + "\n"
	out, err := redactSecretManifests([]byte(rendered))
	require.NoError(t, err)
	require.Contains(t, string(out), "name: cfg")
	require.Contains(t, string(out), "password: <redacted>")
	require.NotContains(t, string(out), treeScopeDesiredValue)
	require.NotContains(t, string(out), b64(treeScopeDesiredValue))
}

// Every shape the redaction does not recognise is replaced, not passed through.
func TestRedactSecretValuesFailsClosedOnUnexpectedShapes(t *testing.T) {
	t.Parallel()
	t.Run("data is not a map", func(t *testing.T) {
		secret := map[string]any{"kind": "Secret", "data": "c2VjcmV0"}
		redactSecretValues(secret)
		require.Equal(t, redactedSecretValue, secret["data"])
	})
	t.Run("a map keyed by any", func(t *testing.T) {
		secret := map[string]any{"kind": "Secret", "stringData": map[any]any{8443: "v", true: "w"}}
		redactSecretValues(secret)
		require.Equal(t, map[any]any{8443: redactedSecretValue, true: redactedSecretValue}, secret["stringData"])
	})
	t.Run("annotations are not a map", func(t *testing.T) {
		secret := map[string]any{"kind": "Secret", "metadata": map[string]any{"annotations": "v"}}
		redactSecretValues(secret)
		meta, ok := secret["metadata"].(map[string]any)
		require.True(t, ok)
		require.Equal(t, redactedSecretValue, meta["annotations"])
	})
	t.Run("a List whose items are not a list", func(t *testing.T) {
		list := map[string]any{"kind": "SecretList", "items": "v"}
		redactSecretValues(list)
		require.Equal(t, redactedSecretValue, list["items"])
	})
	t.Run("a SecretList item that is not a map", func(t *testing.T) {
		list := map[string]any{"kind": "SecretList", "items": []any{"v"}}
		redactSecretValues(list)
		require.Equal(t, []any{redactedSecretValue}, list["items"])
	})
}

// A diff between a desired and a live Secret marks only the keys whose values
// differ. The other keys keep the plain marker, and neither value shows.
func TestRedactManifestPairMarksOnlyChangedKeys(t *testing.T) {
	t.Parallel()
	desired := map[string]any{"kind": "Secret", "stringData": map[string]any{"same": "v1", "changed": "new"}}
	live := map[string]any{"kind": "Secret", "data": map[string]any{
		"same":    b64("v1"),
		"changed": b64("old"),
	}}
	redactManifestPair(desired, live)
	require.Equal(t, map[string]any{"same": redactedSecretValue, "changed": desiredDiffersValue}, desired["stringData"])
	require.Equal(t, map[string]any{"same": redactedSecretValue, "changed": liveDiffersValue}, live["data"])
}

// A key that exists on one side only is a change, so the Secret's diff is not empty.
func TestRedactManifestPairTreatsAKeyOnOneSideAsChanged(t *testing.T) {
	t.Parallel()
	desired := map[string]any{"kind": "Secret", "stringData": map[string]any{"added": "x"}}
	live := map[string]any{"kind": "Secret", "data": map[string]any{}}
	redactManifestPair(desired, live)
	require.Equal(t, map[string]any{"added": desiredDiffersValue}, desired["stringData"])
}
