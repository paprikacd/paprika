package engine

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// GVRResolver resolves a GroupVersionKind to a GroupVersionResource.
type GVRResolver interface {
	Resolve(ctx context.Context, group, version, kind string) (schema.GroupVersionResource, error)
}

// CachedGVRResolver resolves GVRs using the Kubernetes discovery API with
// per-group-version caching. A static fast path covers well-known types so
// common resolutions never hit the API server. Results are cached for the
// lifetime of the resolver; CRDs installed after creation are visible on the
// next cache miss.
type CachedGVRResolver struct {
	discovery discovery.DiscoveryInterface

	// groupVersion -> map[kind]GroupVersionResource.
	//
	// A sync.Map rather than a guarded map because this is the access pattern
	// it exists for: one entry per GroupVersion — a set bounded by the API
	// surface of the cluster — written once on the first miss and then read on
	// every resource resolution thereafter. An RWMutex put every apply and
	// every diff across every reconcile behind one shared lock to read a value
	// that never changes again.
	//
	// The inner map is fully built before it is published and never mutated
	// afterwards, so readers need no lock of their own.
	cache sync.Map
}

// NewCachedGVRResolver creates a resolver backed by the given discovery client.
// The discovery client may be nil; in that case the resolver falls back to
// pluralization heuristics for unknown kinds.
func NewCachedGVRResolver(disc discovery.DiscoveryInterface) *CachedGVRResolver {
	return &CachedGVRResolver{discovery: disc}
}

// Resolve returns the GVR for the given group, version, and kind.
// It checks the static fast path first, then the discovery cache, then the
// discovery API, and finally falls back to pluralization heuristics.
// static aliases, then pluralisation. Each step needs the one before it to have
// missed, so the nesting is the order of preference rather than incidental.
//
//nolint:cyclop,nestif // fallback chain: cache, discovery, aliases, pluralise.
func (r *CachedGVRResolver) Resolve(ctx context.Context, group, version, kind string) (schema.GroupVersionResource, error) {
	// Fast path: static aliases for well-known types.
	if group == "" {
		if gvr, ok := knownGVRs[kind]; ok {
			return gvr, nil
		}
	} else if gvr, ok := knownGVRs[kind]; ok && gvr.Group == group && gvr.Version == version {
		return gvr, nil
	}

	if version == "" {
		return schema.GroupVersionResource{}, fmt.Errorf("cannot determine GVR for kind %s with empty version", kind)
	}

	// Check the discovery cache.
	gvKey := group + "/" + version
	if cached, ok := r.cache.Load(gvKey); ok {
		if kinds, isMap := cached.(map[string]schema.GroupVersionResource); isMap {
			if gvr, found := kinds[kind]; found {
				return gvr, nil
			}
		}
	}

	// Query the discovery API.
	if r.discovery != nil {
		resourceList, err := r.discovery.ServerResourcesForGroupVersion(gvKey)
		if err == nil {
			kinds := make(map[string]schema.GroupVersionResource, len(resourceList.APIResources))
			// Indexed rather than ranged by value: APIResource is 176 bytes and
			// this loop runs over every resource the server knows about.
			for i := range resourceList.APIResources {
				ar := &resourceList.APIResources[i]
				// Skip subresources (e.g. deployments/status).
				if strings.Contains(ar.Name, "/") {
					continue
				}
				kinds[ar.Kind] = schema.GroupVersionResource{
					Group:    group,
					Version:  version,
					Resource: ar.Name,
				}
			}
			// Two goroutines racing the same first miss both do the discovery
			// call and produce equivalent maps, so either may win.
			r.cache.Store(gvKey, kinds)
			if gvr, ok := kinds[kind]; ok {
				return gvr, nil
			}
		}
	}

	// Fallback: pluralization heuristic.
	resourceName := regularPlural(strings.ToLower(kind))
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resourceName}, nil
}
