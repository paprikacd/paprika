package controller

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
)

func TestMatchesTrigger(t *testing.T) {
	t.Parallel()

	payload := eventPayload{Name: "app", Namespace: "default", Phase: "Failed", Reason: "ValidationFailed"}
	evt := &events.Event{Type: events.TypeApplication}

	tests := []struct {
		name     string
		triggers []paprikav1.NotificationTrigger
		want     bool
	}{
		{
			name:     "no triggers matches anything",
			triggers: nil,
			want:     true,
		},
		{
			name:     "resource type mismatch",
			triggers: []paprikav1.NotificationTrigger{{ResourceType: "release"}},
			want:     false,
		},
		{
			name:     "phase mismatch",
			triggers: []paprikav1.NotificationTrigger{{Phase: "Complete"}},
			want:     false,
		},
		{
			name:     "reason mismatch",
			triggers: []paprikav1.NotificationTrigger{{Reason: "Other"}},
			want:     false,
		},
		{
			name:     "all filters match",
			triggers: []paprikav1.NotificationTrigger{{ResourceType: "application", Phase: "Failed", Reason: "ValidationFailed"}},
			want:     true,
		},
		{
			name:     "case insensitive match",
			triggers: []paprikav1.NotificationTrigger{{ResourceType: "APPLICATION", Phase: "failed"}},
			want:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesTrigger(evt, payload, tc.triggers); got != tc.want {
				t.Errorf("matchesTrigger() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRenderMessage(t *testing.T) {
	t.Parallel()

	payload := eventPayload{Name: "app", Namespace: "default", Phase: "Failed", Reason: "ValidationFailed"}

	t.Run("default message", func(t *testing.T) {
		got := renderMessage("", payload)
		want := "default/app is now Failed"
		if got != want {
			t.Errorf("renderMessage() = %q, want %q", got, want)
		}
	})

	t.Run("custom template", func(t *testing.T) {
		tmpl := "{{ .namespace }}/{{ .name }}: {{ .phase }} ({{ .reason }})"
		got := renderMessage(tmpl, payload)
		want := "default/app: Failed (ValidationFailed)"
		if got != want {
			t.Errorf("renderMessage() = %q, want %q", got, want)
		}
	})

	t.Run("invalid template falls back", func(t *testing.T) {
		got := renderMessage("{{ .bad", payload)
		want := "default/app is now Failed"
		if got != want {
			t.Errorf("renderMessage() = %q, want %q", got, want)
		}
	})
}

func TestNotificationSender_sendWebhook(t *testing.T) {
	t.Parallel()

	payload := eventPayload{Name: "app", Namespace: "default", Phase: "Failed", Reason: "ValidationFailed"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json content type, got %s", r.Header.Get("Content-Type"))
		}
		body, _ := io.ReadAll(r.Body)
		var received eventPayload
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("failed to decode webhook payload: %v", err)
		}
		if received != payload {
			t.Errorf("webhook payload mismatch: got %+v, want %+v", received, payload)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := NewNotificationSender()
	if err := sender.sendWebhook(context.Background(), server.URL, payload); err != nil {
		t.Errorf("sendWebhook() error = %v", err)
	}
}

func TestNotificationSender_sendSlack(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg map[string]string
		if err := json.Unmarshal(body, &msg); err != nil {
			t.Errorf("failed to decode slack payload: %v", err)
		}
		if msg["text"] != "test message" {
			t.Errorf("slack text mismatch: got %q", msg["text"])
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := NewNotificationSender()
	if err := sender.sendSlack(context.Background(), server.URL, "test message"); err != nil {
		t.Errorf("sendSlack() error = %v", err)
	}
}

func TestNotificationSender_non2xxReturnsError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	sender := NewNotificationSender()
	if err := sender.sendWebhook(context.Background(), server.URL, eventPayload{}); err == nil {
		t.Error("expected error for non-2xx response")
	}
}
