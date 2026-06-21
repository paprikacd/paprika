package pipelines

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/smtp"
	"strings"
	"sync"
	"text/template"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
)

const defaultHTTPTimeout = 10 * time.Second

// NotificationSender delivers notification payloads to destinations.
type NotificationSender struct {
	HTTPClient *http.Client
}

// NewNotificationSender creates a sender with a sensible default timeout.
func NewNotificationSender() *NotificationSender {
	return &NotificationSender{
		HTTPClient: &http.Client{Timeout: defaultHTTPTimeout},
	}
}

type rateLimitKey struct {
	configName string
	resource   string
	phase      string
}

// NotificationConfigReconciler watches NotificationConfig resources and forwards
// matching broker events to configured destinations.
type NotificationConfigReconciler struct {
	client      client.Client
	EventBroker *events.Broker
	Sender      *NotificationSender
	Emailer     *EmailSender
	rateLimits  map[rateLimitKey]time.Time
	rateMu      sync.Mutex
	Clock       clock.Clock
}

func (r *NotificationConfigReconciler) now() time.Time {
	if r.Clock != nil {
		return r.Clock.Now()
	}
	return time.Now()
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=notificationconfigs,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=notificationconfigs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=notificationconfigs/finalizers,verbs=update
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch

// NewNotificationConfigReconciler creates a reconciler that initializes the
// internal rate-limit map so rateLimitAllowed is safe to call before Start.
func NewNotificationConfigReconciler(c client.Client, broker *events.Broker, sender *NotificationSender, emailer *EmailSender, clk clock.Clock) *NotificationConfigReconciler {
	if clk == nil {
		clk = clock.Real{}
	}
	return &NotificationConfigReconciler{
		client:      c,
		EventBroker: broker,
		Sender:      sender,
		Emailer:     emailer,
		rateLimits:  make(map[rateLimitKey]time.Time),
		Clock:       clk,
	}
}

// Reconcile is intentionally a no-op; the controller does its work in Start.
func (r *NotificationConfigReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	_ = ctx
	_ = req
	return ctrl.Result{}, nil
}

// Start subscribes to the event broker and dispatches notifications until the
// manager context is cancelled.
func (r *NotificationConfigReconciler) Start(ctx context.Context) error {
	if r.rateLimits == nil {
		r.rateLimits = make(map[rateLimitKey]time.Time)
	}
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
	if err := r.client.List(ctx, &configs); err != nil {
		log.FromContext(ctx).Error(err, "Failed to list NotificationConfigs")
		return
	}

	for i := range configs.Items {
		cfg := &configs.Items[i]
		if !r.rateLimitAllowed(cfg, payload) {
			continue
		}
		if !matchesTrigger(evt, payload, cfg.Spec.Triggers) {
			continue
		}

		emailer := r.buildEmailer(ctx, cfg)
		r.dispatchConfig(ctx, cfg, payload, emailer)

		if err := r.client.Status().Update(ctx, cfg); err != nil {
			log.FromContext(ctx).Error(err, "Failed to update NotificationConfig status", "config", cfg.Name)
		}
	}
}

func (r *NotificationConfigReconciler) buildEmailer(ctx context.Context, cfg *paprikav1.NotificationConfig) *EmailSender {
	if cfg.Spec.SMTP == nil {
		return nil
	}
	var auth smtp.Auth
	if cfg.Spec.SMTP.AuthSecretRef != "" {
		secrets, err := r.resolveSecret(ctx, cfg.Namespace, cfg.Spec.SMTP.AuthSecretRef)
		if err != nil {
			log.FromContext(ctx).Error(err, "Failed to resolve SMTP secret", "config", cfg.Name)
		} else {
			auth = smtp.PlainAuth("", secrets["username"], secrets["password"], cfg.Spec.SMTP.Host)
		}
	}
	return NewEmailSender(*cfg.Spec.SMTP, auth)
}

func (r *NotificationConfigReconciler) dispatchConfig(ctx context.Context, cfg *paprikav1.NotificationConfig, payload *events.EventPayload, emailer *EmailSender) {
	for i := range cfg.Spec.Destinations {
		dest := &cfg.Spec.Destinations[i]
		message := renderMessage(cfg.Spec.Template, payload)
		secret, secretErr := r.resolveSecret(ctx, cfg.Namespace, dest.SecretRef)
		if secretErr != nil {
			log.FromContext(ctx).Error(secretErr, "Failed to resolve notification secret",
				"config", cfg.Name, "destination", dest.Name)
		}

		record := paprikav1.NotificationDelivery{
			DestinationName: dest.Name,
			Phase:           payload.Phase,
			SentAt:          ptr(metav1.NewTime(r.now())),
		}

		deliveryErr := r.dispatchDestination(ctx, payload, emailer, dest, message, secret)
		if deliveryErr != nil {
			record.Success = false
			record.Error = deliveryErr.Error()
			log.FromContext(ctx).Error(deliveryErr, "Failed to send notification",
				"config", cfg.Name, "destination", dest.Name)
		} else {
			record.Success = true
		}
		r.appendDelivery(cfg, record)
	}
}

func (r *NotificationConfigReconciler) dispatchDestination(
	ctx context.Context,
	payload *events.EventPayload,
	emailer *EmailSender,
	dest *paprikav1.NotificationDestination,
	message string,
	secret map[string]string,
) error {
	switch {
	case dest.WebhookURL != "":
		return r.Sender.sendWebhook(ctx, dest.WebhookURL, payload, dest.Headers, secret)
	case dest.SlackWebhookURL != "":
		return r.Sender.sendSlack(ctx, dest.SlackWebhookURL, message, secret)
	case dest.Email != "" && emailer != nil:
		subject := fmt.Sprintf("Paprika: %s/%s %s", payload.Namespace, payload.Name, payload.Phase)
		return emailer.Send(ctx, dest.Email, subject, message)
	case dest.Email != "" && emailer == nil:
		return errors.New("email destination configured but SMTP is not set")
	default:
		return nil
	}
}

func (r *NotificationConfigReconciler) resolveSecret(ctx context.Context, ns, name string) (map[string]string, error) {
	if name == "" {
		return nil, nil
	}
	var sec corev1.Secret
	if err := r.client.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &sec); err != nil {
		return nil, fmt.Errorf("getting secret %s/%s: %w", ns, name, err)
	}
	out := make(map[string]string, len(sec.Data))
	for k, v := range sec.Data {
		out[k] = string(v)
	}
	return out, nil
}

func (r *NotificationConfigReconciler) rateLimitAllowed(cfg *paprikav1.NotificationConfig, payload *events.EventPayload) bool {
	if cfg.Spec.RateLimit == nil || cfg.Spec.RateLimit.MinInterval == "" {
		return true
	}
	d, err := time.ParseDuration(cfg.Spec.RateLimit.MinInterval)
	if err != nil {
		return true
	}
	key := rateLimitKey{
		configName: cfg.Name,
		resource:   payload.ResourceType + "/" + payload.Namespace + "/" + payload.Name,
		phase:      payload.Phase,
	}
	r.rateMu.Lock()
	defer r.rateMu.Unlock()
	if last, ok := r.rateLimits[key]; ok && r.now().Sub(last) < d {
		return false
	}
	r.rateLimits[key] = r.now()
	return true
}

func (r *NotificationConfigReconciler) appendDelivery(cfg *paprikav1.NotificationConfig, d paprikav1.NotificationDelivery) {
	cfg.Status.Deliveries = append(cfg.Status.Deliveries, d)
	if len(cfg.Status.Deliveries) > 20 {
		cfg.Status.Deliveries = cfg.Status.Deliveries[len(cfg.Status.Deliveries)-20:]
	}
}

func decodeEventPayload(evt *events.Event) (*events.EventPayload, error) {
	var payload events.EventPayload
	if err := json.Unmarshal(evt.Payload, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal event payload: %w", err)
	}
	return &payload, nil
}

func matchesTrigger(evt *events.Event, payload *events.EventPayload, triggers []paprikav1.NotificationTrigger) bool {
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

func renderMessage(tmpl string, payload *events.EventPayload) string {
	if tmpl == "" {
		return fmt.Sprintf("%s/%s is now %s%s",
			payload.Namespace, payload.Name, payload.Phase,
			reasonSuffix(payload.Reason))
	}
	t, err := template.New("notification").Parse(tmpl)
	if err != nil {
		return fmt.Sprintf("%s/%s is now %s%s",
			payload.Namespace, payload.Name, payload.Phase,
			reasonSuffix(payload.Reason))
	}
	var buf bytes.Buffer
	data := map[string]string{
		"resourceType":  payload.ResourceType,
		"name":          payload.Name,
		"namespace":     payload.Namespace,
		"phase":         payload.Phase,
		"previousPhase": payload.PreviousPhase,
		"reason":        payload.Reason,
		"message":       payload.Message,
		"timestamp":     payload.Timestamp,
	}
	if execErr := t.Execute(&buf, data); execErr != nil {
		return fmt.Sprintf("%s/%s is now %s%s",
			payload.Namespace, payload.Name, payload.Phase,
			reasonSuffix(payload.Reason))
	}
	return buf.String()
}

func reasonSuffix(reason string) string {
	if reason == "" {
		return ""
	}
	return " (" + reason + ")"
}

//nolint:cyclop // webhook dispatch handles multiple auth branches and response cleanup
func (s *NotificationSender) sendWebhook(ctx context.Context, url string, payload *events.EventPayload, headers, secret map[string]string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal webhook payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create webhook request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if t := secret["token"]; t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	} else if u, p := secret["username"], secret["password"]; u != "" && p != "" {
		req.SetBasicAuth(u, p)
	}
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("post webhook: %w", err)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			log.FromContext(ctx).Error(cerr, "Failed to close webhook response body")
		}
	}()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *NotificationSender) sendSlack(ctx context.Context, url, message string, secret map[string]string) error {
	body, err := json.Marshal(map[string]string{"text": message})
	if err != nil {
		return fmt.Errorf("marshal slack payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create slack request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if t := secret["token"]; t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("post slack: %w", err)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			log.FromContext(ctx).Error(cerr, "Failed to close slack response body")
		}
	}()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("slack returned status %d", resp.StatusCode)
	}
	return nil
}

// SetupWithManager registers the notification controller as a runnable.
func (r *NotificationConfigReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := mgr.Add(r); err != nil {
		return fmt.Errorf("register notification controller: %w", err)
	}
	return nil
}
