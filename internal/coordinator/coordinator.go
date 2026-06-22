package coordinator

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/benebsworth/paprika/internal/metrics"
)

const (
	DefaultHeartbeatInterval = 15 * time.Second
	DefaultHeartbeatTTL      = 30 * time.Second
)

var keyPrefix = "paprika:coordinator:"

func replicasKey() string            { return keyPrefix + "replicas" }
func heartbeatKey(pod string) string { return keyPrefix + "heartbeat:" + pod }

type Coordinator struct {
	client redis.UniversalClient
	self   string
	ring   *Ring

	heartbeatInterval time.Duration
	heartbeatTTL      time.Duration

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	healthy bool
	mu      sync.RWMutex
	events  chan struct{}
}

type Option func(*Coordinator)

func WithHeartbeatInterval(d time.Duration) Option {
	return func(c *Coordinator) { c.heartbeatInterval = d }
}

func WithHeartbeatTTL(d time.Duration) Option {
	return func(c *Coordinator) { c.heartbeatTTL = d }
}

func NewCoordinator(client redis.UniversalClient, podName string, opts ...Option) *Coordinator {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Coordinator{
		client:            client,
		self:              podName,
		ring:              NewRing(nil, 16),
		heartbeatInterval: DefaultHeartbeatInterval,
		heartbeatTTL:      DefaultHeartbeatTTL,
		ctx:               ctx,
		cancel:            cancel,
		events:            make(chan struct{}, 1),
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

func (c *Coordinator) Join(ctx context.Context) error {
	pipe := c.client.Pipeline()
	pipe.SAdd(ctx, replicasKey(), c.self)
	pipe.Set(ctx, heartbeatKey(c.self), "alive", c.heartbeatTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("Coordinator join failed, entering degraded mode", "error", err)
		degradedCtx, degradedCancel := context.WithCancel(ctx)
		c.wg.Add(1)
		go c.heartbeatLoop(degradedCtx)
		go func() { <-c.ctx.Done(); degradedCancel() }()
		return nil
	}
	c.mu.Lock()
	c.healthy = true
	c.mu.Unlock()
	if err := c.syncRing(ctx); err != nil {
		slog.Warn("Coordinator initial ring sync failed", "error", err)
	}
	heartbeatCtx, heartbeatCancel := context.WithCancel(ctx)
	c.wg.Add(1)
	go c.heartbeatLoop(heartbeatCtx)
	go func() { <-c.ctx.Done(); heartbeatCancel() }()
	slog.Info("Joined coordinator ring", "pod", c.self, "replicas", c.ring.Len())
	return nil
}

func (c *Coordinator) Leave(ctx context.Context) error {
	c.cancel()
	c.wg.Wait()
	pipe := c.client.Pipeline()
	pipe.Del(ctx, heartbeatKey(c.self))
	pipe.SRem(ctx, replicasKey(), c.self)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("Coordinator leave cleanup failed", "pod", c.self, "error", err)
	}
	slog.Info("Left coordinator ring", "pod", c.self)
	time.Sleep(2 * time.Second)
	return nil
}

func (c *Coordinator) Healthy(_ context.Context) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.healthy
}

func (c *Coordinator) Ring() *Ring {
	return c.ring
}

func (c *Coordinator) Events() <-chan struct{} {
	return c.events
}

func (c *Coordinator) syncRing(ctx context.Context) error {
	members, err := c.client.SMembers(ctx, replicasKey()).Result()
	if err != nil {
		return fmt.Errorf("coordinator SMEMBERS: %w", err)
	}
	oldMembers := c.ring.Members()
	oldLen := len(oldMembers)

	clean := make([]string, 0, len(members))
	for _, m := range members {
		exists, err := c.client.Exists(ctx, heartbeatKey(m)).Result()
		if err != nil {
			slog.Warn("Coordinator heartbeat check failed", "member", m, "error", err)
			clean = append(clean, m)
			continue
		}
		if exists == 0 {
			slog.Info("Replica left ring", "pod", m)
			c.client.SRem(ctx, replicasKey(), m)
			continue
		}
		clean = append(clean, m)
	}
	c.ring.Rebuild(clean)

	if oldLen != len(clean) {
		slog.Info("Rebalancing ring - replicas changed",
			"from", oldLen, "to", len(clean))
	}
	metrics.CoordinatorReplicas.Set(float64(len(clean)))

	select {
	case c.events <- struct{}{}:
	default:
	}
	return nil
}

func (c *Coordinator) heartbeatLoop(ctx context.Context) {
	defer c.wg.Done()
	maxJitter := c.heartbeatInterval / 3
	if maxJitter > 5*time.Second {
		maxJitter = 5 * time.Second
	}
	time.Sleep(time.Duration(rand.Intn(int(maxJitter.Milliseconds()))) * time.Millisecond) //nolint:gosec // non-security jitter
	ticker := time.NewTicker(c.heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			heartbeatStart := time.Now()
			heartbeatTimeout := c.heartbeatTTL / 2
			if heartbeatTimeout > 5*time.Second {
				heartbeatTimeout = 5 * time.Second
			}
			timeoutCtx, cancel := context.WithTimeout(ctx, heartbeatTimeout)
			pipe := c.client.Pipeline()
			pipe.Set(timeoutCtx, heartbeatKey(c.self), "alive", c.heartbeatTTL)
			pipe.Expire(timeoutCtx, replicasKey(), c.heartbeatTTL)
			if _, err := pipe.Exec(timeoutCtx); err != nil {
				slog.Error("Coordinator heartbeat failed", "error", err)
				metrics.CoordinatorHeartbeatFailuresTotal.Inc()
				c.mu.Lock()
				c.healthy = false
				c.mu.Unlock()
				cancel()
				retryDelay := c.heartbeatInterval / 3
				if retryDelay > 5*time.Second {
					retryDelay = 5 * time.Second
				}
				time.Sleep(retryDelay)
				continue
			}
			metrics.CoordinatorHeartbeatSeconds.Observe(time.Since(heartbeatStart).Seconds())
			c.mu.Lock()
			c.healthy = true
			c.mu.Unlock()
			if err := c.syncRing(timeoutCtx); err != nil {
				slog.Error("Coordinator ring sync failed", "error", err)
			}
			cancel()
		}
	}
}
