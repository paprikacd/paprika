// Package ratelimit provides production-grade rate limiting for controllers and API handlers.
package ratelimit

import (
	"context"
	"crypto/rand"
	"fmt"
	"math"
	"math/big"
	"sync"
	"time"

	"github.com/benebsworth/paprika/internal/clock"
)

// Limiter is a token bucket rate limiter.
type Limiter struct {
	mu         sync.Mutex
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
	clock      clock.Clock
}

// NewLimiter creates a new token bucket rate limiter.
func NewLimiter(rate float64, burst int) *Limiter {
	return NewLimiterWithClock(rate, burst, clock.Real{})
}

// NewLimiterWithClock creates a limiter that uses the provided clock instead of
// the system clock. A nil clock falls back to the real clock.
func NewLimiterWithClock(rate float64, burst int, c clock.Clock) *Limiter {
	if c == nil {
		c = clock.Real{}
	}
	return &Limiter{
		tokens:     float64(burst),
		maxTokens:  float64(burst),
		refillRate: rate,
		lastRefill: c.Now(),
		clock:      c,
	}
}

// Allow returns true if a single token is available.
func (l *Limiter) Allow() bool {
	return l.AllowN(1)
}

// AllowN returns true if n tokens are available.
func (l *Limiter) AllowN(n int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.refill()
	if l.tokens >= float64(n) {
		l.tokens -= float64(n)
		return true
	}
	return false
}

// Wait blocks until a token is available or context is cancelled.
func (l *Limiter) Wait(ctx context.Context) error {
	return l.WaitN(ctx, 1)
}

// WaitN blocks until n tokens are available or context is cancelled.
func (l *Limiter) WaitN(ctx context.Context, n int) error {
	for {
		if l.AllowN(n) {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for rate limiter: %w", ctx.Err())
		case <-time.After(l.delayForN(n)):
		}
	}
}

// Tokens returns current available tokens.
func (l *Limiter) Tokens() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refill()
	return l.tokens
}

func (l *Limiter) refill() {
	now := l.clock.Now()
	elapsed := now.Sub(l.lastRefill).Seconds()
	l.tokens = math.Min(l.maxTokens, l.tokens+elapsed*l.refillRate)
	l.lastRefill = now
}

func (l *Limiter) delayForN(n int) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.refill()
	needed := float64(n) - l.tokens
	if needed <= 0 {
		return 0
	}
	return time.Duration(math.Ceil(needed/l.refillRate*1000)) * time.Millisecond
}

// Manager manages multiple named rate limiters.
type Manager struct {
	mu           sync.RWMutex
	limiters     map[string]*Limiter
	defaultRate  float64
	defaultBurst int
	clock        clock.Clock
}

// NewManager creates a new rate limit manager with default settings.
func NewManager(defaultRate float64, defaultBurst int) *Manager {
	return NewManagerWithClock(defaultRate, defaultBurst, clock.Real{})
}

// NewManagerWithClock creates a manager that passes the provided clock to every
// limiter it creates. A nil clock falls back to the real clock.
func NewManagerWithClock(defaultRate float64, defaultBurst int, c clock.Clock) *Manager {
	if c == nil {
		c = clock.Real{}
	}
	return &Manager{
		limiters:     make(map[string]*Limiter),
		defaultRate:  defaultRate,
		defaultBurst: defaultBurst,
		clock:        c,
	}
}

// Get returns a limiter for the given key, creating one if needed.
func (m *Manager) Get(key string) *Limiter {
	m.mu.RLock()
	l, exists := m.limiters[key]
	m.mu.RUnlock()
	if exists {
		return l
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	// Double-check after acquiring write lock
	if lim, exists := m.limiters[key]; exists {
		return lim
	}
	l = NewLimiterWithClock(m.defaultRate, m.defaultBurst, m.clock)
	m.limiters[key] = l
	return l
}

// GetOrCreate returns a limiter for the given key with custom rate/burst.
func (m *Manager) GetOrCreate(key string, rate float64, burst int) *Limiter {
	m.mu.RLock()
	l, exists := m.limiters[key]
	m.mu.RUnlock()
	if exists {
		return l
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if lim, exists := m.limiters[key]; exists {
		return lim
	}
	l = NewLimiterWithClock(rate, burst, m.clock)
	m.limiters[key] = l
	return l
}

// Remove removes a limiter for the given key.
func (m *Manager) Remove(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.limiters, key)
}

// Keys returns all registered limiter keys.
func (m *Manager) Keys() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	keys := make([]string, 0, len(m.limiters))
	for k := range m.limiters {
		keys = append(keys, k)
	}
	return keys
}

// GlobalLimiter is a convenience wrapper for a global rate limiter.
type GlobalLimiter struct {
	limiter *Limiter
}

// NewGlobalLimiter creates a global rate limiter.
func NewGlobalLimiter(rate float64, burst int) *GlobalLimiter {
	return NewGlobalLimiterWithClock(rate, burst, clock.Real{})
}

// NewGlobalLimiterWithClock creates a global limiter using the provided clock.
func NewGlobalLimiterWithClock(rate float64, burst int, c clock.Clock) *GlobalLimiter {
	return &GlobalLimiter{limiter: NewLimiterWithClock(rate, burst, c)}
}

// Allow returns true if the global rate limit allows.
func (g *GlobalLimiter) Allow() bool {
	return g.limiter.Allow()
}

// Backoff provides exponential backoff with jitter for retries.
type Backoff struct {
	minDelay    time.Duration
	maxDelay    time.Duration
	multiplier  float64
	jitter      float64
	attempt     int
	maxAttempts int
}

// NewBackoff creates a new backoff calculator.
func NewBackoff(minDelay, maxDelay time.Duration, maxAttempts int) *Backoff {
	return &Backoff{
		minDelay:    minDelay,
		maxDelay:    maxDelay,
		multiplier:  2.0,
		jitter:      0.1,
		maxAttempts: maxAttempts,
	}
}

// Next returns the next backoff duration and whether max attempts reached.
func (b *Backoff) Next() (time.Duration, bool) {
	if b.attempt >= b.maxAttempts {
		return b.maxDelay, true
	}
	b.attempt++

	delay := float64(b.minDelay) * math.Pow(b.multiplier, float64(b.attempt-1))
	if delay > float64(b.maxDelay) {
		delay = float64(b.maxDelay)
	}

	// Add jitter: +/- jitter% of delay
	jitterAmount := delay * b.jitter
	jitterVal := cryptoFloat64()
	delay += jitterAmount * (2*jitterVal - 1)

	return time.Duration(delay), false
}

// cryptoFloat64 returns a random float64 in [0, 1) using crypto/rand.
func cryptoFloat64() float64 {
	n, err := rand.Int(rand.Reader, big.NewInt(1<<53))
	if err != nil {
		return 0.5
	}
	return float64(n.Int64()) / (1 << 53)
}

// Reset resets the backoff to initial state.
func (b *Backoff) Reset() {
	b.attempt = 0
}

// Attempt returns the current attempt number.
func (b *Backoff) Attempt() int {
	return b.attempt
}

// ControllerRateLimit wraps rate limiting for controllers.
type ControllerRateLimit struct {
	global    *GlobalLimiter
	perApp    *Manager
	perSource *Manager
}

// NewControllerRateLimit creates a controller rate limiter with sensible defaults.
func NewControllerRateLimit() *ControllerRateLimit {
	return NewControllerRateLimitWithClock(clock.Real{})
}

// NewControllerRateLimitWithClock creates a controller rate limiter using the
// provided clock. A nil clock falls back to the real clock.
func NewControllerRateLimitWithClock(c clock.Clock) *ControllerRateLimit {
	if c == nil {
		c = clock.Real{}
	}
	return &ControllerRateLimit{
		global:    NewGlobalLimiterWithClock(100, 200, c), // 100 reconciles/sec global
		perApp:    NewManagerWithClock(10, 20, c),         // 10 reconciles/sec per app
		perSource: NewManagerWithClock(5, 10, c),          // 5 reconciles/sec per source
	}
}

// AllowGlobal checks if global rate limit allows.
func (c *ControllerRateLimit) AllowGlobal() bool {
	return c.global.Allow()
}

// AllowApp checks if per-application rate limit allows.
func (c *ControllerRateLimit) AllowApp(appName string) bool {
	return c.perApp.Get(appName).Allow()
}

// AllowSource checks if per-source rate limit allows.
func (c *ControllerRateLimit) AllowSource(sourceURL string) bool {
	return c.perSource.Get(sourceURL).Allow()
}

// AppLimiter returns the limiter for an app (for custom configuration).
func (c *ControllerRateLimit) AppLimiter(appName string) *Limiter {
	return c.perApp.Get(appName)
}

// SourceLimiter returns the limiter for a source (for custom configuration).
func (c *ControllerRateLimit) SourceLimiter(sourceURL string) *Limiter {
	return c.perSource.Get(sourceURL)
}

// ReconcileKey builds a rate limit key from namespace and name.
func ReconcileKey(namespace, name string) string {
	return fmt.Sprintf("%s/%s", namespace, name)
}

// SourceKey builds a rate limit key from source type and URL.
func SourceKey(sourceType, url string) string {
	return fmt.Sprintf("%s:%s", sourceType, url)
}
