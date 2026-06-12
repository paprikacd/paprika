package events

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewEvent(t *testing.T) {
	evt, err := NewEvent("app.updated", map[string]string{"name": "test"})
	require.NoError(t, err)
	assert.Equal(t, "app.updated", evt.Type)
	assert.NotZero(t, evt.Timestamp)
	var payload map[string]string
	require.NoError(t, json.Unmarshal(evt.Payload, &payload))
	assert.Equal(t, "test", payload["name"])
}

func TestBroker_SubscribePublish(t *testing.T) {
	b := NewBroker()
	defer b.Close()

	ch := b.Subscribe(context.Background(), "apps")
	require.NotNil(t, ch)

	evt, err := NewEvent("app.updated", map[string]string{"name": "test"})
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
	b := NewBroker()
	ch := b.Subscribe(context.Background(), "apps")
	require.NotNil(t, ch)

	b.Close()
	_, ok := <-ch
	assert.False(t, ok)

	assert.Nil(t, b.Subscribe(context.Background(), "apps"))
}
