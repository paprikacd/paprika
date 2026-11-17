package apiserver

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/pmezard/go-difflib/difflib"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"
	k8syaml "sigs.k8s.io/yaml"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/engine"
)

// knownGVRs maps common Kubernetes kinds to their GroupVersionResource for
// dynamic client lookups. Falls back to discovery for unknown kinds.
var knownResourceGVRs = map[string]schema.GroupVersionResource{
	"Deployment":              {Group: "apps", Version: "v1", Resource: "deployments"},
	"StatefulSet":             {Group: "apps", Version: "v1", Resource: "statefulsets"},
	"DaemonSet":               {Group: "apps", Version: "v1", Resource: "daemonsets"},
	"ReplicaSet":              {Group: "apps", Version: "v1", Resource: "replicasets"},
	"Service":                 {Group: "", Version: "v1", Resource: "services"},
	"Pod":                     {Group: "", Version: "v1", Resource: "pods"},
	"ConfigMap":               {Group: "", Version: "v1", Resource: "configmaps"},
	"Secret":                  {Group: "", Version: "v1", Resource: "secrets"},
	"Namespace":               {Group: "", Version: "v1", Resource: "namespaces"},
	"ServiceAccount":          {Group: "", Version: "v1", Resource: "serviceaccounts"},
	"PersistentVolumeClaim":   {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
	"Ingress":                 {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
	"NetworkPolicy":           {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
	"Job":                     {Group: "batch", Version: "v1", Resource: "jobs"},
	"CronJob":                 {Group: "batch", Version: "v1", Resource: "cronjobs"},
	"HorizontalPodAutoscaler": {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
	"PodDisruptionBudget":     {Group: "policy", Version: "v1", Resource: "poddisruptionbudgets"},
	"Role":                    {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
	"RoleBinding":             {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
	"ClusterRole":             {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
	"ClusterRoleBinding":      {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
}

var clusterScopedResources = map[schema.GroupVersionResource]bool{
	{Group: "", Version: "v1", Resource: "namespaces"}:                                   true,
	{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"}:        true,
	{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"}: true,
}

type resolvedResourceMapping struct {
	gvr   schema.GroupVersionResource
	gvk   schema.GroupVersionKind
	scope meta.RESTScopeName
}

// GetResource returns detailed information about a resource in the application's
// resource tree: its live manifest, desired manifest, unified diff, and recent
// Kubernetes events. A resource outside the tree gets the same error as one that
// does not exist. Secret values are redacted in every manifest and diff.
func (s *PaprikaServer) GetResource(
	ctx context.Context,
	req *connect.Request[paprikav1.GetResourceRequest],
) (*connect.Response[paprikav1.GetResourceResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	namespace := req.Msg.ResourceNamespace
	if namespace == "" {
		namespace = app.Namespace
	}

	resp := &paprikav1.GetResourceResponse{
		Kind:      req.Msg.ResourceKind,
		Name:      req.Msg.ResourceName,
		Namespace: namespace,
	}

	populateResourceStatus(resp, &app)

	// The live half of this view belongs to the cluster the application is
	// deployed to. A target we cannot read yields the status and desired halves
	// without fabricating a live manifest from another cluster. The tree check
	// runs before the desired manifest is rendered and before any event is read.
	target, targetErr := s.applicationTargetCluster(ctx, &app)
	dyn := s.targetDynamicClientOrNil(ctx, target, targetErr)
	typed := s.targetTypedClientOrNil(ctx, target, targetErr)
	live, mapping, err := readTreeResource(ctx, &app, dyn, typed, targetMapper(s, target),
		req.Msg.ResourceKind, req.Msg.ResourceName, namespace)
	if err != nil {
		return nil, err
	}
	desired := s.desiredObjectOrNil(ctx, &app, req.Msg.ResourceKind, req.Msg.ResourceName)
	// Both sides are redacted together, before the identity copies the live
	// annotations, so a Secret whose values differ shows the same marker on each side.
	redactManifestPair(desired, liveObject(live))
	if live != nil {
		populateResourceIdentity(resp, live, &mapping)
	}
	resp.DesiredManifest, resp.LiveManifest = manifestsToYAML(desired, live)
	if resp.DesiredManifest != "" && resp.LiveManifest != "" {
		resp.Diff = unifiedDiff(resp.DesiredManifest, resp.LiveManifest)
	}
	s.populateEvents(ctx, typed, resp, req.Msg.ResourceKind, req.Msg.ResourceName, namespace)

	return connect.NewResponse(resp), nil
}

// populateResourceStatus fills in sync status and health from Application status arrays.
func populateResourceStatus(resp *paprikav1.GetResourceResponse, app *pipelinesv1alpha1.Application) {
	kind, name, namespace := resp.Kind, resp.Name, resp.Namespace
	resp.SyncStatus = findSyncStatus(app.Status.Resources, kind, name, namespace)
	resp.HealthStatus, resp.HealthMessage = findHealthStatus(app.Status.ResourceHealth, kind, name, namespace)
}

func findSyncStatus(resources []pipelinesv1alpha1.ResourceSync, kind, name, namespace string) string {
	for _, r := range resources {
		if r.Kind == kind && r.Name == name && (r.Namespace == namespace || r.Namespace == "") {
			return r.Status
		}
	}
	return ""
}

func findHealthStatus(healths []pipelinesv1alpha1.ResourceHealth, kind, name, namespace string) (health, message string) {
	for _, h := range healths {
		if h.Kind == kind && h.Name == name && (h.Namespace == namespace || h.Namespace == "") {
			return h.Health, h.Message
		}
	}
	return "", ""
}

// targetMapper returns the RESTMapper to resolve a kind against. Only the
// control plane's own cluster has one here: a remote target is resolved through
// the known-kind table, and an unknown kind is skipped rather than guessed with
// the wrong cluster's discovery data.
func targetMapper(s *PaprikaServer, target targetCluster) meta.RESTMapper {
	if target.key == "" {
		return s.restMapper
	}
	return nil
}

// liveObject returns the object map of a live object, or nil for no object.
func liveObject(live *unstructured.Unstructured) map[string]any {
	if live == nil {
		return nil
	}
	return live.Object
}

// manifestsToYAML encodes a desired and a live object for a response. A nil side
// gives "". Both objects must already be redacted.
func manifestsToYAML(desired map[string]any, live *unstructured.Unstructured) (desiredYAML, liveYAML string) {
	if desired != nil {
		if out, err := manifestToYAML(desired); err == nil {
			desiredYAML = out
		}
	}
	if live != nil {
		if out, err := manifestToYAML(live.Object); err == nil {
			liveYAML = out
		}
	}
	return desiredYAML, liveYAML
}

// populateEvents fetches Kubernetes events for the resource.
func (s *PaprikaServer) populateEvents(
	ctx context.Context,
	typed kubernetes.Interface,
	resp *paprikav1.GetResourceResponse,
	kind, name, namespace string,
) {
	if typed == nil {
		return
	}
	resp.Events = s.getResourceEvents(ctx, typed, kind, name, namespace)
}

func getLiveResource(
	ctx context.Context,
	dyn dynamic.Interface,
	mapper meta.RESTMapper,
	kind, name, namespace string,
) (*unstructured.Unstructured, resolvedResourceMapping, error) {
	mapping, err := resolveResourceMapping(mapper, kind)
	if err != nil {
		return nil, resolvedResourceMapping{}, err
	}

	resource := dyn.Resource(mapping.gvr)
	if mapping.scope == meta.RESTScopeNameRoot {
		obj, getErr := resource.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return nil, mapping, fmt.Errorf("get live %s/%s: %w", kind, name, getErr)
		}
		return obj, mapping, nil
	}
	obj, err := resource.Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, mapping, fmt.Errorf("get live %s/%s/%s: %w", kind, namespace, name, err)
	}
	return obj, mapping, nil
}

func resolveResourceMapping(mapper meta.RESTMapper, kind string) (resolvedResourceMapping, error) {
	if gvr, ok := knownResourceGVRs[kind]; ok {
		scope := meta.RESTScopeNameNamespace
		if clusterScopedResources[gvr] {
			scope = meta.RESTScopeNameRoot
		}
		return resolvedResourceMapping{
			gvr:   gvr,
			gvk:   schema.GroupVersionKind{Group: gvr.Group, Version: gvr.Version, Kind: kind},
			scope: scope,
		}, nil
	}
	if mapper == nil {
		return resolvedResourceMapping{}, fmt.Errorf("unknown kind %q", kind)
	}
	mapping, err := mapper.RESTMapping(schema.GroupKind{Kind: kind})
	if err == nil {
		return resolvedResourceMapping{
			gvr:   mapping.Resource,
			gvk:   mapping.GroupVersionKind,
			scope: mapping.Scope.Name(),
		}, nil
	}
	mapping, err = resolveResourceMappingByPlural(mapper, kind)
	if err != nil {
		return resolvedResourceMapping{}, fmt.Errorf("resolve kind %q: %w", kind, err)
	}
	return resolvedResourceMapping{
		gvr:   mapping.Resource,
		gvk:   mapping.GroupVersionKind,
		scope: mapping.Scope.Name(),
	}, nil
}

func resolveResourceMappingByPlural(mapper meta.RESTMapper, kind string) (*meta.RESTMapping, error) {
	if mapper == nil {
		return nil, errors.New("no REST mapper is configured for this target")
	}
	resourceName := kindToResourceName(kind)
	resources, err := mapper.ResourcesFor(schema.GroupVersionResource{Resource: resourceName})
	if err != nil {
		return nil, fmt.Errorf("resolve resource %q: %w", resourceName, err)
	}
	for _, gvr := range resources {
		gvks, err := mapper.KindsFor(gvr)
		if err != nil {
			continue
		}
		for _, gvk := range gvks {
			if gvk.Kind != kind {
				continue
			}
			mapping, err := mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
			if err == nil {
				return mapping, nil
			}
		}
	}
	return nil, fmt.Errorf("no REST mapping for resource %q", resourceName)
}

func kindToResourceName(kind string) string {
	if kind == "" {
		return ""
	}
	lower := strings.ToLower(kind)
	if strings.HasSuffix(lower, "s") {
		return lower + "es"
	}
	if strings.HasSuffix(lower, "y") {
		return strings.TrimSuffix(lower, "y") + "ies"
	}
	return lower + "s"
}

func populateResourceIdentity(resp *paprikav1.GetResourceResponse, obj *unstructured.Unstructured, mapping *resolvedResourceMapping) {
	resp.ApiVersion = mapping.gvk.GroupVersion().String()
	resp.Group = mapping.gvk.Group
	resp.Version = mapping.gvk.Version
	resp.Resource = mapping.gvr.Resource
	resp.Uid = string(obj.GetUID())
	resp.Labels = copyStringMap(obj.GetLabels())
	resp.Annotations = copyStringMap(obj.GetAnnotations())
	if resp.ApiVersion == "" {
		resp.ApiVersion = obj.GetAPIVersion()
	}
}

func copyStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// desiredObjectOrNil returns the object the application's template renders for
// kind and name. It returns nil when there is no renderer or no such object. The
// object is raw: callers redact it before they use it.
func (s *PaprikaServer) desiredObjectOrNil(ctx context.Context, app *pipelinesv1alpha1.Application, kind, name string) map[string]any {
	if s.renderer == nil {
		return nil
	}
	desired, err := s.getDesiredObject(ctx, app, kind, name)
	if err != nil {
		return nil
	}
	return desired
}

func (s *PaprikaServer) getDesiredObject(ctx context.Context, app *pipelinesv1alpha1.Application, kind, name string) (map[string]any, error) {
	templateName := app.Name + "-template"
	var tmpl pipelinesv1alpha1.Template
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: templateName}, &tmpl); err != nil {
		return nil, fmt.Errorf("get template: %w", err)
	}

	params := make(map[string]string, len(app.Spec.Parameters)+1)
	for k, v := range app.Spec.Parameters {
		params[k] = v
	}
	releaseName := app.Name + "-release"
	if app.Status.ReleaseRef != "" {
		releaseName = app.Status.ReleaseRef
	}
	s.mergeReleaseParams(ctx, app, releaseName, params)
	if _, ok := params["release-name"]; !ok {
		params["release-name"] = releaseName
	}

	manifests, err := s.renderer.Render(ctx, &tmpl, params)
	if err != nil {
		return nil, fmt.Errorf("render template: %w", err)
	}

	return findManifestObject(manifests, kind, name)
}

// mergeReleaseParams reads the active Release and merges its parameters into params.
func (s *PaprikaServer) mergeReleaseParams(ctx context.Context, app *pipelinesv1alpha1.Application, releaseName string, params map[string]string) {
	var activeRelease pipelinesv1alpha1.Release
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: releaseName}, &activeRelease); err == nil {
		for k, v := range activeRelease.Spec.Parameters {
			params[k] = v
		}
	}
}

// findManifestObject searches split YAML documents for a resource matching kind +
// name, and returns its decoded object. Documents are decoded with
// sigs.k8s.io/yaml, as the controller decodes them. The object is raw.
func findManifestObject(manifests []byte, kind, name string) (map[string]any, error) {
	docs := engine.SplitYAMLDocuments(manifests)
	for _, doc := range docs {
		var obj map[string]any
		if err := k8syaml.Unmarshal(doc, &obj); err != nil || obj == nil {
			continue
		}
		objKind, _ := obj["kind"].(string)          //nolint:errcheck // map value type check
		meta, _ := obj["metadata"].(map[string]any) //nolint:errcheck // map value type check
		objName, _ := meta["name"].(string)         //nolint:errcheck // map value type check
		if objKind == kind && objName == name {
			return obj, nil
		}
	}
	return nil, fmt.Errorf("resource %s/%s not found in rendered manifests", kind, name)
}

func (s *PaprikaServer) getResourceEvents(
	ctx context.Context,
	typed kubernetes.Interface,
	kind, name, namespace string,
) []*paprikav1.KubernetesEvent {
	fieldSelector := fmt.Sprintf("involvedObject.kind=%s,involvedObject.name=%s", kind, name)
	if namespace != "" {
		fieldSelector = fmt.Sprintf("involvedObject.kind=%s,involvedObject.name=%s,involvedObject.namespace=%s", kind, name, namespace)
	}
	list, err := typed.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: fieldSelector,
		Limit:         50,
	})
	if err != nil {
		return nil
	}
	events := make([]*paprikav1.KubernetesEvent, 0, len(list.Items))
	for i := range list.Items {
		e := &list.Items[i]
		events = append(events, &paprikav1.KubernetesEvent{
			Type:               e.Type,
			Reason:             e.Reason,
			Message:            e.Message,
			LastTimestamp:      e.LastTimestamp.Format("2006-01-02T15:04:05Z07:00"),
			Count:              int32(e.Count),
			InvolvedObjectKind: e.InvolvedObject.Kind,
			InvolvedObjectName: e.InvolvedObject.Name,
		})
	}
	return events
}

// manifestToYAML serialises a map (typically unstructured.Unstructured.Object)
// into a cleaned YAML string with server-managed fields stripped. Every manifest
// a client can receive, and every diff built from one, passes through here, so
// Secret values are redacted here.
func manifestToYAML(obj map[string]interface{}) (string, error) {
	redactSecretValues(obj)
	cleanForSerialization(obj)
	return encodeYAML(obj)
}

// cleanForSerialization removes server-managed fields that would clutter the
// manifest display (uid, resourceVersion, managedFields, etc.).
func cleanForSerialization(obj map[string]interface{}) {
	meta, ok := obj["metadata"].(map[string]interface{})
	if !ok {
		return
	}
	for _, key := range []string{
		"uid", "resourceVersion", "creationTimestamp", "generation",
		"managedFields", "selfLink", "ownerReferences", "finalizers",
	} {
		delete(meta, key)
	}
	if status, ok := obj["status"].(map[string]interface{}); ok && len(status) == 0 {
		delete(obj, "status")
	}
}

// unifiedDiff produces a unified diff between desired and live YAML manifests.
func unifiedDiff(desired, live string) string {
	diff := difflib.UnifiedDiff{
		A:        difflib.SplitLines(desired),
		B:        difflib.SplitLines(live),
		FromFile: "Desired",
		ToFile:   "Live",
		Context:  3,
	}
	result, err := difflib.GetUnifiedDiffString(diff)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(result)
}
