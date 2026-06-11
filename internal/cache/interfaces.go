// Package cache provides caching abstractions for Paprika.
package cache

import (
	"context"
	"time"
)

//go:generate mockgen -destination=mocks/cache.go -package=mocks . Cache

// Cache is a generic key-value cache with TTL support.
type Cache interface {
	// Get retrieves a value from the cache.
	Get(ctx context.Context, key string) ([]byte, error)
	// Set stores a value in the cache with an optional TTL.
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// Delete removes a value from the cache.
	Delete(ctx context.Context, key string) error
	// Ping checks connectivity to the cache backend.
	Ping(ctx context.Context) error
	// Close closes the cache connection.
	Close() error
}

// Key helpers for Paprika cache namespaces.
const (
	// ManifestCachePrefix is used for rendered manifest YAML.
	ManifestCachePrefix = "manifest"
	// SourceCachePrefix is used for source resolution results.
	SourceCachePrefix = "source"
)

// ManifestKey returns a cache key for a rendered manifest.
func ManifestKey(sourceType, sourceURL, revision string, params map[string]string) string {
	return ManifestCachePrefix + ":" + hashKey(sourceType+"|"+sourceURL+"|"+revision+"|"+mapHash(params))
}

// SourceKey returns a cache key for a source resolution result.
func SourceKey(sourceType, sourceURL, revision string) string {
	return SourceCachePrefix + ":" + hashKey(sourceType+"|"+sourceURL+"|"+revision)
}
