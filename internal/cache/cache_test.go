package cache

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMemoryCache_GetSetDelete(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := NewMemoryCache()
	defer func() { _ = c.Close() }()

	// Get missing key returns nil.
	val, err := c.Get(ctx, "missing")
	require.NoError(t, err)
	require.Nil(t, val)

	// Set and get.
	require.NoError(t, c.Set(ctx, "key", []byte("value"), 0))
	val, err = c.Get(ctx, "key")
	require.NoError(t, err)
	require.Equal(t, []byte("value"), val)

	// Delete and verify missing.
	require.NoError(t, c.Delete(ctx, "key"))
	val, err = c.Get(ctx, "key")
	require.NoError(t, err)
	require.Nil(t, val)
}

func TestMemoryCache_TTL(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := NewMemoryCache()
	defer func() { _ = c.Close() }()

	require.NoError(t, c.Set(ctx, "key", []byte("value"), 50*time.Millisecond))
	val, err := c.Get(ctx, "key")
	require.NoError(t, err)
	require.Equal(t, []byte("value"), val)

	time.Sleep(100 * time.Millisecond)

	val, err = c.Get(ctx, "key")
	require.NoError(t, err)
	require.Nil(t, val)
}

func TestManifestKey(t *testing.T) {
	t.Parallel()

	k1 := ManifestKey("git", "https://github.com/org/repo", "main", map[string]string{"a": "1"})
	k2 := ManifestKey("git", "https://github.com/org/repo", "main", map[string]string{"a": "1"})
	k3 := ManifestKey("git", "https://github.com/org/repo", "main", map[string]string{"a": "2"})

	require.Equal(t, k1, k2, "same inputs should produce same key")
	require.NotEqual(t, k1, k3, "different params should produce different key")
	require.Contains(t, k1, ManifestCachePrefix)
}

func TestSourceKey(t *testing.T) {
	t.Parallel()

	k := SourceKey("git", "https://github.com/org/repo", "abc123")
	require.Contains(t, k, SourceCachePrefix)
}

func TestMapHash(t *testing.T) {
	t.Parallel()

	h1 := mapHash(map[string]string{"b": "2", "a": "1"})
	h2 := mapHash(map[string]string{"a": "1", "b": "2"})
	require.Equal(t, h1, h2, "map hash should be order-independent")
}
