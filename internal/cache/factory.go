package cache

import (
	"context"
	"fmt"
	"os"
	"time"
)

// Config holds cache backend configuration.
type Config struct {
	// Backend is either "redis" or "memory".
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
func NewFromEnv() (Cache, error) {
	cfg := Config{
		Backend:       os.Getenv("PAPRIKA_CACHE_BACKEND"),
		RedisAddr:     os.Getenv("PAPRIKA_REDIS_ADDR"),
		RedisPassword: os.Getenv("PAPRIKA_REDIS_PASSWORD"),
		RedisDB:       0,
	}
	if cfg.Backend == "" {
		cfg.Backend = "memory"
	}
	if cfg.RedisAddr == "" {
		cfg.RedisAddr = "localhost:6379"
	}
	return New(cfg)
}

// New creates a cache based on the provided configuration.
func New(cfg Config) (Cache, error) {
	switch cfg.Backend {
	case "redis":
		cache, err := NewRedisCache(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB)
		if err != nil {
			return nil, fmt.Errorf("create redis cache: %w", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := cache.Ping(ctx); err != nil {
			_ = cache.Close()
			return nil, fmt.Errorf("redis ping failed: %w", err)
		}
		return cache, nil
	case "memory":
		return NewMemoryCache(), nil
	default:
		return nil, fmt.Errorf("unsupported cache backend: %s", cfg.Backend)
	}
}
