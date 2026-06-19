package cache

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisCache implements Cache using Redis.
type RedisCache struct {
	client *redis.Client
}

// NewRedisCache creates a new Redis-backed cache.
func NewRedisCache(addr, password string, db int) (*RedisCache, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	return &RedisCache{client: client}, nil
}

// Get retrieves a value from Redis.
func (c *RedisCache) Get(ctx context.Context, key string) ([]byte, error) {
	val, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("redis get: %w", err)
	}
	return val, nil
}

// Set stores a value in Redis with the given TTL.
func (c *RedisCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if err := c.client.Set(ctx, key, value, ttl).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}
	return nil
}

// Delete removes a value from Redis.
func (c *RedisCache) Delete(ctx context.Context, key string) error {
	if err := c.client.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("redis del: %w", err)
	}
	return nil
}

// Ping checks connectivity to Redis.
func (c *RedisCache) Ping(ctx context.Context) error {
	if err := c.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis ping: %w", err)
	}
	return nil
}

// Close closes the Redis connection.
func (c *RedisCache) Close() error {
	if err := c.client.Close(); err != nil {
		return fmt.Errorf("redis close: %w", err)
	}
	return nil
}

// DeleteByPrefix removes all Redis entries whose key starts with prefix.
func (c *RedisCache) DeleteByPrefix(ctx context.Context, prefix string) error {
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

// Ensure RedisCache implements the fine-grained cache roles at compile time.
var (
	_ Getter        = (*RedisCache)(nil)
	_ Setter        = (*RedisCache)(nil)
	_ Deleter       = (*RedisCache)(nil)
	_ Pinger        = (*RedisCache)(nil)
	_ Closer        = (*RedisCache)(nil)
	_ PrefixDeleter = (*RedisCache)(nil)
)
