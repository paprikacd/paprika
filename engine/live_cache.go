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
	mu           sync.RWMutex
	factories    map[string]informers.GenericInformer
	stopChans    map[string]chan struct{}
	dynClient    dynamic.Interface
	resyncPeriod time.Duration
}

// NewLiveResourceCache creates a cache for live resources.
func NewLiveResourceCache(dynClient dynamic.Interface) *LiveResourceCache {
	return &LiveResourceCache{
		factories:    make(map[string]informers.GenericInformer),
		stopChans:    make(map[string]chan struct{}),
		dynClient:    dynClient,
		resyncPeriod: 10 * time.Minute,
	}
}

// Get returns live resources matching the selector for the given GVR and namespace.
func (c *LiveResourceCache) Get(ctx context.Context, gvr schema.GroupVersionResource, namespace string, selector labels.Selector) ([]unstructured.Unstructured, error) {
	informer := c.getInformer(gvr)
	lister := informer.Lister()

	var objs []runtime.Object
	var err error
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

func (c *LiveResourceCache) getInformer(gvr schema.GroupVersionResource) informers.GenericInformer {
	key := gvr.String()

	c.mu.RLock()
	inf, ok := c.factories[key]
	c.mu.RUnlock()
	if ok {
		return inf
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.factories[key]; ok {
		return existing
	}

	factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(c.dynClient, c.resyncPeriod, metav1.NamespaceAll, nil)
	inf = factory.ForResource(gvr)
	stopCh := make(chan struct{})
	c.factories[key] = inf
	c.stopChans[key] = stopCh
	go inf.Informer().Run(stopCh)
	syncCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = cache.WaitForCacheSync(syncCtx.Done(), inf.Informer().HasSynced)
	return inf
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
