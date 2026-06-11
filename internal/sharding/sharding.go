// Package sharding provides controller sharding by namespace hash.
package sharding

import (
	"fmt"
	"hash/fnv"
	"os"
	"strconv"
	"strings"
)

const (
	shardIDEnv    = "PAPRIKA_SHARD_ID"
	shardTotalEnv = "PAPRIKA_SHARD_TOTAL"
)

// Filter determines whether a resource belongs to this controller shard.
type Filter struct {
	shardID     int
	totalShards int
	enabled     bool
}

// NewFilterFromEnv creates a shard filter from environment variables.
// If PAPRIKA_SHARD_TOTAL is unset or <= 1, sharding is disabled.
func NewFilterFromEnv() *Filter {
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

// Matches returns true if the given namespace belongs to this shard.
func (f *Filter) Matches(namespace string) bool {
	if !f.enabled {
		return true
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
	_, _ = h.Write([]byte(namespace))
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
	totalStr := os.Getenv(shardTotalEnv)
	if totalStr == "" {
		return nil
	}

	total, err := strconv.Atoi(totalStr)
	if err != nil {
		return fmt.Errorf("invalid %s: %w", shardTotalEnv, err)
	}
	if total <= 1 {
		return nil
	}

	idStr := os.Getenv(shardIDEnv)
	id, err := strconv.Atoi(idStr)
	if err != nil {
		id = extractOrdinalFromPodName(idStr)
	}
	if id < 0 || id >= total {
		return fmt.Errorf("shard ID %d out of range [0, %d)", id, total)
	}

	return nil
}
