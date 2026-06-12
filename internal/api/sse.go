package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/benebsworth/paprika/internal/api/events"
)

// SSEHandler serves Server-Sent Events for real-time UI updates.
type SSEHandler struct {
	broker *events.Broker
}

// NewSSEHandler creates an SSE handler with the given event broker.
func NewSSEHandler(broker *events.Broker) *SSEHandler {
	return &SSEHandler{broker: broker}
}

// ServeHTTP implements the http.Handler interface.
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	topic := r.URL.Query().Get("topic")
	if topic == "" {
		topic = "default"
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ch := h.broker.Subscribe(ctx, topic)
	if ch == nil {
		http.Error(w, "broker closed", http.StatusServiceUnavailable)
		return
	}
	defer func() {
		h.broker.Unsubscribe(ctx, topic, ch)
	}()

	_, _ = fmt.Fprintf(w, ":ok\n\n")
	flusher.Flush()

	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(evt)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}

// PublishEvent publishes an event to the broker.
func (h *SSEHandler) PublishEvent(ctx context.Context, topic string, event *events.Event) {
	h.broker.Publish(ctx, topic, event)
}
