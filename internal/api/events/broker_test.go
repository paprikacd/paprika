package events

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewEvent(t *testing.T) {
	t.Parallel()

	evt, err := NewEvent("app.updated", map[string]string{"name": "test"}, nil)
	require.NoError(t, err)
	assert.Equal(t, "app.updated", evt.Type)
	assert.NotZero(t, evt.Timestamp)
	var payload map[string]string
	require.NoError(t, json.Unmarshal(evt.Payload, &payload))
	assert.Equal(t, "test", payload["name"])
}

func TestBroker_SubscribePublish(t *testing.T) {
	t.Parallel()

	b := NewBroker(logr.Discard())
	defer b.Close()

	ch := b.Subscribe(context.Background(), "apps")
	require.NotNil(t, ch)

	evt, err := NewEvent("app.updated", map[string]string{"name": "test"}, nil)
	require.NoError(t, err)

	b.Publish(context.Background(), "apps", evt)

	select {
	case got := <-ch:
		assert.Equal(t, "app.updated", got.Type)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestBroker_Close(t *testing.T) {
	t.Parallel()

	b := NewBroker(logr.Discard())
	ch := b.Subscribe(context.Background(), "apps")
	require.NotNil(t, ch)

	b.Close()
	_, ok := <-ch
	assert.False(t, ok)

	assert.Nil(t, b.Subscribe(context.Background(), "apps"))
}

func TestBroker_EventDelivery(t *testing.T) {
	type eventBroker interface {
		Subscribe(context.Context, string) <-chan *Event
		Publish(context.Context, string, *Event)
		Close()
	}

	tests := []struct {
		name      string
		newBroker func(t *testing.T) eventBroker
	}{
		{
			name: "memory broker from env",
			newBroker: func(t *testing.T) eventBroker {
				t.Setenv("PAPRIKA_CACHE_BACKEND", "")
				t.Setenv("PAPRIKA_REDIS_ADDR", "")
				b, err := NewBrokerFromEnv(context.Background())
				require.NoError(t, err)
				require.NotNil(t, b)
				t.Cleanup(b.Close)
				return b
			},
		},
		{
			name: "redis broker with nil client",
			newBroker: func(t *testing.T) eventBroker {
				ctx, cancel := context.WithCancel(context.Background())
				t.Cleanup(cancel)
				b, err := NewRedisBrokerWithContext(ctx, nil, logr.Discard())
				require.NoError(t, err)
				require.NotNil(t, b)
				t.Cleanup(b.Close)
				return b
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.newBroker(t)

			ch := b.Subscribe(context.Background(), "apps")
			require.NotNil(t, ch)

			evt, err := NewEvent("app.updated", map[string]string{"name": "test"}, nil)
			require.NoError(t, err)
			b.Publish(context.Background(), "apps", evt)

			select {
			case got := <-ch:
				assert.Equal(t, "app.updated", got.Type)
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for event")
			}
		})
	}
}

func TestNewBrokerFromEnv_RedisInvalid(t *testing.T) {
	t.Setenv("PAPRIKA_CACHE_BACKEND", "redis")
	t.Setenv("PAPRIKA_REDIS_ADDR", "127.0.0.1:1")
	_, err := NewBrokerFromEnv(context.Background())
	require.Error(t, err)
}

func TestBroker_SubscribeAfterClose(t *testing.T) {
	t.Parallel()

	b := NewBroker(logr.Discard())
	b.Close()

	ch := b.Subscribe(context.Background(), "apps")
	assert.Nil(t, ch)
}

func TestBroker_PublishDropsWhenBufferFull(t *testing.T) {
	t.Parallel()

	b := NewBroker(logr.Discard())
	defer b.Close()

	ch := b.Subscribe(context.Background(), "apps")
	require.NotNil(t, ch)

	// Fill the subscriber buffer without reading.
	for range cap(ch) {
		b.Publish(context.Background(), "apps", &Event{Type: "fill", Payload: nil, Timestamp: time.Now().UTC()})
	}

	// The next publish should drop the event rather than block forever.
	done := make(chan struct{})
	go func() {
		b.Publish(context.Background(), "apps", &Event{Type: "drop", Payload: nil, Timestamp: time.Now().UTC()})
		close(done)
	}()

	select {
	case <-done:
		// Publish returned promptly because the full subscriber dropped the event.
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber channel")
	}
}
