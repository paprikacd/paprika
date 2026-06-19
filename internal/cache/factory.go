package cache

import (
	"context"
	"fmt"
	"os"
)

// Cache backend identifiers.
const (
	backendRedis     = "redis"
	backendMemory    = "memory"
	defaultRedisAddr = "localhost:6379"

	BackendRedis  = backendRedis
	BackendMemory = backendMemory
)

// Config holds cache backend configuration.
type Config struct {
	// Backend is either BackendRedis or BackendMemory.
	Backend string
	// RedisAddr is the Redis server address (host:port).
	RedisAddr string
	// RedisPassword for Redis authentication.
	RedisPassword string
	// RedisDB is the Redis database number.
	RedisDB int
}

// NewFromEnv creates a cache from environment variables.
// PAPRIKA_CACHE_BACKEND=redis|memory (default: memory)
// PAPRIKA_REDIS_ADDR=host:port (default: localhost:6379)
// PAPRIKA_REDIS_PASSWORD
// PAPRIKA_REDIS_DB
//
// Deprecated: read cache environment variables in cmd/main and pass an explicit
// Config to New, then call Ping to verify connectivity.
func NewFromEnv(ctx context.Context) (*Cache, error) {
	cfg := Config{
		Backend:       os.Getenv("PAPRIKA_CACHE_BACKEND"),
		RedisAddr:     os.Getenv("PAPRIKA_REDIS_ADDR"),
		RedisPassword: os.Getenv("PAPRIKA_REDIS_PASSWORD"),
		RedisDB:       0,
	}
	if cfg.Backend == "" {
		cfg.Backend = backendMemory
	}
	if cfg.RedisAddr == "" {
		cfg.RedisAddr = defaultRedisAddr
	}
	c, err := New(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create cache from env: %w", err)
	}
	return c, nil
}

// NewFromEnvLegacy creates a cache from environment variables using a
// background context.
//
// Deprecated: use NewFromEnv(ctx).
func NewFromEnvLegacy() (*Cache, error) {
	return NewFromEnv(context.Background())
}

// New creates a cache based on the provided configuration.
// It does not verify connectivity; callers that need a ping should call Ping
// explicitly after construction.
func New(_ context.Context, cfg Config) (*Cache, error) {
	var impl cacheImpl
	switch cfg.Backend {
	case backendRedis:
		cache, err := NewRedisCache(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB)
		if err != nil {
			return nil, fmt.Errorf("create redis cache: %w", err)
		}
		impl = cache
	case BackendMemory:
		impl = NewMemoryCache()
	default:
		return nil, fmt.Errorf("unsupported cache backend: %s", cfg.Backend)
	}
	return &Cache{cacheImpl: impl}, nil
}

// Ping verifies connectivity to the cache backend.
func (c *Cache) Ping(ctx context.Context) error {
	if c == nil || c.cacheImpl == nil {
		return nil
	}
	if err := c.cacheImpl.Ping(ctx); err != nil {
		return fmt.Errorf("ping cache: %w", err)
	}
	return nil
}

// NewLegacy creates a cache using a background context.
//
// Deprecated: use New(ctx, cfg).
func NewLegacy(cfg Config) (*Cache, error) {
	return New(context.Background(), cfg)
}
