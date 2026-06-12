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
)

// ManagedByLabelKey is the label key used to identify Paprika-managed resources.
const ManagedByLabelKey = "app.paprika.io/managed-by"

// ManagedByLabelValue is the label value indicating Paprika management.
const ManagedByLabelValue = "paprika"

// ApplicationNameLabelKey is the label key for the application name.
const ApplicationNameLabelKey = "app.paprika.io/name"

// ManagedBySelector returns a label selector for Paprika-managed resources.
func ManagedBySelector() labels.Selector {
	selector := labels.NewSelector()
	req, _ := labels.NewRequirement(ManagedByLabelKey, selection.Equals, []string{ManagedByLabelValue})
	selector = selector.Add(*req)
	return selector
}

// ManagedByAppSelector returns a label selector for resources managed for a specific application.
func ManagedByAppSelector(appName string) labels.Selector {
	selector := ManagedBySelector()
	req, _ := labels.NewRequirement(ApplicationNameLabelKey, selection.Equals, []string{appName})
	selector = selector.Add(*req)
	return selector
}

// ScalableDiffEngineImpl computes diffs efficiently using label selectors and targeted GVR queries.
// Unlike the basic DiffEngineImpl, it does not scan all resources in a namespace.
type ScalableDiffEngineImpl struct {
	DynClient dynamic.Interface
	liveCache *LiveResourceCache
}

// NewScalableDiffEngine creates a new ScalableDiffEngineImpl with the given dynamic client.
func NewScalableDiffEngine(dynClient dynamic.Interface) *ScalableDiffEngineImpl {
	return &ScalableDiffEngineImpl{
		DynClient: dynClient,
		liveCache: NewLiveResourceCache(dynClient),
	}
}

// SetLiveCache allows injecting a shared live resource cache.
func (d *ScalableDiffEngineImpl) SetLiveCache(c *LiveResourceCache) {
	d.liveCache = c
}

// ComputeDiff computes the diff between desired and live resources using label selectors.
// It only queries the GVRs present in the desired set, avoiding namespace-wide scans.
func (d *ScalableDiffEngineImpl) ComputeDiff(ctx context.Context, desired []unstructured.Unstructured, opts DiffOptions) (*DiffResult, error) {
	result := &DiffResult{}

	desiredMap := make(map[string]unstructured.Unstructured)
	gvrSet := make(map[schema.GroupVersionResource]struct{})
	for i := range desired {
		obj := &desired[i]
		if err := ensureManagedLabels(obj, opts); err != nil {
			return nil, fmt.Errorf("ensure managed labels: %w", err)
		}
		key := resourceKey(obj)
		desiredMap[key] = *obj
		if gvr, err := gvrForObject(obj); err == nil {
			gvrSet[gvr] = struct{}{}
		}
	}

	liveMap, err := d.fetchLiveResources(ctx, opts, gvrSet)
	if err != nil {
		return nil, fmt.Errorf("fetch live resources: %w", err)
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
			result.Deleted = append(result.Deleted, ResourceDiff{
				Kind:      liveObj.GetKind(),
				Name:      liveObj.GetName(),
				Namespace: liveObj.GetNamespace(),
				Action:    "Deleted",
			})
		}
	}

	result.Summary = fmt.Sprintf("+%d ~%d -%d", len(result.Added), len(result.Modified), len(result.Deleted))
	return result, nil
}

func (d *ScalableDiffEngineImpl) fetchLiveResources(ctx context.Context, opts DiffOptions, gvrSet map[schema.GroupVersionResource]struct{}) (map[string]unstructured.Unstructured, error) {
	result := make(map[string]unstructured.Unstructured)
	selector, err := labels.Parse(opts.LabelSelector)
	if err != nil {
		return nil, fmt.Errorf("parse label selector: %w", err)
	}

	for gvr := range gvrSet {
		var list *unstructured.UnstructuredList
		var err error
		if d.liveCache != nil {
			items, cacheErr := d.liveCache.Get(ctx, gvr, opts.Namespace, selector)
			if cacheErr == nil {
				list = &unstructured.UnstructuredList{Items: items}
			}
		}
		if list == nil {
			listOpts := metav1.ListOptions{
				LabelSelector: opts.LabelSelector,
				FieldSelector: opts.FieldSelector,
			}
			list, err = d.DynClient.Resource(gvr).Namespace(opts.Namespace).List(ctx, listOpts)
			if err != nil {
				continue
			}
		}
		for i := range list.Items {
			item := &list.Items[i]
			key := resourceKey(item)
			result[key] = *item
		}
	}

	return result, nil
}

func gvrForObject(obj *unstructured.Unstructured) (schema.GroupVersionResource, error) {
	apiVersion := obj.GetAPIVersion()
	kind := obj.GetKind()
	group, version := parseAPIVersion(apiVersion)

	if gvr, ok := knownGVRs[kind]; ok {
		return gvr, nil
	}

	if version == "" {
		return schema.GroupVersionResource{}, fmt.Errorf("cannot determine GVR for kind %s with apiVersion %s", kind, apiVersion)
	}

	resourceName := regularPlural(strings.ToLower(kind))
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resourceName}, nil
}

func ensureManagedLabels(obj *unstructured.Unstructured, opts DiffOptions) error {
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

// Ensure ScalableDiffEngineImpl implements DiffEngine at compile time.
var _ DiffEngine = (*ScalableDiffEngineImpl)(nil)
