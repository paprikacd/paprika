package engine

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// These cluster-wide configuration objects are commonly granted by name.
// Read only desired names, without creating LIST/WATCH informers. Stale objects
// of these kinds are not discovered as prune candidates by this path.
func usesNamedLiveRead(gvr schema.GroupVersionResource) bool {
	return (gvr.Group == "cloud.google.com" && gvr.Resource == "computeclasses") ||
		(gvr.Group == "scheduling.k8s.io" && gvr.Resource == "priorityclasses")
}

func (d *ScalableDiffEngine) fetchNamedLiveResources(ctx context.Context, opts *DiffOptions, refs map[schema.GroupVersionResource]map[string]struct{}, live map[string]unstructured.Unstructured) error {
	selector, err := labels.Parse(opts.LabelSelector)
	if err != nil {
		return fmt.Errorf("parse named resource selector: %w", err)
	}
	for gvr, names := range refs {
		for name := range names {
			obj, getErr := d.DynClient.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
			if apierrors.IsNotFound(getErr) {
				continue
			}
			if getErr != nil {
				return fmt.Errorf("read desired %s %q: %w", gvr.Resource, name, getErr)
			}
			if shouldIgnoreLiveResource(obj) || !selector.Matches(labels.Set(obj.GetLabels())) {
				continue
			}
			live[resourceKey(obj)] = *obj
		}
	}
	return nil
}
