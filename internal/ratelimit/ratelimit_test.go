package ratelimit

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLimiter_Allow(t *testing.T) {
	l := NewLimiter(10, 5) // 10 tokens/sec, burst of 5

	// Should allow 5 immediately (burst)
	for i := 0; i < 5; i++ {
		assert.True(t, l.Allow(), "iteration %d", i)
	}

	// 6th should fail (out of tokens)
	assert.False(t, l.Allow())

	// Wait for refill
	time.Sleep(200 * time.Millisecond)
	assert.True(t, l.Allow())
}

func TestLimiter_AllowN(t *testing.T) {
	l := NewLimiter(10, 10)

	assert.True(t, l.AllowN(5))
	assert.True(t, l.AllowN(5))
	assert.False(t, l.AllowN(1))
}

func TestLimiter_Tokens(t *testing.T) {
	l := NewLimiter(10, 5)

	assert.InDelta(t, 5.0, l.Tokens(), 0.1)
	l.Allow()
	assert.InDelta(t, 4.0, l.Tokens(), 0.1)
}

func TestLimiter_Wait(t *testing.T) {
	l := NewLimiter(100, 1) // 100 tokens/sec, burst of 1

	// Consume the burst
	assert.True(t, l.Allow())
	assert.False(t, l.Allow())

	// Wait should succeed after refill
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := l.Wait(ctx)
	require.NoError(t, err)
	assert.True(t, time.Since(start) > 5*time.Millisecond, "should have waited for refill")
}

func TestLimiter_Wait_ContextCancelled(t *testing.T) {
	l := NewLimiter(0.1, 0) // Very slow refill

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	err := l.Wait(ctx)
	assert.Error(t, err)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestManager_Get(t *testing.T) {
	m := NewManager(10, 5)

	l1 := m.Get("app1")
	l2 := m.Get("app1")
	assert.Equal(t, l1, l2, "should return same limiter for same key")

	l3 := m.Get("app2")
	assert.NotEqual(t, l1, l3, "should return different limiter for different key")
}

func TestManager_GetOrCreate(t *testing.T) {
	m := NewManager(10, 5)

	l1 := m.GetOrCreate("app1", 20, 10)
	assert.Equal(t, 10.0, l1.maxTokens)

	l2 := m.GetOrCreate("app1", 50, 25)
	assert.Equal(t, l1, l2, "should return existing limiter")
}

func TestManager_Keys(t *testing.T) {
	m := NewManager(10, 5)
	m.Get("app1")
	m.Get("app2")

	keys := m.Keys()
	assert.Len(t, keys, 2)
	assert.Contains(t, keys, "app1")
	assert.Contains(t, keys, "app2")
}

func TestManager_Remove(t *testing.T) {
	m := NewManager(10, 5)
	l1 := m.Get("app1")
	m.Remove("app1")
	l2 := m.Get("app1")
	assert.NotEqual(t, l1, l2, "should create new limiter after removal")
}

func TestGlobalLimiter(t *testing.T) {
	g := NewGlobalLimiter(10, 5)

	for i := 0; i < 5; i++ {
		assert.True(t, g.Allow())
	}
	assert.False(t, g.Allow())
}

func TestBackoff_Next(t *testing.T) {
	b := NewBackoff(100*time.Millisecond, 5*time.Second, 5)

	delay, maxed := b.Next()
	assert.False(t, maxed)
	// Jitter can make delay +/- 10%, so range is 90-110ms
	assert.True(t, delay >= 90*time.Millisecond, "delay %v should be >= 90ms", delay)
	assert.True(t, delay <= 110*time.Millisecond, "delay %v should be <= 110ms", delay)

	delay2, maxed := b.Next()
	assert.False(t, maxed)
	assert.True(t, delay2 > delay, "should increase")
}

func TestBackoff_MaxAttempts(t *testing.T) {
	b := NewBackoff(100*time.Millisecond, 1*time.Second, 3)

	for i := 0; i < 3; i++ {
		_, maxed := b.Next()
		assert.False(t, maxed)
	}

	_, maxed := b.Next()
	assert.True(t, maxed)
}

func TestBackoff_Reset(t *testing.T) {
	b := NewBackoff(100*time.Millisecond, 1*time.Second, 5)

	b.Next()
	b.Next()
	assert.Equal(t, 2, b.Attempt())

	b.Reset()
	assert.Equal(t, 0, b.Attempt())

	delay, _ := b.Next()
	assert.True(t, delay >= 90*time.Millisecond, "delay %v should be >= 90ms", delay)
	assert.True(t, delay <= 110*time.Millisecond, "delay %v should be <= 110ms", delay)
}

func TestControllerRateLimit(t *testing.T) {
	c := NewControllerRateLimit()

	assert.True(t, c.AllowGlobal())
	assert.True(t, c.AllowApp("app1"))
	assert.True(t, c.AllowSource("git:https://github.com/org/repo"))

	// App limiter should be independent
	appLim := c.AppLimiter("app1")
	assert.NotNil(t, appLim)

	srcLim := c.SourceLimiter("git:https://github.com/org/repo")
	assert.NotNil(t, srcLim)
}

func TestReconcileKey(t *testing.T) {
	assert.Equal(t, "default/my-app", ReconcileKey("default", "my-app"))
}

func TestSourceKey(t *testing.T) {
	assert.Equal(t, "git:https://github.com/org/repo", SourceKey("git", "https://github.com/org/repo"))
}
