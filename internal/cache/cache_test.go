package cache

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/clock"
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
	fake := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	c := NewMemoryCacheWithClock(fake)
	defer func() { _ = c.Close() }()

	require.NoError(t, c.Set(ctx, "key", []byte("value"), 50*time.Millisecond))
	val, err := c.Get(ctx, "key")
	require.NoError(t, err)
	require.Equal(t, []byte("value"), val)

	fake.Add(100 * time.Millisecond)

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

func TestInvalidatorDeletesManifestEntriesBySourceAndRevision(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := NewMemoryCache()
	defer func() { _ = c.Close() }()

	repo := "https://github.com/org/repo"
	rev1A := ManifestKey("git", repo, "rev1", map[string]string{"release-name": "app-a"})
	rev1B := ManifestKey("git", repo, "rev1", map[string]string{"release-name": "app-b"})
	rev2 := ManifestKey("git", repo, "rev2", map[string]string{"release-name": "app-a"})
	otherRepo := ManifestKey("git", "https://github.com/org/other", "rev1", map[string]string{"release-name": "app-a"})

	require.NoError(t, c.Set(ctx, rev1A, []byte("rev1-a"), time.Hour))
	require.NoError(t, c.Set(ctx, rev1B, []byte("rev1-b"), time.Hour))
	require.NoError(t, c.Set(ctx, rev2, []byte("rev2"), time.Hour))
	require.NoError(t, c.Set(ctx, otherRepo, []byte("other"), time.Hour))

	require.NoError(t, NewInvalidator(c).Invalidate(ctx, "git", repo, "rev1"))

	assertMissing(t, c, rev1A)
	assertMissing(t, c, rev1B)
	assertPresent(t, c, rev2)
	assertPresent(t, c, otherRepo)
}

func TestInvalidatorDeletesAllManifestEntriesForSource(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := NewMemoryCache()
	defer func() { _ = c.Close() }()

	repo := "https://github.com/org/repo"
	rev1 := ManifestKey("git", repo, "rev1", map[string]string{"release-name": "app"})
	rev2 := ManifestKey("git", repo, "rev2", map[string]string{"release-name": "app"})
	otherRepo := ManifestKey("git", "https://github.com/org/other", "rev1", map[string]string{"release-name": "app"})

	require.NoError(t, c.Set(ctx, rev1, []byte("rev1"), time.Hour))
	require.NoError(t, c.Set(ctx, rev2, []byte("rev2"), time.Hour))
	require.NoError(t, c.Set(ctx, otherRepo, []byte("other"), time.Hour))

	require.NoError(t, NewInvalidator(c).Invalidate(ctx, "git", repo, ""))

	assertMissing(t, c, rev1)
	assertMissing(t, c, rev2)
	assertPresent(t, c, otherRepo)
}

func TestMapHash(t *testing.T) {
	t.Parallel()

	h1 := mapHash(map[string]string{"b": "2", "a": "1"})
	h2 := mapHash(map[string]string{"a": "1", "b": "2"})
	require.Equal(t, h1, h2, "map hash should be order-independent")
}

func assertMissing(t *testing.T, c Getter, key string) {
	t.Helper()
	got, err := c.Get(context.Background(), key)
	require.NoError(t, err)
	require.Nil(t, got)
}

func assertPresent(t *testing.T, c Getter, key string) {
	t.Helper()
	got, err := c.Get(context.Background(), key)
	require.NoError(t, err)
	require.NotNil(t, got)
}
