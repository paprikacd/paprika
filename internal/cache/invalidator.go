package cache

import (
	"context"
	"fmt"
	"strings"
)

// Invalidator wraps a Cache and provides targeted invalidation by source key prefixes.
type Invalidator struct {
	cache Cache
}

// NewInvalidator creates an invalidator for the given cache.
func NewInvalidator(c Cache) *Invalidator {
	return &Invalidator{cache: c}
}

// Invalidate removes cache entries matching the source type and URL.
// For Redis it scans and deletes keys; for memory it iterates all keys.
func (i *Invalidator) Invalidate(ctx context.Context, sourceType, sourceURL, revision string) error {
	if i == nil || i.cache == nil {
		return nil
	}

	prefix := SourceCachePrefix + ":" + hashKey(sourceType+"|"+sourceURL)
	if revision != "" {
		prefix = ManifestCachePrefix + ":" + hashKey(sourceType+"|"+sourceURL+"|"+revision)
	}

	switch c := i.cache.(type) {
	case *RedisCache:
		return c.deleteByPrefix(ctx, prefix)
	case *MemoryCache:
		return c.deleteByPrefix(prefix)
	default:
		return fmt.Errorf("unsupported cache type for invalidation: %T", i.cache)
	}
}

func (c *RedisCache) deleteByPrefix(ctx context.Context, prefix string) error {
	iter := c.client.Scan(ctx, 0, prefix+"*", 1000).Iterator()
	for iter.Next(ctx) {
		if err := c.client.Del(ctx, iter.Val()).Err(); err != nil {
			return fmt.Errorf("redis del %s: %w", iter.Val(), err)
		}
	}
	if err := iter.Err(); err != nil {
		return fmt.Errorf("redis scan: %w", err)
	}
	return nil
}

func (c *MemoryCache) deleteByPrefix(prefix string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.items {
		if strings.HasPrefix(key, prefix) {
			delete(c.items, key)
		}
	}
	return nil
}
