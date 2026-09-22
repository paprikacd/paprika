package engine

import (
	"context"
	"fmt"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/tools/cache"
)

// LiveResourceCache caches live cluster resources per GVR using shared informers.
type LiveResourceCache struct {
	mu        sync.RWMutex
	factories map[string]informers.GenericInformer
	stopChans map[string]chan struct{}
	// unsynced records GVRs whose informer could not sync, so that a second
	// caller does not pay the sync timeout again to reach the same conclusion.
	// The usual cause is RBAC: the factory watches every namespace, so a
	// controller granted a resource only in the namespaces it deploys to can
	// never establish this watch.
	unsynced     map[string]struct{}
	dynClient    dynamic.Interface
	resyncPeriod time.Duration
	// syncTimeout bounds the wait for a new informer's initial sync. It is a
	// field rather than a constant only so tests can reach the failure path
	// without waiting the full production timeout.
	syncTimeout time.Duration
}

// NewLiveResourceCache creates a cache for live resources.
func NewLiveResourceCache(dynClient dynamic.Interface) *LiveResourceCache {
	return &LiveResourceCache{
		factories:    make(map[string]informers.GenericInformer),
		stopChans:    make(map[string]chan struct{}),
		unsynced:     make(map[string]struct{}),
		dynClient:    dynClient,
		resyncPeriod: 10 * time.Minute,
		syncTimeout:  30 * time.Second,
	}
}

// Get returns live resources matching the selector for the given GVR and namespace.
//
// It returns an error rather than an empty result when the informer has not
// synced. The distinction is the whole point: an empty result means the cluster
// holds none of these, and callers act on that by creating them or reporting
// them missing. A cache that answers "none" when it simply does not know turns
// every resource of that kind into a phantom deletion.
func (c *LiveResourceCache) Get(ctx context.Context, gvr schema.GroupVersionResource, namespace string, selector labels.Selector) ([]unstructured.Unstructured, error) {
	informer, err := c.getInformer(ctx, gvr)
	if err != nil {
		return nil, err
	}
	lister := informer.Lister()

	var objs []runtime.Object
	if namespace == "" {
		objs, err = lister.List(selector)
	} else {
		objs, err = lister.ByNamespace(namespace).List(selector)
	}
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", gvr, err)
	}

	result := make([]unstructured.Unstructured, 0, len(objs))
	for _, obj := range objs {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		result = append(result, *u)
	}
	return result, nil
}

func (c *LiveResourceCache) getInformer(ctx context.Context, gvr schema.GroupVersionResource) (informers.GenericInformer, error) {
	key := gvr.String()

	c.mu.RLock()
	inf, ok := c.factories[key]
	_, failed := c.unsynced[key]
	c.mu.RUnlock()
	if failed {
		return nil, fmt.Errorf("informer for %s has not synced", gvr)
	}
	if ok {
		return inf, nil
	}

	c.mu.Lock()
	if _, failed := c.unsynced[key]; failed {
		c.mu.Unlock()
		return nil, fmt.Errorf("informer for %s has not synced", gvr)
	}
	inf, ok = c.factories[key]
	if ok {
		c.mu.Unlock()
		return inf, nil
	}

	factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(c.dynClient, c.resyncPeriod, metav1.NamespaceAll, nil)
	inf = factory.ForResource(gvr)
	stopCh := make(chan struct{})
	c.factories[key] = inf
	c.stopChans[key] = stopCh
	c.mu.Unlock()

	go inf.Informer().Run(stopCh)
	syncCtx, cancel := context.WithTimeout(ctx, c.syncTimeout)
	defer cancel()
	if !cache.WaitForCacheSync(syncCtx.Done(), inf.Informer().HasSynced) {
		// Tear it down rather than keep a store that will answer "none" to
		// every question. Recorded as unsynced so the next caller fails fast
		// instead of waiting out the timeout again, and falls back to the API.
		c.mu.Lock()
		close(stopCh)
		delete(c.factories, key)
		delete(c.stopChans, key)
		c.unsynced[key] = struct{}{}
		c.mu.Unlock()
		return nil, fmt.Errorf("informer for %s did not sync", gvr)
	}
	return inf, nil
}

// Stop halts all informers.
func (c *LiveResourceCache) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ch := range c.stopChans {
		close(ch)
	}
	c.stopChans = make(map[string]chan struct{})
	c.factories = make(map[string]informers.GenericInformer)
}
