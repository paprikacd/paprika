package apiserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/events"
)

func TestSSEHandler_SubscribeAndReceive(t *testing.T) {
	t.Parallel()

	broker := events.NewBroker(logr.Discard())
	defer broker.Close()

	handler := NewSSEHandler(broker)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/events?topic=apps", http.NoBody)
	rr := httptest.NewRecorder()

	evt, err := events.NewEvent("app.updated", map[string]string{"name": "test"}, nil)
	require.NoError(t, err)

	go func() {
		time.Sleep(50 * time.Millisecond)
		handler.PublishEvent(context.Background(), "apps", evt)
		broker.Close()
	}()

	handler.ServeHTTP(rr, req)

	assert.Contains(t, rr.Body.String(), "app.updated")
	assert.Contains(t, rr.Body.String(), "test")
}
