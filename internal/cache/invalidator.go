package cache

import (
	"context"
	"fmt"
)

// Invalidator wraps a cache and provides targeted invalidation by source key prefixes.
type Invalidator struct {
	cache PrefixDeleter
}

// NewInvalidator creates an invalidator for the given cache.
func NewInvalidator(c PrefixDeleter) *Invalidator {
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

	if err := i.cache.DeleteByPrefix(ctx, prefix); err != nil {
		return fmt.Errorf("delete cache entries by prefix: %w", err)
	}
	return nil
}
