package cache

import (
	"context"
	"sync"
	"time"
)

// MemoryCache implements Cache with an in-memory map.
// This is suitable for local development and unit tests.
type MemoryCache struct {
	mu    sync.RWMutex
	items map[string]memoryItem
}

type memoryItem struct {
	value  []byte
	expiry time.Time
}

// NewMemoryCache creates a new in-memory cache.
func NewMemoryCache() *MemoryCache {
	return &MemoryCache{
		items: make(map[string]memoryItem),
	}
}

// Get retrieves a value from the in-memory cache.
func (c *MemoryCache) Get(ctx context.Context, key string) ([]byte, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	item, ok := c.items[key]
	if !ok {
		return nil, nil
	}
	if !item.expiry.IsZero() && time.Now().After(item.expiry) {
		return nil, nil
	}
	return item.value, nil
}

// Set stores a value in the in-memory cache.
func (c *MemoryCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	var expiry time.Time
	if ttl > 0 {
		expiry = time.Now().Add(ttl)
	}
	c.items[key] = memoryItem{value: value, expiry: expiry}
	return nil
}

// Delete removes a value from the in-memory cache.
func (c *MemoryCache) Delete(ctx context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.items, key)
	return nil
}

// Ping always succeeds for the in-memory cache.
func (c *MemoryCache) Ping(ctx context.Context) error {
	return nil
}

// Close is a no-op for the in-memory cache.
func (c *MemoryCache) Close() error {
	return nil
}

// Ensure MemoryCache implements Cache at compile time.
var _ Cache = (*MemoryCache)(nil)
