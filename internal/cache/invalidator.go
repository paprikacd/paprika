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
// If revision is empty, all source and manifest entries for the URL are removed.
// If revision is non-empty, only the manifest entry for that exact revision is removed.
func (i *Invalidator) Invalidate(ctx context.Context, sourceType, sourceURL, revision string) error {
	if i == nil || i.cache == nil {
		return nil
	}

	sourcePrefix := sourceSourcePrefix(sourceType, sourceURL)
	if err := i.cache.DeleteByPrefix(ctx, sourcePrefix); err != nil {
		return fmt.Errorf("delete source cache entries by prefix: %w", err)
	}

	if revision == "" {
		manifestPrefix := manifestSourcePrefix(sourceType, sourceURL)
		if err := i.cache.DeleteByPrefix(ctx, manifestPrefix); err != nil {
			return fmt.Errorf("delete manifest cache entries by prefix: %w", err)
		}
		return nil
	}

	manifestPrefix := manifestSourcePrefix(sourceType, sourceURL) + ":" + hashKey(revision)
	if err := i.cache.DeleteByPrefix(ctx, manifestPrefix); err != nil {
		return fmt.Errorf("delete manifest cache entries by prefix: %w", err)
	}
	return nil
}
