package apiserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"sigs.k8s.io/controller-runtime/pkg/log"

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
//
//nolint:cyclop // SSE handler has sequential event branches.
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	topic := r.URL.Query().Get("topic")
	if topic == "" {
		topic = "default"
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Set CORS to request origin (not wildcard) to avoid exposing SSE events
	// to any cross-origin site. Falls back to same-origin if header is empty.
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("Vary", "Origin")

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

	if _, err := fmt.Fprintf(w, ":ok\n\n"); err != nil {
		log.FromContext(ctx).Error(err, "Failed to write SSE heartbeat")
		return
	}
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
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				log.FromContext(ctx).Error(err, "Failed to write SSE event")
				return
			}
			flusher.Flush()
		}
	}
}

// PublishEvent publishes an event to the broker.
func (h *SSEHandler) PublishEvent(ctx context.Context, topic string, event *events.Event) {
	h.broker.Publish(ctx, topic, event)
}
