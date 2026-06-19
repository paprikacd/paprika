package pipelines

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/go-logr/logr"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/clock"
)

var _ = Describe("Notification Controller", func() {
	ctx := context.Background()

	ensureNamespace := func(name string) {
		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
		if err := k8sClient.Create(ctx, ns); err != nil {
			Expect(client.IgnoreAlreadyExists(err)).To(BeNil())
		}
	}

	It("delivers a webhook notification when an Application fails", func() {
		ns := "notification-webhook"
		ensureNamespace(ns)

		var received []byte
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			received = body
			w.WriteHeader(http.StatusOK)
		}))
		DeferCleanup(server.Close)

		cfg := &paprikav1.NotificationConfig{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "test-notify",
				Namespace: ns,
			},
			Spec: paprikav1.NotificationConfigSpec{
				Triggers: []paprikav1.NotificationTrigger{
					{ResourceType: "application", Phase: "Failed"},
				},
				Destinations: []paprikav1.NotificationDestination{
					{Name: "webhook", WebhookURL: server.URL},
				},
			},
		}
		Expect(k8sClient.Create(ctx, cfg)).To(Succeed())

		r := NewNotificationConfigReconciler(k8sClient, events.NewBroker(logr.Discard()), NewNotificationSender(), nil, clock.Real{})

		evt, err := events.NewEvent(events.TypeApplication, &eventPayload{
			ResourceType:  events.TypeApplication,
			Name:          "test-app",
			Namespace:     ns,
			Phase:         string(paprikav1.ApplicationFailed),
			PreviousPhase: string(paprikav1.ApplicationPending),
			Reason:        "TestFailure",
			Message:       "application failed",
			Timestamp:     metav1.Now().UTC().Format(time.RFC3339),
		}, &clock.Fake{})
		Expect(err).NotTo(HaveOccurred())
		r.handleEvent(ctx, evt)

		Expect(received).NotTo(BeEmpty())
		var payload eventPayload
		Expect(json.Unmarshal(received, &payload)).To(Succeed())
		Expect(payload.Phase).To(Equal("Failed"))
		Expect(payload.Reason).To(Equal("TestFailure"))

		var updated paprikav1.NotificationConfig
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cfg), &updated)).To(Succeed())
		Expect(updated.Status.Deliveries).NotTo(BeEmpty())
		Expect(updated.Status.Deliveries[len(updated.Status.Deliveries)-1].Success).To(BeTrue())
	})

	It("resolves destination secrets for bearer token auth", func() {
		ns := "notification-secret"
		ensureNamespace(ns)

		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "webhook-secret",
				Namespace: ns,
			},
			Data: map[string][]byte{"token": []byte("bearer123")},
		}
		Expect(k8sClient.Create(ctx, secret)).To(Succeed())

		var authHeader string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader = r.Header.Get("Authorization")
			w.WriteHeader(http.StatusOK)
		}))
		DeferCleanup(server.Close)

		cfg := &paprikav1.NotificationConfig{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "secret-notify",
				Namespace: ns,
			},
			Spec: paprikav1.NotificationConfigSpec{
				Triggers: []paprikav1.NotificationTrigger{{ResourceType: "application", Phase: "Failed"}},
				Destinations: []paprikav1.NotificationDestination{
					{Name: "webhook", WebhookURL: server.URL, SecretRef: "webhook-secret"},
				},
			},
		}
		Expect(k8sClient.Create(ctx, cfg)).To(Succeed())

		r := NewNotificationConfigReconciler(k8sClient, events.NewBroker(logr.Discard()), NewNotificationSender(), nil, clock.Real{})

		evt, _ := events.NewEvent(events.TypeApplication, &eventPayload{
			ResourceType: events.TypeApplication,
			Name:         "app",
			Namespace:    ns,
			Phase:        "Failed",
			Timestamp:    metav1.Now().UTC().Format(time.RFC3339),
		}, &clock.Fake{})
		r.handleEvent(ctx, evt)

		Expect(authHeader).To(Equal("Bearer bearer123"))
	})

	It("records failed deliveries when SMTP is not configured", func() {
		ns := "notification-email"
		ensureNamespace(ns)

		cfg := &paprikav1.NotificationConfig{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "email-no-smtp",
				Namespace: ns,
			},
			Spec: paprikav1.NotificationConfigSpec{
				Triggers: []paprikav1.NotificationTrigger{{ResourceType: "application", Phase: "Failed"}},
				Destinations: []paprikav1.NotificationDestination{
					{Name: "email", Email: "ops@example.com"},
				},
			},
		}
		Expect(k8sClient.Create(ctx, cfg)).To(Succeed())

		r := NewNotificationConfigReconciler(k8sClient, events.NewBroker(logr.Discard()), NewNotificationSender(), nil, clock.Real{})

		evt, _ := events.NewEvent(events.TypeApplication, &eventPayload{
			ResourceType: events.TypeApplication,
			Name:         "app",
			Namespace:    ns,
			Phase:        "Failed",
			Timestamp:    metav1.Now().UTC().Format(time.RFC3339),
		}, &clock.Fake{})
		r.handleEvent(ctx, evt)

		var updated paprikav1.NotificationConfig
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cfg), &updated)).To(Succeed())
		Expect(updated.Status.Deliveries).To(HaveLen(1))
		Expect(updated.Status.Deliveries[0].Success).To(BeFalse())
		Expect(updated.Status.Deliveries[0].Error).To(ContainSubstring("SMTP is not set"))
	})
})
