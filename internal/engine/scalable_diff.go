package engine

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/selection"
	"k8s.io/client-go/dynamic"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/benebsworth/paprika/internal/engine/hooks"
)

// ManagedByLabelKey is the label key used to identify Paprika-managed resources.
const ManagedByLabelKey = "app.paprika.io/managed-by"

// ManagedByLabelValue is the label value indicating Paprika management.
const ManagedByLabelValue = "paprika"

// ApplicationNameLabelKey is the label key for the application name.
const ApplicationNameLabelKey = "app.paprika.io/name"

// ReleaseNameLabelKey links internal Paprika artifacts to their owning Release.
const ReleaseNameLabelKey = "app.paprika.io/release"

// ManagedBySelector returns a label selector for Paprika-managed resources.
func ManagedBySelector() labels.Selector {
	selector := labels.NewSelector()
	req, err := labels.NewRequirement(ManagedByLabelKey, selection.Equals, []string{ManagedByLabelValue})
	if err != nil {
		return labels.Nothing()
	}
	selector = selector.Add(*req)
	return selector
}

// ManagedByAppSelector returns a label selector for resources managed for a specific application.
func ManagedByAppSelector(appName string) labels.Selector {
	selector := ManagedBySelector()
	req, err := labels.NewRequirement(ApplicationNameLabelKey, selection.Equals, []string{appName})
	if err != nil {
		return selector
	}
	selector = selector.Add(*req)
	return selector
}

// ScalableDiffEngine computes diffs efficiently using label selectors and targeted GVR queries.
// Unlike the basic DiffEngine, it does not scan all resources in a namespace.
type ScalableDiffEngine struct {
	DynClient dynamic.Interface
	Resolver  GVRResolver
	liveCache *LiveResourceCache
}

// NewScalableDiffEngine creates a new ScalableDiffEngine with the given dynamic client.
func NewScalableDiffEngine(dynClient dynamic.Interface) *ScalableDiffEngine {
	return &ScalableDiffEngine{
		DynClient: dynClient,
		liveCache: NewLiveResourceCache(dynClient),
	}
}

// SetResolver injects a GVR resolver backed by the discovery API.
// If unset, gvrForObject falls back to static aliases and pluralization.
func (d *ScalableDiffEngine) SetResolver(r GVRResolver) {
	d.Resolver = r
}

// SetLiveCache allows injecting a shared live resource cache.
func (d *ScalableDiffEngine) SetLiveCache(c *LiveResourceCache) {
	d.liveCache = c
}

// Stop halts all informers maintained by the live cache.
func (d *ScalableDiffEngine) Stop() {
	if d.liveCache != nil {
		d.liveCache.Stop()
	}
}

// ComputeDiff computes the diff between desired and live resources using label selectors.
// It only queries the GVRs present in the desired set, avoiding namespace-wide scans.
func (d *ScalableDiffEngine) ComputeDiff(ctx context.Context, desired []unstructured.Unstructured, opts *DiffOptions) (*DiffResult, error) {
	result := &DiffResult{}

	desired = hooks.FilterHooks(desired)

	desiredMap := make(map[string]unstructured.Unstructured)
	gvrSet := make(map[schema.GroupVersionResource]struct{})
	gvrNamespaces := make(map[schema.GroupVersionResource]map[string]struct{})
	for i := range desired {
		obj := &desired[i]
		if err := ensureManagedLabels(obj, opts); err != nil {
			return nil, fmt.Errorf("ensure managed labels: %w", err)
		}
		key := resourceKey(obj)
		desiredMap[key] = *obj
		if gvr, err := gvrForObjectWithResolver(ctx, d.Resolver, obj); err == nil {
			gvrSet[gvr] = struct{}{}
			namespace := obj.GetNamespace()
			if isClusterScopedKind(obj.GetKind()) {
				namespace = ""
			} else if namespace == "" {
				namespace = opts.Namespace
			}
			if _, exists := gvrNamespaces[gvr]; !exists {
				gvrNamespaces[gvr] = make(map[string]struct{})
			}
			gvrNamespaces[gvr][namespace] = struct{}{}
		}
	}

	liveMap, err := d.fetchLiveResources(ctx, opts, gvrSet, gvrNamespaces)
	if err != nil {
		return nil, fmt.Errorf("fetch live resources: %w", err)
	}

	if len(opts.IgnoreDifferences) > 0 {
		ApplyIgnoreDifferences(desiredMap, liveMap, opts.IgnoreDifferences)
	}

	result = classifyDiffs(result, desiredMap, liveMap)

	result.Summary = fmt.Sprintf("+%d ~%d -%d", len(result.Added), len(result.Modified), len(result.Deleted))
	return result, nil
}

func classifyDiffs(result *DiffResult, desiredMap, liveMap map[string]unstructured.Unstructured) *DiffResult {
	desiredKinds := make(map[string]bool, len(desiredMap))
	for _, desiredObj := range desiredMap {
		desiredKinds[desiredObj.GetKind()] = true
	}

	for key, desiredObj := range desiredMap {
		liveObj, exists := liveMap[key]
		if !exists {
			result.Added = append(result.Added, ResourceDiff{
				Kind:      desiredObj.GetKind(),
				Name:      desiredObj.GetName(),
				Namespace: desiredObj.GetNamespace(),
				Action:    "Added",
			})
		} else if resourceEqual(desiredObj, liveObj) {
			result.Unchanged = append(result.Unchanged, ResourceDiff{
				Kind:      desiredObj.GetKind(),
				Name:      desiredObj.GetName(),
				Namespace: desiredObj.GetNamespace(),
				Action:    "Unchanged",
			})
		} else {
			result.Modified = append(result.Modified, ResourceDiff{
				Kind:      desiredObj.GetKind(),
				Name:      desiredObj.GetName(),
				Namespace: desiredObj.GetNamespace(),
				Action:    "Modified",
			})
		}
	}

	for key, liveObj := range liveMap {
		if _, exists := desiredMap[key]; !exists {
			if isGeneratedChildResource(&liveObj, desiredKinds) {
				continue
			}
			result.Deleted = append(result.Deleted, ResourceDiff{
				Kind:      liveObj.GetKind(),
				Name:      liveObj.GetName(),
				Namespace: liveObj.GetNamespace(),
				Action:    "Deleted",
			})
		}
	}

	return result
}

// isGeneratedChildResource reports whether a live-only resource is owned
// exclusively by kinds absent from the desired set. Controllers frequently
// copy Paprika management labels onto generated children (a Knative Route
// materializes an ExternalName Service from an applied Knative Service, for
// example); such children are neither drift nor prune candidates.
func isGeneratedChildResource(obj *unstructured.Unstructured, desiredKinds map[string]bool) bool {
	refs := obj.GetOwnerReferences()
	if len(refs) == 0 {
		return false
	}
	for _, ref := range refs {
		if desiredKinds[ref.Kind] {
			return false
		}
	}
	return true
}

func (d *ScalableDiffEngine) fetchLiveResources(ctx context.Context, opts *DiffOptions, gvrSet map[schema.GroupVersionResource]struct{}, gvrNamespaces map[schema.GroupVersionResource]map[string]struct{}) (map[string]unstructured.Unstructured, error) {
	result := make(map[string]unstructured.Unstructured)
	selector, err := labels.Parse(opts.LabelSelector)
	if err != nil {
		return nil, fmt.Errorf("parse label selector: %w", err)
	}

	for gvr := range gvrSet {
		for namespace := range gvrNamespaces[gvr] {
			var list *unstructured.UnstructuredList
			var err error
			var cacheErr error
			if d.liveCache != nil {
				var items []unstructured.Unstructured
				items, cacheErr = d.liveCache.Get(ctx, gvr, namespace, selector)
				if cacheErr == nil {
					list = &unstructured.UnstructuredList{Items: items}
				}
			}
			if list == nil {
				listOpts := metav1.ListOptions{
					LabelSelector: opts.LabelSelector,
					FieldSelector: opts.FieldSelector,
				}
				resource := d.DynClient.Resource(gvr)
				if namespace == "" {
					list, err = resource.List(ctx, listOpts)
				} else {
					list, err = resource.Namespace(namespace).List(ctx, listOpts)
				}
				if err != nil {
					if cacheErr != nil {
						log.FromContext(ctx).V(1).Info("Live cache and API both failed for GVR",
							"gvr", gvr, "namespace", namespace, "cacheErr", cacheErr, "apiErr", err)
					}
					continue
				}
			}
			for i := range list.Items {
				item := &list.Items[i]
				if shouldIgnoreLiveResource(item) {
					continue
				}
				key := resourceKey(item)
				result[key] = *item
			}
		}
	}

	return result, nil
}

func isClusterScopedKind(kind string) bool {
	switch kind {
	case "APIService", "ClusterRole", "ClusterRoleBinding", "CustomResourceDefinition", "GatewayClass", "Namespace", "Node", "PersistentVolume", "PriorityClass", "StorageClass", "ValidatingWebhookConfiguration", "MutatingWebhookConfiguration":
		return true
	default:
		return false
	}
}

func gvrForObject(obj *unstructured.Unstructured) (schema.GroupVersionResource, error) {
	return gvrForObjectWithResolver(context.Background(), nil, obj)
}

// gvrForObjectWithResolver resolves the GVR for an object, preferring the
// given resolver (discovery API) over static aliases and pluralization.
func gvrForObjectWithResolver(ctx context.Context, resolver GVRResolver, obj *unstructured.Unstructured) (schema.GroupVersionResource, error) {
	apiVersion := obj.GetAPIVersion()
	kind := obj.GetKind()
	group, version := parseAPIVersion(apiVersion)

	if resolver != nil {
		return resolver.Resolve(ctx, group, version, kind)
	}

	// Known kinds cover core resources and common aliases. Do not let a kind
	// alias override the API group from the manifest: Knative also defines a
	// Service, but it must resolve to serving.knative.dev/services.
	if group == "" {
		if gvr, ok := knownGVRs[kind]; ok {
			return gvr, nil
		}
	} else if gvr, ok := knownGVRs[kind]; ok && gvr.Group == group && gvr.Version == version {
		return gvr, nil
	}

	if version == "" {
		return schema.GroupVersionResource{}, fmt.Errorf("cannot determine GVR for kind %s with apiVersion %s", kind, apiVersion)
	}

	resourceName := regularPlural(strings.ToLower(kind))
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resourceName}, nil
}

func ensureManagedLabels(obj *unstructured.Unstructured, opts *DiffOptions) error {
	labels := obj.GetLabels()
	if labels == nil {
		labels = make(map[string]string)
	}
	labels[ManagedByLabelKey] = ManagedByLabelValue
	if opts.ApplicationName != "" {
		labels[ApplicationNameLabelKey] = opts.ApplicationName
	}
	obj.SetLabels(labels)
	return nil
}

var irregularPlurals = map[string]string{
	"ingress":             "ingresses",
	"class":               "classes",
	"poddisruptionbudget": "poddisruptionbudgets",
}

func regularPlural(s string) string {
	if p, ok := irregularPlurals[s]; ok {
		return p
	}
	if strings.HasSuffix(s, "s") || strings.HasSuffix(s, "x") || strings.HasSuffix(s, "ch") || strings.HasSuffix(s, "sh") {
		return s + "es"
	}
	if strings.HasSuffix(s, "y") && len(s) > 1 {
		vowels := "aeiou"
		if !strings.ContainsRune(vowels, rune(s[len(s)-2])) {
			return s[:len(s)-1] + "ies"
		}
	}
	return s + "s"
}
