package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/clock"
)

const (
	defaultClientTTL        = 5 * time.Minute
	healthCheckInterval     = 30 * time.Second
	circuitBreakerThreshold = 5
	circuitBreakerReset     = 2 * time.Minute
)

// pooledClient wraps a dynamic client with metadata for caching and health tracking.
type pooledClient struct {
	client         dynamic.Interface
	restConfig     *rest.Config
	kubeconfigHash string
	createdAt      time.Time
	lastUsed       time.Time
	healthy        bool
	failures       int
	circuitOpen    bool
	circuitOpenAt  time.Time
}

// ClusterConnectionPool caches dynamic Kubernetes clients by kubeconfig hash.
// It provides connection reuse, health checks, and circuit breaker protection.
type ClusterConnectionPool struct {
	client        client.Client
	defaultConfig *rest.Config
	clients       map[string]*pooledClient
	mu            sync.RWMutex
	ttl           time.Duration
	Clock         clock.Clock
}

func (p *ClusterConnectionPool) now() time.Time {
	if p.Clock != nil {
		return p.Clock.Now()
	}
	return time.Now()
}

// NewClusterConnectionPoolWithContext creates a new ClusterConnectionPool bound to the
// provided context. The background health-check loop stops when ctx is cancelled.
func NewClusterConnectionPoolWithContext(ctx context.Context, c client.Client, defaultConfig *rest.Config) *ClusterConnectionPool {
	pool := &ClusterConnectionPool{
		client:        c,
		defaultConfig: defaultConfig,
		clients:       make(map[string]*pooledClient),
		ttl:           defaultClientTTL,
	}
	go pool.healthCheckLoop(ctx)
	return pool
}

// NewClusterConnectionPool creates a new ClusterConnectionPool with a lifecycle
// tied to the provided context. Prefer NewClusterConnectionPoolWithContext so
// the health-check loop stops when the parent context is cancelled.
//
// Deprecated: use NewClusterConnectionPoolWithContext.
func NewClusterConnectionPool(c client.Client, defaultConfig *rest.Config) *ClusterConnectionPool {
	return NewClusterConnectionPoolWithContext(context.Background(), c, defaultConfig)
}

// GetClient returns a dynamic client for the cluster described by the given kubeconfig secret.
// It caches clients by kubeconfig hash to enable connection reuse.
func (p *ClusterConnectionPool) GetClient(ctx context.Context, kubeconfigSecret, namespace string) (dynamic.Interface, error) {
	if kubeconfigSecret == "" {
		return p.getDefaultClient()
	}

	hash, err := p.kubeconfigHash(ctx, kubeconfigSecret, namespace)
	if err != nil {
		return nil, fmt.Errorf("compute kubeconfig hash: %w", err)
	}

	p.mu.RLock()
	pc, exists := p.clients[hash]
	p.mu.RUnlock()

	if exists && p.isValid(pc) {
		p.mu.Lock()
		if pc.circuitOpen {
			pc.circuitOpen = false
			pc.failures = 0
		}
		pc.lastUsed = p.now()
		p.mu.Unlock()
		return pc.client, nil
	}

	return p.createAndCacheClient(ctx, hash, kubeconfigSecret, namespace)
}

// GetRestConfig returns a REST config for the cluster described by the given kubeconfig secret.
func (p *ClusterConnectionPool) GetRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error) {
	if kubeconfigSecret == "" {
		return p.defaultConfig, nil
	}

	hash, err := p.kubeconfigHash(ctx, kubeconfigSecret, namespace)
	if err != nil {
		return nil, fmt.Errorf("compute kubeconfig hash: %w", err)
	}

	p.mu.RLock()
	pc, exists := p.clients[hash]
	p.mu.RUnlock()

	if exists {
		p.mu.RLock()
		valid := p.isValidLocked(pc)
		p.mu.RUnlock()
		if valid {
			return pc.restConfig, nil
		}
	}

	restConfig, err := p.buildRestConfig(ctx, kubeconfigSecret, namespace)
	if err != nil {
		return nil, fmt.Errorf("build rest config: %w", err)
	}
	return restConfig, nil
}

func (p *ClusterConnectionPool) getDefaultClient() (dynamic.Interface, error) {
	key := "default"
	p.mu.RLock()
	pc, exists := p.clients[key]
	valid := exists && p.isValidLocked(pc)
	p.mu.RUnlock()

	if valid {
		p.mu.Lock()
		if pc.circuitOpen {
			pc.circuitOpen = false
			pc.failures = 0
		}
		pc.lastUsed = p.now()
		p.mu.Unlock()
		return pc.client, nil
	}

	dynClient, err := dynamic.NewForConfig(p.defaultConfig)
	if err != nil {
		return nil, fmt.Errorf("create dynamic client from default config: %w", err)
	}

	p.mu.Lock()
	p.clients[key] = &pooledClient{
		client:     dynClient,
		restConfig: p.defaultConfig,
		createdAt:  p.now(),
		lastUsed:   p.now(),
		healthy:    true,
	}
	p.mu.Unlock()

	return dynClient, nil
}

func (p *ClusterConnectionPool) kubeconfigHash(ctx context.Context, kubeconfigSecret, namespace string) (string, error) {
	var secret corev1.Secret
	if err := p.client.Get(ctx, types.NamespacedName{Name: kubeconfigSecret, Namespace: namespace}, &secret); err != nil {
		return "", fmt.Errorf("get kubeconfig secret: %w", err)
	}

	kubeconfig, ok := secret.Data["kubeconfig"]
	if !ok {
		return "", errors.New("kubeconfig secret missing 'kubeconfig' key")
	}

	h := sha256.Sum256(kubeconfig)
	return hex.EncodeToString(h[:]), nil
}

func (p *ClusterConnectionPool) createAndCacheClient(ctx context.Context, hash, kubeconfigSecret, namespace string) (dynamic.Interface, error) {
	restConfig, err := p.buildRestConfig(ctx, kubeconfigSecret, namespace)
	if err != nil {
		return nil, err
	}

	dynClient, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("create dynamic client from rest config: %w", err)
	}

	pc := &pooledClient{
		client:         dynClient,
		restConfig:     restConfig,
		kubeconfigHash: hash,
		createdAt:      p.now(),
		lastUsed:       p.now(),
		healthy:        true,
	}

	p.mu.Lock()
	p.clients[hash] = pc
	p.mu.Unlock()

	return dynClient, nil
}

func (p *ClusterConnectionPool) buildRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error) {
	var secret corev1.Secret
	if err := p.client.Get(ctx, types.NamespacedName{Name: kubeconfigSecret, Namespace: namespace}, &secret); err != nil {
		return nil, fmt.Errorf("get kubeconfig secret: %w", err)
	}

	kubeconfig, ok := secret.Data["kubeconfig"]
	if !ok {
		return nil, errors.New("kubeconfig secret missing 'kubeconfig' key")
	}

	config, err := clientcmd.NewClientConfigFromBytes(kubeconfig)
	if err != nil {
		return nil, fmt.Errorf("parse kubeconfig: %w", err)
	}

	restConfig, err := config.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("build rest config: %w", err)
	}
	return restConfig, nil
}

func (p *ClusterConnectionPool) isValid(pc *pooledClient) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.isValidLocked(pc)
}

// isValidLocked checks client validity with the lock already held.
func (p *ClusterConnectionPool) isValidLocked(pc *pooledClient) bool {
	if pc == nil {
		return false
	}
	now := p.now()
	if pc.circuitOpen {
		return now.Sub(pc.circuitOpenAt) > circuitBreakerReset
	}
	if now.Sub(pc.lastUsed) > p.ttl {
		return false
	}
	return pc.healthy
}

func (p *ClusterConnectionPool) healthCheckLoop(ctx context.Context) {
	ticker := time.NewTicker(healthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.runHealthChecks(ctx)
			p.evictExpired()
		}
	}
}

func (p *ClusterConnectionPool) runHealthChecks(ctx context.Context) {
	type clientHealth struct {
		hash       string
		restConfig *rest.Config
		healthy    bool
		failures   int
	}

	p.mu.RLock()
	toCheck := make([]clientHealth, 0, len(p.clients))
	for hash, pc := range p.clients {
		if pc.kubeconfigHash == "" {
			continue
		}
		toCheck = append(toCheck, clientHealth{
			hash:       hash,
			restConfig: pc.restConfig,
			healthy:    pc.healthy,
			failures:   pc.failures,
		})
	}
	p.mu.RUnlock()

	results := make([]clientHealth, 0, len(toCheck))
	for _, ch := range toCheck {
		updated := clientHealth{hash: ch.hash, healthy: ch.healthy, failures: ch.failures}
		if ch.restConfig == nil {
			updated.healthy = false
			results = append(results, updated)
			continue
		}

		dynClient, err := dynamic.NewForConfig(ch.restConfig)
		if err != nil {
			updated.failures = ch.failures + 1
			results = append(results, updated)
			continue
		}

		healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err = dynClient.Resource(corev1.SchemeGroupVersion.WithResource("namespaces")).
			List(healthCtx, metav1.ListOptions{Limit: 1})
		cancel()
		if err != nil {
			updated.failures = ch.failures + 1
			updated.healthy = false
		} else {
			updated.failures = 0
			updated.healthy = true
		}
		results = append(results, updated)
	}

	p.mu.Lock()
	for _, res := range results {
		pc, ok := p.clients[res.hash]
		if !ok {
			continue
		}
		pc.healthy = res.healthy
		pc.failures = res.failures
		if res.failures >= circuitBreakerThreshold {
			pc.circuitOpen = true
			pc.circuitOpenAt = p.now()
		}
	}
	p.mu.Unlock()
}

func (p *ClusterConnectionPool) evictExpired() {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now()
	for key, pc := range p.clients {
		if key == "default" {
			continue
		}
		if now.Sub(pc.lastUsed) > p.ttl*2 {
			delete(p.clients, key)
		}
	}
}

// Ensure ClusterConnectionPool implements ClusterClientManager at compile time.
var _ ClusterClientManager = (*ClusterConnectionPool)(nil)
