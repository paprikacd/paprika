package pipelines

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
)

func TestMatchesTrigger(t *testing.T) {
	t.Parallel()

	payload := &events.EventPayload{ResourceType: "application", Name: "app", Namespace: "default", Phase: "Failed", Reason: "ValidationFailed"}
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

	payload := &events.EventPayload{ResourceType: "application", Name: "app", Namespace: "default", Phase: "Failed", Reason: "ValidationFailed"}

	t.Run("default message", func(t *testing.T) {
		got := renderMessage("", payload)
		want := "default/app is now Failed (ValidationFailed)"
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
		want := "default/app is now Failed (ValidationFailed)"
		if got != want {
			t.Errorf("renderMessage() = %q, want %q", got, want)
		}
	})
}

func TestNotificationSender(t *testing.T) {
	t.Parallel()

	payload := &events.EventPayload{ResourceType: "application", Name: "app", Namespace: "default", Phase: "Failed", Reason: "ValidationFailed"}

	tests := []struct {
		name    string
		handler http.HandlerFunc
		call    func(sender *NotificationSender, url string) error
		wantErr bool
	}{
		{
			name: "sendWebhook with headers and bearer token",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("expected application/json content type, got %s", r.Header.Get("Content-Type"))
				}
				if r.Header.Get("X-Custom") != "value" {
					t.Errorf("expected custom header, got %s", r.Header.Get("X-Custom"))
				}
				if r.Header.Get("Authorization") != "Bearer token123" {
					t.Errorf("expected bearer token, got %s", r.Header.Get("Authorization"))
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read webhook body: %v", err)
					return
				}
				var received events.EventPayload
				if err := json.Unmarshal(body, &received); err != nil {
					t.Errorf("failed to decode webhook payload: %v", err)
				}
				if received != *payload {
					t.Errorf("webhook payload mismatch: got %+v, want %+v", received, *payload)
				}
				w.WriteHeader(http.StatusOK)
			},
			call: func(sender *NotificationSender, url string) error {
				secret := map[string]string{"token": "token123"}
				headers := map[string]string{"X-Custom": "value"}
				return sender.sendWebhook(context.Background(), url, payload, headers, secret)
			},
		},
		{
			name: "sendWebhook with basic auth",
			handler: func(w http.ResponseWriter, r *http.Request) {
				u, p, ok := r.BasicAuth()
				if !ok || u != "user" || p != "pass" {
					t.Errorf("expected basic auth user/pass, got %q/%q", u, p)
				}
				w.WriteHeader(http.StatusOK)
			},
			call: func(sender *NotificationSender, url string) error {
				secret := map[string]string{"username": "user", "password": "pass"}
				return sender.sendWebhook(context.Background(), url, &events.EventPayload{ResourceType: "application", Name: "app", Namespace: "default", Phase: "Failed"}, nil, secret)
			},
		},
		{
			name: "sendSlack",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer slack-token" {
					t.Errorf("expected bearer token, got %s", r.Header.Get("Authorization"))
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read slack body: %v", err)
					return
				}
				var msg map[string]string
				if err := json.Unmarshal(body, &msg); err != nil {
					t.Errorf("failed to decode slack payload: %v", err)
				}
				if msg["text"] != "test message" {
					t.Errorf("slack text mismatch: got %q", msg["text"])
				}
				w.WriteHeader(http.StatusOK)
			},
			call: func(sender *NotificationSender, url string) error {
				secret := map[string]string{"token": "slack-token"}
				return sender.sendSlack(context.Background(), url, "test message", secret)
			},
		},
		{
			name: "non-2xx response returns error",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
			},
			call: func(sender *NotificationSender, url string) error {
				return sender.sendWebhook(context.Background(), url, &events.EventPayload{}, nil, nil)
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			server := httptest.NewServer(tc.handler)
			defer server.Close()

			sender := NewNotificationSender()
			err := tc.call(sender, server.URL)
			if tc.wantErr {
				if err == nil {
					t.Error("expected error for non-2xx response")
				}
				return
			}
			if err != nil {
				t.Errorf("call() error = %v", err)
			}
		})
	}
}

func TestRateLimitAllowed(t *testing.T) {
	t.Parallel()

	r := NewNotificationConfigReconciler(nil, nil, nil, nil, clock.NewFake(time.Now()))
	cfg := &paprikav1.NotificationConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "cfg"},
		Spec: paprikav1.NotificationConfigSpec{
			RateLimit: &paprikav1.NotificationRateLimit{MinInterval: "1h"},
		},
	}
	payload := &events.EventPayload{ResourceType: "application", Namespace: "default", Name: "app", Phase: "Failed"}

	if !r.rateLimitAllowed(cfg, payload) {
		t.Error("first event should be allowed")
	}
	if r.rateLimitAllowed(cfg, payload) {
		t.Error("second event should be rate limited")
	}
}
