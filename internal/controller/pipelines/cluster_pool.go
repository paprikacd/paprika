package controller

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
	client.Client
	defaultConfig *rest.Config
	clients       map[string]*pooledClient
	mu            sync.RWMutex
	ttl           time.Duration
}

// NewClusterConnectionPool creates a new ClusterConnectionPool.
func NewClusterConnectionPool(c client.Client, defaultConfig *rest.Config) *ClusterConnectionPool {
	pool := &ClusterConnectionPool{
		Client:        c,
		defaultConfig: defaultConfig,
		clients:       make(map[string]*pooledClient),
		ttl:           defaultClientTTL,
	}
	go pool.healthCheckLoop()
	return pool
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
		pc.lastUsed = time.Now()
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

	if exists && p.isValid(pc) {
		return pc.restConfig, nil
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
	p.mu.RUnlock()

	if exists && p.isValid(pc) {
		p.mu.Lock()
		pc.lastUsed = time.Now()
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
		createdAt:  time.Now(),
		lastUsed:   time.Now(),
		healthy:    true,
	}
	p.mu.Unlock()

	return dynClient, nil
}

func (p *ClusterConnectionPool) kubeconfigHash(ctx context.Context, kubeconfigSecret, namespace string) (string, error) {
	var secret corev1.Secret
	if err := p.Get(ctx, types.NamespacedName{Name: kubeconfigSecret, Namespace: namespace}, &secret); err != nil {
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
		createdAt:      time.Now(),
		lastUsed:       time.Now(),
		healthy:        true,
	}

	p.mu.Lock()
	p.clients[hash] = pc
	p.mu.Unlock()

	return dynClient, nil
}

func (p *ClusterConnectionPool) buildRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error) {
	var secret corev1.Secret
	if err := p.Get(ctx, types.NamespacedName{Name: kubeconfigSecret, Namespace: namespace}, &secret); err != nil {
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
	if pc == nil {
		return false
	}
	if pc.circuitOpen {
		if time.Since(pc.circuitOpenAt) > circuitBreakerReset {
			pc.circuitOpen = false
			pc.failures = 0
			return true
		}
		return false
	}
	if time.Since(pc.lastUsed) > p.ttl {
		return false
	}
	return pc.healthy
}

func (p *ClusterConnectionPool) healthCheckLoop() {
	ticker := time.NewTicker(healthCheckInterval)
	defer ticker.Stop()

	for range ticker.C {
		p.runHealthChecks()
		p.evictExpired()
	}
}

func (p *ClusterConnectionPool) runHealthChecks() {
	p.mu.Lock()
	defer p.mu.Unlock()

	for _, pc := range p.clients {
		if pc.kubeconfigHash == "" {
			continue
		}

		if pc.restConfig == nil {
			pc.healthy = false
			continue
		}

		dynClient, err := dynamic.NewForConfig(pc.restConfig)
		if err != nil {
			pc.failures++
			if pc.failures >= circuitBreakerThreshold {
				pc.circuitOpen = true
				pc.circuitOpenAt = time.Now()
			}
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, err = dynClient.Resource(corev1.SchemeGroupVersion.WithResource("namespaces")).
			List(ctx, metav1.ListOptions{Limit: 1})
		cancel()
		if err != nil {
			pc.failures++
			if pc.failures >= circuitBreakerThreshold {
				pc.circuitOpen = true
				pc.circuitOpenAt = time.Now()
			}
			pc.healthy = false
		} else {
			pc.failures = 0
			pc.healthy = true
		}
	}
}

func (p *ClusterConnectionPool) evictExpired() {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
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
