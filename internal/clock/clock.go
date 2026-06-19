// Package clock provides a small dependency-injection interface for time.
package clock

import (
	"sync"
	"time"
)

// Clock returns the current time. It exists so unit tests can replace real
// time with a deterministic fake.
type Clock interface {
	Now() time.Time
}

// Real is the production implementation backed by time.Now.
type Real struct{}

// Now returns the current wall-clock time.
func (Real) Now() time.Time { return time.Now() }

// Fake is a deterministic clock for tests.
type Fake struct {
	mu  sync.RWMutex
	now time.Time
}

// NewFake creates a fake clock set to the given time.
func NewFake(now time.Time) *Fake {
	return &Fake{now: now}
}

// Now returns the fake clock's current time.
func (f *Fake) Now() time.Time {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.now
}

// Set moves the fake clock to the given time.
func (f *Fake) Set(now time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = now
}

// Add advances the fake clock by the given duration.
func (f *Fake) Add(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}
