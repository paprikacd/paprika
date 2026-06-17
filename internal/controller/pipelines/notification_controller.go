package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"text/template"
	"time"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
)

// NotificationSender delivers notification payloads to destinations.
type NotificationSender struct {
	HTTPClient *http.Client
}

// NewNotificationSender creates a sender with a sensible default timeout.
func NewNotificationSender() *NotificationSender {
	return &NotificationSender{
		HTTPClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// NotificationConfigReconciler watches NotificationConfig resources and forwards
// matching broker events to configured destinations.
type NotificationConfigReconciler struct {
	client.Client
	EventBroker *events.Broker
	Sender      *NotificationSender
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=notificationconfigs,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=notificationconfigs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=notificationconfigs/finalizers,verbs=update

// Reconcile is intentionally a no-op; the controller does its work in Start.
func (r *NotificationConfigReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	_ = ctx
	_ = req
	return ctrl.Result{}, nil
}

// Start subscribes to the event broker and dispatches notifications until the
// manager context is cancelled.
func (r *NotificationConfigReconciler) Start(ctx context.Context) error {
	if r.EventBroker == nil {
		log.FromContext(ctx).Info("No event broker configured, notification controller disabled")
		return nil
	}

	ch := r.EventBroker.Subscribe(ctx, events.TopicDashboard)
	if ch == nil {
		return nil
	}
	defer r.EventBroker.Unsubscribe(ctx, events.TopicDashboard, ch)

	log.FromContext(ctx).Info("Notification controller started")
	for {
		select {
		case <-ctx.Done():
			return nil
		case evt, ok := <-ch:
			if !ok {
				return nil
			}
			r.handleEvent(ctx, evt)
		}
	}
}

func (r *NotificationConfigReconciler) handleEvent(ctx context.Context, evt *events.Event) {
	payload, err := decodeEventPayload(evt)
	if err != nil {
		log.FromContext(ctx).Error(err, "Failed to decode event payload")
		return
	}

	var configs paprikav1.NotificationConfigList
	if err := r.List(ctx, &configs); err != nil {
		log.FromContext(ctx).Error(err, "Failed to list NotificationConfigs")
		return
	}

	for i := range configs.Items {
		cfg := &configs.Items[i]
		if !matchesTrigger(evt, payload, cfg.Spec.Triggers) {
			continue
		}
		for _, dest := range cfg.Spec.Destinations {
			message := renderMessage(cfg.Spec.Template, payload)
			if dest.WebhookURL != "" {
				if sendErr := r.Sender.sendWebhook(ctx, dest.WebhookURL, payload); sendErr != nil {
					log.FromContext(ctx).Error(sendErr, "Failed to send webhook notification",
						"config", cfg.Name, "destination", dest.Name)
				}
			}
			if dest.SlackWebhookURL != "" {
				if sendErr := r.Sender.sendSlack(ctx, dest.SlackWebhookURL, message); sendErr != nil {
					log.FromContext(ctx).Error(sendErr, "Failed to send slack notification",
						"config", cfg.Name, "destination", dest.Name)
				}
			}
		}
	}
}

// eventPayload is the shape of data published by application/release controllers.
type eventPayload struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Phase     string `json:"phase"`
	Reason    string `json:"reason"`
}

func decodeEventPayload(evt *events.Event) (eventPayload, error) {
	var payload eventPayload
	if err := json.Unmarshal(evt.Payload, &payload); err != nil {
		return payload, fmt.Errorf("unmarshal event payload: %w", err)
	}
	return payload, nil
}

func matchesTrigger(evt *events.Event, payload eventPayload, triggers []paprikav1.NotificationTrigger) bool {
	if len(triggers) == 0 {
		return true
	}
	for _, t := range triggers {
		if t.ResourceType != "" && !strings.EqualFold(t.ResourceType, evt.Type) {
			continue
		}
		if t.Phase != "" && !strings.EqualFold(t.Phase, payload.Phase) {
			continue
		}
		if t.Reason != "" && !strings.EqualFold(t.Reason, payload.Reason) {
			continue
		}
		return true
	}
	return false
}

func renderMessage(tmpl string, payload eventPayload) string {
	if tmpl == "" {
		return fmt.Sprintf("%s/%s is now %s", payload.Namespace, payload.Name, payload.Phase)
	}
	t, err := template.New("notification").Parse(tmpl)
	if err != nil {
		return fmt.Sprintf("%s/%s is now %s", payload.Namespace, payload.Name, payload.Phase)
	}
	var buf bytes.Buffer
	data := map[string]string{
		"name":      payload.Name,
		"namespace": payload.Namespace,
		"phase":     payload.Phase,
		"reason":    payload.Reason,
	}
	if execErr := t.Execute(&buf, data); execErr != nil {
		return fmt.Sprintf("%s/%s is now %s", payload.Namespace, payload.Name, payload.Phase)
	}
	return buf.String()
}

func (s *NotificationSender) sendWebhook(ctx context.Context, url string, payload eventPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal webhook payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create webhook request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("post webhook: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *NotificationSender) sendSlack(ctx context.Context, url, message string) error {
	body, err := json.Marshal(map[string]string{"text": message})
	if err != nil {
		return fmt.Errorf("marshal slack payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create slack request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("post slack: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("slack returned status %d", resp.StatusCode)
	}
	return nil
}

// SetupWithManager registers the notification controller as a runnable.
func (r *NotificationConfigReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := mgr.Add(r); err != nil {
		return fmt.Errorf("register notification controller: %w", err)
	}
	return nil
}
