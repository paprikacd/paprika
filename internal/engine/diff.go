package engine

import (
	"context"
	"fmt"
	"slices"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine/hooks"
)

// DiffResult contains the result of a diff between desired and live resources.
type DiffResult struct {
	Added     []ResourceDiff
	Modified  []ResourceDiff
	Deleted   []ResourceDiff
	Unchanged []ResourceDiff
	Summary   string
}

// ResourceDiff describes the diff for a single resource between desired and live state.
type ResourceDiff struct {
	Kind        string
	Name        string
	Namespace   string
	Action      string // Added, Modified, Deleted, Unchanged
	LiveHash    string
	DesiredHash string
}

// DiffOptions configures how ComputeDiff fetches live resources.
type DiffOptions struct {
	Namespace       string
	LabelSelector   string
	FieldSelector   string
	ApplicationName string
	// IgnoreDifferences lists JSON pointer paths to exclude from diff computation.
	IgnoreDifferences []pipelinesv1alpha1.IgnoreDiff
}

// DiffEngine computes diffs between desired and live Kubernetes resources.
type DiffEngine struct {
	DynClient *dynamic.DynamicClient
	Discovery discovery.DiscoveryInterface
}

// NewDiffEngine creates a new DiffEngine with the given dynamic client and discovery interface.
func NewDiffEngine(dynClient *dynamic.DynamicClient, discovery discovery.DiscoveryInterface) *DiffEngine {
	return &DiffEngine{
		DynClient: dynClient,
		Discovery: discovery,
	}
}

// ComputeDiff computes the diff between desired and live resources in the given namespace.
func (d *DiffEngine) ComputeDiff(ctx context.Context, desired []unstructured.Unstructured, opts *DiffOptions) (*DiffResult, error) {
	result := &DiffResult{}

	desired = hooks.FilterHooks(desired)

	desiredMap := make(map[string]unstructured.Unstructured)
	for _, obj := range desired {
		key := resourceKey(&obj)
		desiredMap[key] = obj
	}

	liveMap, err := d.fetchLiveResources(ctx, opts.Namespace)
	if err != nil {
		return nil, fmt.Errorf("fetch live resources: %w", err)
	}

	if len(opts.IgnoreDifferences) > 0 {
		ApplyIgnoreDifferences(desiredMap, liveMap, opts.IgnoreDifferences)
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
		} else {
			if resourceEqual(desiredObj, liveObj) {
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

func (d *DiffEngine) fetchLiveResources(ctx context.Context, namespace string) (map[string]unstructured.Unstructured, error) {
	result := make(map[string]unstructured.Unstructured)

	apiResources, err := d.Discovery.ServerPreferredResources()
	if err != nil {
		if !discovery.IsGroupDiscoveryFailedError(err) {
			return nil, fmt.Errorf("discover resources: %w", err)
		}
	}

	for _, apiResourceList := range apiResources {
		groupVersion, err := schema.ParseGroupVersion(apiResourceList.GroupVersion)
		if err != nil {
			continue
		}

		for i := range apiResourceList.APIResources {
			r := apiResourceList.APIResources[i]
			if !slices.Contains(r.Verbs, "list") {
				continue
			}
			gvr := schema.GroupVersionResource{
				Group:    groupVersion.Group,
				Version:  groupVersion.Version,
				Resource: r.Name,
			}
			list, err := d.DynClient.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{})
			if err != nil {
				continue
			}
			for i := range list.Items {
				item := &list.Items[i]
				if hooks.IsHook(item) {
					continue
				}
				key := resourceKey(item)
				result[key] = *item
			}
		}
	}

	return result, nil
}

func resourceKey(obj *unstructured.Unstructured) string {
	ns := obj.GetNamespace()
	if ns == "" {
		ns = "default"
	}
	return fmt.Sprintf("%s/%s/%s", obj.GetKind(), ns, obj.GetName())
}

func resourceEqual(a, b unstructured.Unstructured) bool {
	// Compare by generating a simplified hash of spec and metadata
	aSpec, _, err := unstructured.NestedMap(a.Object, "spec")
	if err != nil {
		return false
	}
	bSpec, _, err := unstructured.NestedMap(b.Object, "spec")
	if err != nil {
		return false
	}
	aMeta, _, err := unstructured.NestedMap(a.Object, "metadata")
	if err != nil {
		return false
	}
	bMeta, _, err := unstructured.NestedMap(b.Object, "metadata")
	if err != nil {
		return false
	}

	if !mapEqual(aSpec, bSpec) {
		return false
	}
	return mapEqual(aMeta, bMeta)
}

func mapEqual(a, b map[string]interface{}) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		bv, ok := b[k]
		if !ok {
			return false
		}
		// Simple comparison for now
		if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", bv) {
			return false
		}
	}
	return true
}

// ResourceSyncs converts the diff result into a flat list of resource sync statuses.
func (r *DiffResult) ResourceSyncs() []ResourceDiff {
	syncs := make([]ResourceDiff, 0, len(r.Added)+len(r.Modified)+len(r.Unchanged)+len(r.Deleted))
	for _, d := range r.Added {
		syncs = append(syncs, ResourceDiff{Kind: d.Kind, Name: d.Name, Namespace: d.Namespace, Action: "Missing"})
	}
	for _, d := range r.Modified {
		syncs = append(syncs, ResourceDiff{Kind: d.Kind, Name: d.Name, Namespace: d.Namespace, Action: "OutOfSync"})
	}
	for _, d := range r.Unchanged {
		syncs = append(syncs, ResourceDiff{Kind: d.Kind, Name: d.Name, Namespace: d.Namespace, Action: "Synced"})
	}
	for _, d := range r.Deleted {
		syncs = append(syncs, ResourceDiff{Kind: d.Kind, Name: d.Name, Namespace: d.Namespace, Action: "Pruned"})
	}
	return syncs
}

// HasDiff returns true if there are any added, modified, or deleted resources.
func (r *DiffResult) HasDiff() bool {
	return len(r.Added) > 0 || len(r.Modified) > 0 || len(r.Deleted) > 0
}

// OutOfSyncCount returns the total number of out-of-sync resources.
func (r *DiffResult) OutOfSyncCount() int {
	return len(r.Added) + len(r.Modified) + len(r.Deleted)
}
