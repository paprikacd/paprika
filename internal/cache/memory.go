package cache

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/benebsworth/paprika/internal/clock"
)

// MemoryCache implements Cache with an in-memory map.
// This is suitable for local development and unit tests.
type MemoryCache struct {
	mu    sync.RWMutex
	items map[string]memoryItem
	clock clock.Clock
}

type memoryItem struct {
	value  []byte
	expiry time.Time
}

// NewMemoryCache creates a new in-memory cache.
func NewMemoryCache() *MemoryCache {
	return NewMemoryCacheWithClock(clock.Real{})
}

// NewMemoryCacheWithClock creates a new in-memory cache that uses the provided
// clock for TTL checks. A nil clock falls back to the real clock.
func NewMemoryCacheWithClock(c clock.Clock) *MemoryCache {
	if c == nil {
		c = clock.Real{}
	}
	return &MemoryCache{
		items: make(map[string]memoryItem),
		clock: c,
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
	if !item.expiry.IsZero() && c.clock.Now().After(item.expiry) {
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
		expiry = c.clock.Now().Add(ttl)
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

// DeleteByPrefix removes all in-memory entries whose key starts with prefix.
func (c *MemoryCache) DeleteByPrefix(_ context.Context, prefix string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.items {
		if strings.HasPrefix(key, prefix) {
			delete(c.items, key)
		}
	}
	return nil
}

// Ensure MemoryCache implements the fine-grained cache roles at compile time.
var (
	_ Getter        = (*MemoryCache)(nil)
	_ Setter        = (*MemoryCache)(nil)
	_ Deleter       = (*MemoryCache)(nil)
	_ Pinger        = (*MemoryCache)(nil)
	_ Closer        = (*MemoryCache)(nil)
	_ PrefixDeleter = (*MemoryCache)(nil)
)
