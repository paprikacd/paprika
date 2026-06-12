package events

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
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
}

// NewBroker creates a new in-memory event broker.
func NewBroker() *Broker {
	return &Broker{
		subscribers: make(map[string][]chan *Event),
	}
}

// NewRedisBroker creates a broker backed by Redis pub/sub for cross-instance fan-out.
func NewRedisBroker(client redis.UniversalClient) (*Broker, error) {
	ctx, cancel := context.WithCancel(context.Background())
	b := &Broker{
		subscribers: make(map[string][]chan *Event),
		redis:       client,
		cancel:      cancel,
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
func NewBrokerFromEnv() (*Broker, error) {
	backend := os.Getenv("PAPRIKA_CACHE_BACKEND")
	if backend == "" {
		backend = "memory"
	}
	if backend != "redis" {
		return NewBroker(), nil
	}
	addr := os.Getenv("PAPRIKA_REDIS_ADDR")
	if addr == "" {
		addr = "localhost:6379"
	}
	db, _ := strconv.Atoi(os.Getenv("PAPRIKA_REDIS_DB"))
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: os.Getenv("PAPRIKA_REDIS_PASSWORD"),
		DB:       db,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}
	return NewRedisBroker(client)
}

// Subscribe creates a channel that receives events for the given topic.
func (b *Broker) Subscribe(ctx context.Context, topic string) <-chan *Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil
	}
	ch := make(chan *Event, 16)
	b.subscribers[topic] = append(b.subscribers[topic], ch)
	if b.pubsub != nil {
		_ = b.pubsub.Subscribe(ctx, topic)
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
			_ = b.redis.Publish(ctx, topic, data).Err()
		}
	}
}

func (b *Broker) publishLocal(topic string, event *Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed {
		return
	}
	for _, ch := range b.subscribers[topic] {
		select {
		case ch <- event:
		default:
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
		_ = b.pubsub.Close()
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

// NewEvent creates an event with the given type and payload.
func NewEvent(eventType string, payload any) (*Event, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal event payload: %w", err)
	}
	return &Event{
		Type:      eventType,
		Payload:   data,
		Timestamp: time.Now().UTC(),
	}, nil
}

// Event represents a UI-bound event.
type Event struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
}
