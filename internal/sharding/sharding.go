// Package sharding provides controller sharding by namespace hash.
package sharding

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"strconv"
	"strings"
)

const (
	shardIDEnv    = "PAPRIKA_SHARD_ID"
	shardTotalEnv = "PAPRIKA_SHARD_TOTAL"
	podNameEnv    = "POD_NAME"
)

// Matcher is an optional strategy for namespace matching.
// When set on a Filter, it overrides the hash-based sharding logic.
type Matcher interface {
	Matches(namespace string) bool
}

// Filter determines whether a resource belongs to this controller shard.
type Filter struct {
	shardID     int
	totalShards int
	enabled     bool
	matcher     Matcher
}

// NewFilterFromEnv creates a shard filter from environment variables.
// If PAPRIKA_SHARD_TOTAL is unset or <= 1, sharding is disabled.
//
// Deprecated: read PAPRIKA_SHARD_* and POD_NAME in cmd/main and pass explicit
// values to NewFilter.
func NewFilterFromEnv(ctx context.Context) *Filter {
	_ = ctx // reserved for future cancellation/observability
	totalStr := os.Getenv(shardTotalEnv)
	if totalStr == "" {
		return &Filter{enabled: false}
	}

	total, err := strconv.Atoi(totalStr)
	if err != nil || total <= 1 {
		return &Filter{enabled: false}
	}

	idStr := os.Getenv(shardIDEnv)
	id, err := strconv.Atoi(idStr)
	if err != nil {
		// Support StatefulSet pod names like "controller-manager-0"
		id = extractOrdinalFromPodName(idStr)
	}
	if id < 0 || id >= total {
		return &Filter{enabled: false}
	}

	return &Filter{
		shardID:     id,
		totalShards: total,
		enabled:     true,
	}
}

// NewFilterFromEnvLegacy creates a shard filter from environment variables using
// a background context.
//
// Deprecated: use NewFilterFromEnv(ctx).
func NewFilterFromEnvLegacy() *Filter {
	return NewFilterFromEnv(context.Background())
}

// NewFilter creates a shard filter with explicit values.
func NewFilter(shardID, totalShards int) *Filter {
	if totalShards <= 1 || shardID < 0 || shardID >= totalShards {
		return &Filter{enabled: false}
	}
	return &Filter{
		shardID:     shardID,
		totalShards: totalShards,
		enabled:     true,
	}
}

// SetMatcher installs an optional matching strategy, overriding hash-based sharding.
func (f *Filter) SetMatcher(m Matcher) {
	f.matcher = m
}

// Matches returns true if the given namespace belongs to this shard.
func (f *Filter) Matches(namespace string) bool {
	if !f.enabled {
		return true
	}
	if f.matcher != nil {
		return f.matcher.Matches(namespace)
	}
	return hashNamespace(namespace)%f.totalShards == f.shardID
}

// Enabled returns whether sharding is active.
func (f *Filter) Enabled() bool {
	return f.enabled
}

// ShardID returns this controller's shard ID.
func (f *Filter) ShardID() int {
	return f.shardID
}

// TotalShards returns the total number of shards.
func (f *Filter) TotalShards() int {
	return f.totalShards
}

func hashNamespace(namespace string) int {
	h := fnv.New32a()
	if _, err := h.Write([]byte(namespace)); err != nil {
		// fnv.Hash32a.Write never returns an error in practice.
		return 0
	}
	return int(h.Sum32())
}

// extractOrdinalFromPodName extracts the numeric suffix from a StatefulSet pod name.
// E.g., "controller-manager-0" -> 0, "my-pod-5" -> 5.
func extractOrdinalFromPodName(name string) int {
	parts := strings.Split(name, "-")
	if len(parts) == 0 {
		return -1
	}
	ordinal, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		return -1
	}
	return ordinal
}

// ValidateShardEnv validates shard environment variables and returns an error if misconfigured.
func ValidateShardEnv() error {
	_, err := MustLoadFromEnvOrPod()
	if err != nil {
		return fmt.Errorf("validate shard environment: %w", err)
	}
	return nil
}

// MustLoadFromEnvOrPod creates a shard filter from explicit env vars or from the pod name.
// If PAPRIKA_SHARD_ID is unset and POD_NAME ends with an ordinal, the ordinal is used.
func MustLoadFromEnvOrPod() (*Filter, error) {
	idStr := os.Getenv(shardIDEnv)
	if idStr == "" {
		idStr = os.Getenv(podNameEnv)
	}
	totalStr := os.Getenv(shardTotalEnv)
	if totalStr == "" {
		return NewFilterFromEnv(context.Background()), nil
	}

	total, err := strconv.Atoi(totalStr)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", shardTotalEnv, err)
	}
	if total <= 1 {
		return NewFilterFromEnv(context.Background()), nil
	}

	id, err := strconv.Atoi(idStr)
	if err != nil {
		id = extractOrdinalFromPodName(idStr)
	}
	if id < 0 || id >= total {
		return nil, fmt.Errorf("shard ID %d out of range [0, %d)", id, total)
	}

	return NewFilter(id, total), nil
}
