package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
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

// TestMemoryCache_GetDel covers the present/absent/expired cases required
// for GetDeleter (Fix round 2, Fold-in 2): a present key is returned AND
// removed, an absent key reports (nil, nil) rather than an error, and an
// expired-but-still-present key behaves exactly like an absent one.
func TestMemoryCache_GetDel(t *testing.T) {
	t.Parallel()

	ctx := context.Background()

	t.Run("present key is returned and removed", func(t *testing.T) {
		t.Parallel()
		c := NewMemoryCache()
		defer func() { _ = c.Close() }()

		require.NoError(t, c.Set(ctx, "key", []byte("value"), 0))

		val, err := c.GetDel(ctx, "key")
		require.NoError(t, err)
		require.Equal(t, []byte("value"), val)

		// A subsequent Get must see it gone.
		got, err := c.Get(ctx, "key")
		require.NoError(t, err)
		require.Nil(t, got)

		// As must a subsequent GetDel.
		got, err = c.GetDel(ctx, "key")
		require.NoError(t, err)
		require.Nil(t, got)
	})

	t.Run("absent key returns nil, nil", func(t *testing.T) {
		t.Parallel()
		c := NewMemoryCache()
		defer func() { _ = c.Close() }()

		val, err := c.GetDel(ctx, "never-set")
		require.NoError(t, err)
		require.Nil(t, val)
	})

	t.Run("expired key behaves as absent", func(t *testing.T) {
		t.Parallel()
		fake := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
		c := NewMemoryCacheWithClock(fake)
		defer func() { _ = c.Close() }()

		require.NoError(t, c.Set(ctx, "key", []byte("value"), 50*time.Millisecond))
		fake.Add(100 * time.Millisecond)

		val, err := c.GetDel(ctx, "key")
		require.NoError(t, err)
		require.Nil(t, val)
	})
}

// newTestRedisCache starts an in-process miniredis instance and a RedisCache
// wired to it, so RedisCache's behavior can be tested without a real Redis
// server. miniredis is already a project dependency (used by
// internal/coordinator's integration tests) but had not previously been
// used to exercise internal/cache directly.
func newTestRedisCache(t *testing.T) (*RedisCache, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)

	c, err := NewRedisCache(mr.Addr(), "", 0)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Close() })
	return c, mr
}

// TestRedisCache_GetDel is the Redis-backed counterpart to
// TestMemoryCache_GetDel (Fix round 2, Fold-in 2): the Redis path had no
// test coverage at all despite miniredis already being available.
func TestRedisCache_GetDel(t *testing.T) {
	t.Parallel()

	ctx := context.Background()

	t.Run("present key is returned and removed", func(t *testing.T) {
		t.Parallel()
		c, _ := newTestRedisCache(t)

		require.NoError(t, c.Set(ctx, "key", []byte("value"), 0))

		val, err := c.GetDel(ctx, "key")
		require.NoError(t, err)
		require.Equal(t, []byte("value"), val)

		got, err := c.Get(ctx, "key")
		require.NoError(t, err)
		require.Nil(t, got)

		got, err = c.GetDel(ctx, "key")
		require.NoError(t, err)
		require.Nil(t, got)
	})

	t.Run("absent key returns nil, nil", func(t *testing.T) {
		t.Parallel()
		c, _ := newTestRedisCache(t)

		val, err := c.GetDel(ctx, "never-set")
		require.NoError(t, err)
		require.Nil(t, val)
	})

	t.Run("expired key behaves as absent", func(t *testing.T) {
		t.Parallel()
		c, mr := newTestRedisCache(t)

		require.NoError(t, c.Set(ctx, "key", []byte("value"), 50*time.Millisecond))
		mr.FastForward(100 * time.Millisecond)

		val, err := c.GetDel(ctx, "key")
		require.NoError(t, err)
		require.Nil(t, val)
	})
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
