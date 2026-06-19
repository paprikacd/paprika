package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/go-logr/logr"
	"github.com/redis/go-redis/v9"

	"github.com/benebsworth/paprika/internal/clock"
)

const (
	backendRedis     = "redis"
	backendMemory    = "memory"
	defaultRedisAddr = "localhost:6379"
)

// Broker distributes events to multiple subscribers.
// A Redis-backed broker fan-out publishes messages to all connected instances.
type Broker struct {
	mu          sync.RWMutex
	subscribers map[string][]chan *Event
	closed      bool
	redis       redis.UniversalClient
	pubsub      *redis.PubSub
	cancel      context.CancelFunc
	log         logr.Logger
}

// NewBroker creates a new in-memory event broker.
func NewBroker(log logr.Logger) *Broker {
	if log.GetSink() == nil {
		log = logr.Discard()
	}
	return &Broker{
		subscribers: make(map[string][]chan *Event),
		log:         log,
	}
}

// NewRedisBroker creates a broker backed by Redis pub/sub for cross-instance fan-out.
// The broker runs until Close is called. To tie the broker lifecycle to a parent
// context, use NewRedisBrokerWithContext.
func NewRedisBroker(client redis.UniversalClient, log logr.Logger) (*Broker, error) {
	return NewRedisBrokerWithContext(context.Background(), client, log)
}

// NewRedisBrokerWithContext creates a Redis-backed broker whose receive loop stops
// when the provided context is cancelled or Close is called.
func NewRedisBrokerWithContext(ctx context.Context, client redis.UniversalClient, log logr.Logger) (*Broker, error) {
	if log.GetSink() == nil {
		log = logr.Discard()
	}
	ctx, cancel := context.WithCancel(ctx)
	b := &Broker{
		subscribers: make(map[string][]chan *Event),
		redis:       client,
		cancel:      cancel,
		log:         log,
	}
	if client != nil {
		b.pubsub = client.Subscribe(ctx)
		go b.receiveLoop(ctx)
	}
	return b, nil
}

// NewBrokerFromEnv creates a broker from environment variables.
// PAPRIKA_CACHE_BACKEND=redis enables Redis pub/sub; otherwise an in-memory broker is used.
// PAPRIKA_REDIS_ADDR, PAPRIKA_REDIS_PASSWORD, PAPRIKA_REDIS_DB configure Redis.
//
// Deprecated: read Redis environment variables in cmd/main and pass an explicit
// redis.UniversalClient to NewRedisBrokerWithContext.
func NewBrokerFromEnv(ctx context.Context) (*Broker, error) {
	backend := os.Getenv("PAPRIKA_CACHE_BACKEND")
	if backend == "" {
		backend = backendMemory
	}
	if backend != backendRedis {
		return NewBroker(logr.Discard()), nil
	}
	addr := os.Getenv("PAPRIKA_REDIS_ADDR")
	if addr == "" {
		addr = defaultRedisAddr
	}
	db, err := strconv.Atoi(os.Getenv("PAPRIKA_REDIS_DB"))
	if err != nil {
		return nil, fmt.Errorf("invalid PAPRIKA_REDIS_DB: %w", err)
	}
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: os.Getenv("PAPRIKA_REDIS_PASSWORD"),
		DB:       db,
	})
	if err := client.Ping(ctx).Err(); err != nil {
		if closeErr := client.Close(); closeErr != nil {
			return nil, fmt.Errorf("redis ping failed; close failed: %w", errors.Join(err, closeErr))
		}
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}
	return NewRedisBrokerWithContext(ctx, client, logr.Discard())
}

// NewBrokerFromEnvLegacy creates a broker from environment variables using a
// background context.
//
// Deprecated: use NewBrokerFromEnv(ctx).
func NewBrokerFromEnvLegacy() (*Broker, error) {
	return NewBrokerFromEnv(context.Background())
}

// Subscribe creates a channel that receives events for the given topic.
func (b *Broker) Subscribe(ctx context.Context, topic string) <-chan *Event {
	ch := make(chan *Event, 16)

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		close(ch)
		return nil
	}
	b.subscribers[topic] = append(b.subscribers[topic], ch)
	b.mu.Unlock()

	if b.pubsub != nil {
		// Subscribe to Redis outside the lock so Redis network I/O does not
		// serialize publishers or other subscribers.
		if err := b.pubsub.Subscribe(ctx, topic); err != nil {
			b.log.Error(err, "Failed to subscribe to Redis topic", "topic", topic)
		}
	}
	return ch
}

// Unsubscribe removes a subscriber channel from the given topic.
func (b *Broker) Unsubscribe(_ context.Context, topic string, ch <-chan *Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	subs := b.subscribers[topic]
	for i, c := range subs {
		if c == ch {
			close(c)
			b.subscribers[topic] = append(subs[:i], subs[i+1:]...)
			return
		}
	}
}

// Publish sends an event to all subscribers of the given topic.
func (b *Broker) Publish(ctx context.Context, topic string, event *Event) {
	b.publishLocal(topic, event)
	if b.redis != nil {
		data, err := json.Marshal(event)
		if err == nil {
			if err := b.redis.Publish(ctx, topic, data).Err(); err != nil {
				b.log.Error(err, "Failed to publish event to Redis", "topic", topic)
			}
		}
	}
}

func (b *Broker) publishLocal(topic string, event *Event) {
	b.mu.RLock()
	if b.closed {
		b.mu.RUnlock()
		return
	}
	subs := make([]chan *Event, len(b.subscribers[topic]))
	copy(subs, b.subscribers[topic])
	b.mu.RUnlock()

	for _, ch := range subs {
		select {
		case ch <- event:
		default:
			// Drop the event when the subscriber's buffer is full. This is a
			// deliberate backpressure policy: a slow consumer must not block
			// faster publishers or the Redis receive loop.
		}
	}
}

func (b *Broker) receiveLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-b.pubsub.Channel():
			if msg == nil {
				continue
			}
			var event Event
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				continue
			}
			b.publishLocal(msg.Channel, &event)
		}
	}
}

// Close closes all subscriber channels and Redis connections.
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	if b.cancel != nil {
		b.cancel()
	}
	if b.pubsub != nil {
		if err := b.pubsub.Close(); err != nil {
			b.log.Error(err, "Failed to close Redis pubsub")
		}
	}
	for _, subs := range b.subscribers {
		for _, ch := range subs {
			close(ch)
		}
	}
	b.subscribers = make(map[string][]chan *Event)
}

// Topics returns the list of active topics.
func (b *Broker) Topics() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	topics := make([]string, 0, len(b.subscribers))
	for topic := range b.subscribers {
		topics = append(topics, topic)
	}
	return topics
}

const (
	// TopicDashboard is the default SSE topic for UI dashboard updates.
	TopicDashboard = "dashboard"
	// TypeApplication identifies events for Application resources.
	TypeApplication = "application"
	// TypeRelease identifies events for Release resources.
	TypeRelease = "release"
)

// NewEvent creates an event with the given type and payload.
func NewEvent(eventType string, payload any, clk clock.Clock) (*Event, error) {
	if clk == nil {
		clk = clock.Real{}
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal event payload: %w", err)
	}
	return &Event{
		Type:      eventType,
		Payload:   data,
		Timestamp: clk.Now().UTC(),
	}, nil
}

// Event represents a UI-bound event.
type Event struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
}
