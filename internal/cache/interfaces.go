// Package cache provides caching abstractions for Paprika.
package cache

import (
	"context"
	"time"
)

// Getter retrieves cached values.
type Getter interface {
	Get(ctx context.Context, key string) ([]byte, error)
}

// Setter stores values in the cache.
type Setter interface {
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

// Deleter removes values from the cache.
type Deleter interface {
	Delete(ctx context.Context, key string) error
}

// Pinger checks connectivity to the cache backend.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Closer closes the cache connection.
type Closer interface {
	Close() error
}

// PrefixDeleter removes all cache entries matching a key prefix.
type PrefixDeleter interface {
	DeleteByPrefix(ctx context.Context, prefix string) error
}

// cacheImpl is the union of the fine-grained cache roles. It is kept unexported
// so that callers depend on the smallest role interface practical instead of a
// single producer-side composed interface.
type cacheImpl interface {
	Getter
	Setter
	Deleter
	Pinger
	Closer
	PrefixDeleter
}

// Cache is a concrete key-value cache with TTL support. The exported methods
// are promoted from the embedded role interfaces, so consumers can define their
// own composed interfaces or depend on individual roles such as Getter,
// Setter, or PrefixDeleter.
type Cache struct {
	cacheImpl
}

//go:generate mockgen -destination=mocks/cache.go -package=mocks -typed . Getter,Setter,Deleter,Pinger,Closer,PrefixDeleter

// Key helpers for Paprika cache namespaces.
const (
	// ManifestCachePrefix is used for rendered manifest YAML.
	ManifestCachePrefix = "manifest"
	// SourceCachePrefix is used for source resolution results.
	SourceCachePrefix = "source"
)

// ManifestKey returns a cache key for a rendered manifest.
func ManifestKey(sourceType, sourceURL, revision string, params map[string]string) string {
	return manifestSourcePrefix(sourceType, sourceURL) + ":" + hashKey(revision) + ":" + hashKey(mapHash(params))
}

// SourceKey returns a cache key for a source resolution result.
func SourceKey(sourceType, sourceURL, revision string) string {
	return sourceSourcePrefix(sourceType, sourceURL) + ":" + hashKey(revision)
}

func manifestSourcePrefix(sourceType, sourceURL string) string {
	return ManifestCachePrefix + ":" + hashKey(sourceType+"|"+sourceURL)
}

func sourceSourcePrefix(sourceType, sourceURL string) string {
	return SourceCachePrefix + ":" + hashKey(sourceType+"|"+sourceURL)
}
