package apiserver

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/pmezard/go-difflib/difflib"
	"gopkg.in/yaml.v3"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"

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

// GetResource returns detailed information about a single managed resource
// including its live manifest, desired manifest, unified diff, and recent
// Kubernetes events.
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
	s.populateLiveManifest(ctx, resp, req.Msg.ResourceKind, req.Msg.ResourceName, namespace)
	s.populateDesiredManifest(ctx, resp, &app, req.Msg.ResourceKind, req.Msg.ResourceName, namespace)
	s.populateEvents(ctx, resp, req.Msg.ResourceKind, req.Msg.ResourceName, namespace)

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

// populateLiveManifest fetches the live resource from the cluster and fills in LiveManifest.
func (s *PaprikaServer) populateLiveManifest(ctx context.Context, resp *paprikav1.GetResourceResponse, kind, name, namespace string) {
	if s.dynamicClient == nil {
		return
	}
	if live, err := s.getLiveManifest(ctx, kind, name, namespace); err == nil {
		resp.LiveManifest = live
	}
}

// populateDesiredManifest renders the application template and fills in DesiredManifest + Diff.
func (s *PaprikaServer) populateDesiredManifest(ctx context.Context, resp *paprikav1.GetResourceResponse, app *pipelinesv1alpha1.Application, kind, name, namespace string) {
	if s.renderer == nil {
		return
	}
	desired, err := s.getDesiredManifest(ctx, app, kind, name)
	if err != nil {
		return
	}
	resp.DesiredManifest = desired
	if resp.LiveManifest != "" {
		resp.Diff = unifiedDiff(desired, resp.LiveManifest)
	}
}

// populateEvents fetches Kubernetes events for the resource.
func (s *PaprikaServer) populateEvents(ctx context.Context, resp *paprikav1.GetResourceResponse, kind, name, namespace string) {
	if s.k8sClient == nil {
		return
	}
	resp.Events = s.getResourceEvents(ctx, kind, name, namespace)
}

func (s *PaprikaServer) getLiveManifest(ctx context.Context, kind, name, namespace string) (string, error) {
	gvr, ok := knownResourceGVRs[kind]
	if !ok {
		return "", fmt.Errorf("unknown kind %q", kind)
	}
	resource := s.dynamicClient.Resource(gvr)
	if gvr.Group == "" && gvr.Resource == "namespaces" {
		obj, err := resource.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return "", fmt.Errorf("get live %s/%s: %w", kind, name, err)
		}
		return manifestToYAML(obj.Object)
	}
	obj, err := resource.Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get live %s/%s/%s: %w", kind, namespace, name, err)
	}
	return manifestToYAML(obj.Object)
}

func (s *PaprikaServer) getDesiredManifest(ctx context.Context, app *pipelinesv1alpha1.Application, kind, name string) (string, error) {
	templateName := app.Name + "-template"
	var tmpl pipelinesv1alpha1.Template
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: templateName}, &tmpl); err != nil {
		return "", fmt.Errorf("get template: %w", err)
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
		return "", fmt.Errorf("render template: %w", err)
	}

	return findManifestDoc(manifests, kind, name)
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

// findManifestDoc searches split YAML documents for a resource matching kind + name.
func findManifestDoc(manifests []byte, kind, name string) (found string, err error) {
	docs := engine.SplitYAMLDocuments(manifests)
	for _, doc := range docs {
		var obj map[string]any
		if err := yaml.Unmarshal(doc, &obj); err != nil || obj == nil {
			continue
		}
		objKind, _ := obj["kind"].(string)          //nolint:errcheck // map value type check
		meta, _ := obj["metadata"].(map[string]any) //nolint:errcheck // map value type check
		objName, _ := meta["name"].(string)         //nolint:errcheck // map value type check
		if objKind == kind && objName == name {
			return manifestToYAML(obj)
		}
	}
	return "", fmt.Errorf("resource %s/%s not found in rendered manifests", kind, name)
}

func (s *PaprikaServer) getResourceEvents(ctx context.Context, kind, name, namespace string) []*paprikav1.KubernetesEvent {
	fieldSelector := fmt.Sprintf("involvedObject.kind=%s,involvedObject.name=%s", kind, name)
	if namespace != "" {
		fieldSelector = fmt.Sprintf("involvedObject.kind=%s,involvedObject.name=%s,involvedObject.namespace=%s", kind, name, namespace)
	}
	list, err := s.k8sClient.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
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
// into a cleaned YAML string with server-managed fields stripped.
func manifestToYAML(obj map[string]interface{}) (string, error) {
	cleanForSerialization(obj)
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(obj); err != nil {
		return "", fmt.Errorf("encode yaml: %w", err)
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("close yaml encoder: %w", err)
	}
	return strings.TrimSpace(buf.String()), nil
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
