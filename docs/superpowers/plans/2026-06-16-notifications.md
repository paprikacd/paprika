# Notifications Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing notification scaffolding so Paprika can deliver
Slack, email, and generic webhook alerts when Applications and Releases change
phase, and surface those events as real-time toasts / a notification center in
the UI.

**Architecture:** Reuse the existing `events.Broker` + SSE stream. Extend
`NotificationConfig` with SMTP, destination secrets/headers, and rate limiting.
Add an SMTP sender. Enrich the event payload with previous phase, reason, and
message. Record delivery attempts in `NotificationConfigStatus`. Add proto RPCs
and UI toast/notification center components.

**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder, Protocol Buffers
(buf), Ginkgo/Gomega, envtest, React/TypeScript/Next.js, Tailwind CSS.

---

## Chunk 1: API Schema

### Task 1: Extend `NotificationConfig` types

**Files:**
- Modify: `api/pipelines/v1alpha1/notificationconfig_types.go`

- [ ] **Step 1: Add fields to `NotificationDestination`**

Insert inside `NotificationDestination` after `Email`:

```go
    // SecretRef names a Secret in the same namespace that holds credentials.
    // Keys depend on the destination type:
    //   - webhook/slack: "token" (bearer token) or "username"/"password".
    // +optional
    SecretRef string `json:"secretRef,omitempty"`

    // Headers are extra HTTP headers sent to webhookURL.
    // +optional
    Headers map[string]string `json:"headers,omitempty"`
```

- [ ] **Step 2: Add `SMTPConfig`**

Insert after `NotificationDestination`:

```go
// SMTPConfig configures an email relay for this NotificationConfig.
type SMTPConfig struct {
    Host string `json:"host"`

    // +kubebuilder:default=587
    // +optional
    Port int `json:"port,omitempty"`

    From string `json:"from"`

    // +optional
    TLSEnabled bool `json:"tlsEnabled,omitempty"`

    // AuthSecretRef names a Secret in the same namespace with keys:
    //   - username
    //   - password
    // +optional
    AuthSecretRef string `json:"authSecretRef,omitempty"`
}
```

- [ ] **Step 3: Add `NotificationRateLimit`**

Insert after `SMTPConfig`:

```go
// NotificationRateLimit controls how often a matched trigger may fire.
type NotificationRateLimit struct {
    // +kubebuilder:default="5m"
    // +optional
    MinInterval string `json:"minInterval,omitempty"`
}
```

- [ ] **Step 4: Extend `NotificationConfigSpec`**

Add to `NotificationConfigSpec` after `Template`:

```go
    // SMTP relay used for email destinations.
    // +optional
    SMTP *SMTPConfig `json:"smtp,omitempty"`

    // RateLimit reduces noise from flapping resources.
    // +optional
    RateLimit *NotificationRateLimit `json:"rateLimit,omitempty"`
```

- [ ] **Step 5: Add `NotificationDelivery` and extend status**

Replace `NotificationConfigStatus` with:

```go
// NotificationDelivery records the outcome of one dispatch attempt.
type NotificationDelivery struct {
    DestinationName string       `json:"destinationName"`
    Phase           string       `json:"phase,omitempty"`
    SentAt          *metav1.Time `json:"sentAt,omitempty"`
    Success         bool         `json:"success"`
    Error           string       `json:"error,omitempty"`
}

// NotificationConfigStatus defines the observed state of NotificationConfig.
type NotificationConfigStatus struct {
    // Deliveries keeps the last N delivery attempts.
    // +optional
    Deliveries []NotificationDelivery `json:"deliveries,omitempty"`
}
```

- [ ] **Step 6: Run `go fmt`**

### Task 2: Regenerate deepcopy and CRDs

- [ ] **Step 1: Run code generation**

```bash
make generate
```

Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` gains
`DeepCopyInto` for `SMTPConfig`, `NotificationRateLimit`,
`NotificationDelivery`, and updated `NotificationConfigSpec`/`Status`.

- [ ] **Step 2: Run manifest generation**

```bash
make manifests
```

Expected changes:

- `config/crd/bases/pipelines.paprika.io_notificationconfigs.yaml` gains
  `spec.smtp`, `spec.rateLimit`, `status.deliveries`, and destination
  `secretRef`/`headers`.
- `config/rbac/role.yaml` is updated in the next chunk.

### Task 3: Sync Helm chart CRD

- [ ] **Step 1: Regenerate Helm chart**

```bash
make helm-generate
```

- [ ] **Step 2: Verify the Helm CRD**

```bash
git diff -- charts/chart/templates/crd/notificationconfigs.pipelines.paprika.io.yaml
```

### Task 4: Add a sample NotificationConfig

**Files:**
- Create: `config/samples/pipelines_v1alpha1_notificationconfig.yaml`

- [ ] **Step 1: Write sample**

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: NotificationConfig
metadata:
  name: notificationconfig-sample
  labels:
    app.kubernetes.io/name: paprika
    app.kubernetes.io/managed-by: kustomize
spec:
  triggers:
    - resourceType: application
      phase: Failed
    - resourceType: release
      phase: RolledBack
  destinations:
    - name: slack-alerts
      slackWebhookUrl: https://hooks.slack.com/services/REPLACE/ME
    - name: ops-email
      email: oncall@example.com
  smtp:
    host: smtp.example.com
    port: 587
    from: paprika@example.com
    authSecretRef: smtp-auth
  rateLimit:
    minInterval: 5m
  template: |
    {{ .namespace }}/{{ .name }} moved from {{ .previousPhase }} to {{ .phase }}{{ if .reason }} ({{ .reason }}){{ end }}
```

---

## Chunk 2: Rich Events and Publishers

### Task 5: Enrich the event payload

**Files:**
- Modify: `internal/controller/pipelines/notification_controller.go`
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Replace `eventPayload` in `notification_controller.go`**

```go
type eventPayload struct {
    ResourceType  string `json:"resourceType"`
    Name          string `json:"name"`
    Namespace     string `json:"namespace"`
    Phase         string `json:"phase"`
    PreviousPhase string `json:"previousPhase,omitempty"`
    Reason        string `json:"reason,omitempty"`
    Message       string `json:"message,omitempty"`
    Timestamp     string `json:"timestamp"`
}
```

- [ ] **Step 2: Update `renderMessage` data map**

Include the new payload keys in the template data map inside `renderMessage`:

```go
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
```

- [ ] **Step 3: Update default message**

Change the fallback/default message to include reason:

```go
return fmt.Sprintf("%s/%s is now %s%s",
    payload.Namespace, payload.Name, payload.Phase,
    reasonSuffix(payload.Reason))
```

- [ ] **Step 4: Update `ApplicationReconciler.publishApplicationEvent`**

Capture the phase before mutation and include the latest condition reason/message:

```go
func (r *ApplicationReconciler) updatePhase(ctx context.Context, app *paprikav1.Application, phase paprikav1.ApplicationPhase, reason, message string) {
    previousPhase := app.Status.Phase
    ... existing phase update logic ...
    r.publishApplicationEvent(ctx, app, reason, previousPhase, message)
}

func (r *ApplicationReconciler) publishApplicationEvent(ctx context.Context, app *paprikav1.Application, reason string, previousPhase paprikav1.ApplicationPhase, message string) {
    if r.EventBroker == nil {
        return
    }
    evt, err := events.NewEvent(events.TypeApplication, eventPayload{
        ResourceType:  events.TypeApplication,
        Name:          app.Name,
        Namespace:     app.Namespace,
        Phase:         string(app.Status.Phase),
        PreviousPhase: string(previousPhase),
        Reason:        reason,
        Message:       message,
        Timestamp:     metav1.Now().UTC().Format(time.RFC3339),
    })
    ...
}
```

- [ ] **Step 5: Update `ReleaseReconciler.publishReleaseEvent`**

Add previous phase and latest condition message:

```go
func (r *ReleaseReconciler) publishReleaseEvent(ctx context.Context, release *paprikav1.Release, oldPhase paprikav1.ReleasePhase) {
    ...
    reason := ""
    message := ""
    if len(release.Status.Conditions) > 0 {
        c := release.Status.Conditions[len(release.Status.Conditions)-1]
        reason = c.Reason
        message = c.Message
    }
    evt, err := events.NewEvent(events.TypeRelease, eventPayload{
        ResourceType:  events.TypeRelease,
        Name:          release.Name,
        Namespace:     release.Namespace,
        Phase:         string(release.Status.Phase),
        PreviousPhase: string(oldPhase),
        Reason:        reason,
        Message:       message,
        Timestamp:     metav1.Now().UTC().Format(time.RFC3339),
    })
    ...
}
```

---

## Chunk 3: Notification Controller Dispatch

### Task 6: Add secret resolution

**Files:**
- Modify: `internal/controller/pipelines/notification_controller.go`

- [ ] **Step 1: Add secret helper**

```go
func (r *NotificationConfigReconciler) resolveSecret(ctx context.Context, ns, name string) (map[string]string, error) {
    var sec corev1.Secret
    if err := r.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &sec); err != nil {
        return nil, fmt.Errorf("getting secret %s/%s: %w", ns, name, err)
    }
    out := make(map[string]string, len(sec.Data))
    for k, v := range sec.Data {
        out[k] = string(v)
    }
    return out, nil
}
```

- [ ] **Step 2: Add RBAC marker for Secret read**

At the top of `notification_controller.go`, add:

```go
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch
```

### Task 7: Add rate-limit tracking

**Files:**
- Modify: `internal/controller/pipelines/notification_controller.go`

- [ ] **Step 1: Add rate-limit state to the reconciler**

```go
type rateLimitKey struct {
    configName string
    resource   string
    phase      string
}

type NotificationConfigReconciler struct {
    client.Client
    EventBroker *events.Broker
    Sender      *NotificationSender
    Emailer     *EmailSender
    rateLimits  map[rateLimitKey]time.Time
    rateMu      sync.Mutex
}
```

- [ ] **Step 2: Add rate-limit check helper**

```go
func (r *NotificationConfigReconciler) rateLimitAllowed(cfg *paprikav1.NotificationConfig, payload eventPayload) bool {
    if cfg.Spec.RateLimit == nil || cfg.Spec.RateLimit.MinInterval == "" {
        return true
    }
    d, err := time.ParseDuration(cfg.Spec.RateLimit.MinInterval)
    if err != nil {
        return true
    }
    key := rateLimitKey{configName: cfg.Name, resource: payload.ResourceType + "/" + payload.Namespace + "/" + payload.Name, phase: payload.Phase}
    r.rateMu.Lock()
    defer r.rateMu.Unlock()
    if last, ok := r.rateLimits[key]; ok && time.Since(last) < d {
        return false
    }
    r.rateLimits[key] = time.Now()
    return true
}
```

### Task 8: Create the email sender

**Files:**
- Create: `internal/controller/pipelines/email_sender.go`
- Create: `internal/controller/pipelines/email_sender_test.go`

- [ ] **Step 1: Implement SMTP sender**

```go
package controller

import (
    "context"
    "crypto/tls"
    "fmt"
    "net"
    "net/smtp"
    "strings"

    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

type EmailSender struct {
    SMTP paprikav1.SMTPConfig
    Auth smtp.Auth
}

func NewEmailSender(cfg paprikav1.SMTPConfig, auth smtp.Auth) *EmailSender {
    return &EmailSender{SMTP: cfg, Auth: auth}
}

func (s *EmailSender) Send(ctx context.Context, to, subject, body string) error {
    host := s.SMTP.Host
    port := s.SMTP.Port
    if port == 0 {
        port = 587
    }
    addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))

    msg := buildMimeMessage(s.SMTP.From, to, subject, body)

    if s.SMTP.TLSEnabled {
        conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host})
        if err != nil {
            return fmt.Errorf("tls dial: %w", err)
        }
        defer conn.Close()
        client, err := smtp.NewClient(conn, host)
        if err != nil {
            return fmt.Errorf("smtp client: %w", err)
        }
        defer client.Close()
        return sendWithClient(ctx, client, s.Auth, s.SMTP.From, []string{to}, msg)
    }

    client, err := smtp.Dial(addr)
    if err != nil {
        return fmt.Errorf("smtp dial: %w", err)
    }
    defer client.Close()
    if ok, _ := client.Extension("STARTTLS"); ok {
        if err := client.StartTLS(&tls.Config{ServerName: host}); err != nil {
            return fmt.Errorf("starttls: %w", err)
        }
    }
    return sendWithClient(ctx, client, s.Auth, s.SMTP.From, []string{to}, msg)
}

func sendWithClient(ctx context.Context, client *smtp.Client, auth smtp.Auth, from string, to []string, msg []byte) error {
    if auth != nil {
        if err := client.Auth(auth); err != nil {
            return fmt.Errorf("smtp auth: %w", err)
        }
    }
    if err := client.Mail(from); err != nil {
        return err
    }
    for _, rcpt := range to {
        if err := client.Rcpt(rcpt); err != nil {
            return err
        }
    }
    w, err := client.Data()
    if err != nil {
        return err
    }
    if _, err := w.Write(msg); err != nil {
        return err
    }
    if err := w.Close(); err != nil {
        return err
    }
    return client.Quit()
}

func buildMimeMessage(from, to, subject, body string) []byte {
    var b strings.Builder
    fmt.Fprintf(&b, "From: %s\r\n", from)
    fmt.Fprintf(&b, "To: %s\r\n", to)
    fmt.Fprintf(&b, "Subject: %s\r\n", subject)
    b.WriteString("MIME-Version: 1.0\r\n")
    b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
    b.WriteString("\r\n")
    b.WriteString(body)
    return []byte(b.String())
}
```

- [ ] **Step 2: Add unit tests**

Use a fake `net.Listener` that speaks enough SMTP to verify the message is
received. Test plain, STARTTLS, and TLS paths with self-signed certs.

### Task 9: Wire email and status recording into dispatch

**Files:**
- Modify: `internal/controller/pipelines/notification_controller.go`

- [ ] **Step 1: Update `handleEvent` to build SMTP auth from secret**

When `cfg.Spec.SMTP != nil` and `cfg.Spec.SMTP.AuthSecretRef != ""`:

```go
secrets, err := r.resolveSecret(ctx, cfg.Namespace, cfg.Spec.SMTP.AuthSecretRef)
if err != nil {
    log.FromContext(ctx).Error(err, "Failed to resolve SMTP secret", "config", cfg.Name)
} else {
    auth = smtp.PlainAuth("", secrets["username"], secrets["password"], cfg.Spec.SMTP.Host)
}
emailer := NewEmailSender(*cfg.Spec.SMTP, auth)
```

- [ ] **Step 2: Update per-destination dispatch**

For each destination:

```go
var deliveryErr error
switch {
case dest.WebhookURL != "":
    deliveryErr = r.Sender.sendWebhook(ctx, dest.WebhookURL, payload, dest.Headers, secret)
case dest.SlackWebhookURL != "":
    deliveryErr = r.Sender.sendSlack(ctx, dest.SlackWebhookURL, message, secret)
case dest.Email != "" && emailer != nil:
    deliveryErr = emailer.Send(ctx, dest.Email, fmt.Sprintf("Paprika: %s/%s %s", payload.Namespace, payload.Name, payload.Phase), message)
}
record := paprikav1.NotificationDelivery{...}
r.appendDelivery(cfg, record)
```

- [ ] **Step 3: Update `sendWebhook` to support headers and auth**

```go
func (s *NotificationSender) sendWebhook(ctx context.Context, url string, payload eventPayload, headers map[string]string, secret map[string]string) error {
    body, err := json.Marshal(payload)
    ...
    for k, v := range headers {
        req.Header.Set(k, v)
    }
    if t := secret["token"]; t != "" {
        req.Header.Set("Authorization", "Bearer "+t)
    } else if u, p := secret["username"], secret["password"]; u != "" && p != "" {
        req.SetBasicAuth(u, p)
    }
    ...
}
```

- [ ] **Step 4: Update `sendSlack` to support bearer token**

```go
func (s *NotificationSender) sendSlack(ctx context.Context, url, message string, secret map[string]string) error {
    ...
    if t := secret["token"]; t != "" {
        req.Header.Set("Authorization", "Bearer "+t)
    }
    ...
}
```

- [ ] **Step 5: Add delivery recording helper**

```go
func (r *NotificationConfigReconciler) appendDelivery(cfg *paprikav1.NotificationConfig, d paprikav1.NotificationDelivery) {
    cfg.Status.Deliveries = append(cfg.Status.Deliveries, d)
    if len(cfg.Status.Deliveries) > 20 {
        cfg.Status.Deliveries = cfg.Status.Deliveries[len(cfg.Status.Deliveries)-20:]
    }
}
```

- [ ] **Step 6: Patch status after each batch**

At the end of `handleEvent`:

```go
if err := r.Status().Update(ctx, cfg); err != nil {
    log.FromContext(ctx).Error(err, "Failed to update NotificationConfig status", "config", cfg.Name)
}
```

---

## Chunk 4: Proto and API Surface

### Task 10: Add NotificationConfig messages to proto

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Add messages before `service PaprikaService`**

```protobuf
message NotificationTrigger {
  string resource_type = 1;
  string phase = 2;
  string reason = 3;
}

message NotificationDestination {
  string name = 1;
  string webhook_url = 2;
  string slack_webhook_url = 3;
  string email = 4;
  string secret_ref = 5;
  map<string, string> headers = 6;
}

message SMTPConfig {
  string host = 1;
  int32 port = 2;
  string from = 3;
  bool tls_enabled = 4;
  string auth_secret_ref = 5;
}

message NotificationRateLimit {
  string min_interval = 1;
}

message NotificationConfig {
  string name = 1;
  string namespace = 2;
  repeated NotificationTrigger triggers = 3;
  repeated NotificationDestination destinations = 4;
  string template = 5;
  SMTPConfig smtp = 6;
  NotificationRateLimit rate_limit = 7;
}

message ListNotificationConfigsRequest {
  optional string namespace = 1;
}

message ListNotificationConfigsResponse {
  repeated NotificationConfig notification_configs = 1;
}
```

- [ ] **Step 2: Add RPC**

```protobuf
rpc ListNotificationConfigs(ListNotificationConfigsRequest) returns (ListNotificationConfigsResponse);
```

### Task 11: Regenerate protobuf clients

- [ ] **Step 1: Run proto generation**

```bash
make generate-proto
```

Expected updates:

- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

### Task 12: Implement API handler

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Add `ListNotificationConfigs` handler**

```go
func (s *PaprikaServer) ListNotificationConfigs(
    ctx context.Context,
    req *connect.Request[paprikav1.ListNotificationConfigsRequest],
) (*connect.Response[paprikav1.ListNotificationConfigsResponse], error) {
    var list pipelinesv1alpha1.NotificationConfigList
    opts := []client.ListOption{}
    if req.Msg.Namespace != nil {
        opts = append(opts, client.InNamespace(*req.Msg.Namespace))
    }
    if err := s.List(ctx, &list, opts...); err != nil {
        return nil, fmt.Errorf("listing notification configs: %w", err)
    }
    configs := make([]*paprikav1.NotificationConfig, 0, len(list.Items))
    for i := range list.Items {
        configs = append(configs, convertNotificationConfig(&list.Items[i]))
    }
    return connect.NewResponse(&paprikav1.ListNotificationConfigsResponse{NotificationConfigs: configs}), nil
}
```

- [ ] **Step 2: Add `convertNotificationConfig` helper**

```go
func convertNotificationConfig(c *pipelinesv1alpha1.NotificationConfig) *paprikav1.NotificationConfig {
    triggers := make([]*paprikav1.NotificationTrigger, 0, len(c.Spec.Triggers))
    for _, t := range c.Spec.Triggers {
        triggers = append(triggers, &paprikav1.NotificationTrigger{
            ResourceType: t.ResourceType,
            Phase:        t.Phase,
            Reason:       t.Reason,
        })
    }
    destinations := make([]*paprikav1.NotificationDestination, 0, len(c.Spec.Destinations))
    for _, d := range c.Spec.Destinations {
        destinations = append(destinations, &paprikav1.NotificationDestination{
            Name:            d.Name,
            WebhookUrl:      d.WebhookURL,
            SlackWebhookUrl: d.SlackWebhookURL,
            Email:           d.Email,
            SecretRef:       d.SecretRef,
            Headers:         d.Headers,
        })
    }
    cfg := &paprikav1.NotificationConfig{
        Name:         c.Name,
        Namespace:    c.Namespace,
        Triggers:     triggers,
        Destinations: destinations,
        Template:     c.Spec.Template,
    }
    if c.Spec.SMTP != nil {
        cfg.Smtp = &paprikav1.SMTPConfig{
            Host:          c.Spec.SMTP.Host,
            Port:          int32(c.Spec.SMTP.Port),
            From:          c.Spec.SMTP.From,
            TlsEnabled:    c.Spec.SMTP.TLSEnabled,
            AuthSecretRef: c.Spec.SMTP.AuthSecretRef,
        }
    }
    if c.Spec.RateLimit != nil {
        cfg.RateLimit = &paprikav1.NotificationRateLimit{
            MinInterval: c.Spec.RateLimit.MinInterval,
        }
    }
    return cfg
}
```

---

## Chunk 5: UI Notifications

### Task 13: Toast notifications

**Files:**
- Create: `ui/src/components/notifications/toast-stack.tsx`
- Modify: `ui/src/app/layout.tsx` or `ui/src/app/dashboard/page.tsx`

- [ ] **Step 1: Create toast component**

```tsx
"use client"

import { useEffect, useState } from "react"
import { useConnection } from "@/lib/connection-context"
import { X, Bell, AlertTriangle, CheckCircle2, Info } from "lucide-react"

const icons: Record<string, typeof Info> = {
  Failed: AlertTriangle,
  Degraded: AlertTriangle,
  RolledBack: AlertTriangle,
  Complete: CheckCircle2,
}

export function ToastStack() {
  const { events } = useConnection()
  const [toasts, setToasts] = useState<{ id: number; title: string; body: string; phase: string }[]>([])

  useEffect(() => {
    if (events.length === 0) return
    const last = events[events.length - 1]
    let data
    try { data = JSON.parse(last) } catch { return }
    const phase = data.payload?.phase
    if (!["Failed", "Degraded", "RolledBack", "Complete"].includes(phase)) return
    const payload = data.payload
    const title = `${payload.namespace}/${payload.name}`
    const body = `${payload.resourceType} is now ${phase}${payload.reason ? ` (${payload.reason})` : ""}`
    const id = Date.now()
    setToasts((prev) => [...prev.slice(-4), { id, title, body, phase }])
    const t = setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 8000)
    return () => clearTimeout(t)
  }, [events])

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => {
        const Icon = icons[t.phase] || Info
        return (
          <div key={t.id} className="flex w-80 items-start gap-3 rounded-lg border bg-background p-3 shadow-lg">
            <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.title}</p>
              <p className="text-xs text-muted-foreground">{t.body}</p>
            </div>
            <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>
              <X className="size-4 text-muted-foreground" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Mount `<ToastStack />`**

Add it to `ui/src/app/dashboard/page.tsx` near the bottom, inside the
`ErrorBoundary`.

### Task 14: Notification center

**Files:**
- Create: `ui/src/components/notifications/notification-center.tsx`
- Modify: `ui/src/components/layout/nav.tsx`

- [ ] **Step 1: Build notification center dropdown**

Read `events` from `useConnection()`, parse payloads, store `readIds` in
`localStorage`, render a bell with unread count, and show recent events in a
dropdown with timestamps and a "Clear" button.

- [ ] **Step 2: Add bell to nav**

Import `<NotificationCenter />` into `nav.tsx` and render it next to the
existing navigation items.

---

## Chunk 6: Tests and Final Verification

### Task 15: Unit tests

**Files:**
- Create/Modify: `internal/controller/pipelines/email_sender_test.go`
- Create/Modify: `internal/controller/pipelines/notification_controller_test.go`

- [ ] **Step 1: Test email sender**

- Plain SMTP delivery.
- STARTTLS fallback.
- TLS delivery.
- Missing recipient returns error.

- [ ] **Step 2: Test notification dispatch**

- Secret resolution for webhook bearer token.
- Secret resolution for SMTP auth.
- Rate limiting blocks rapid repeats.
- Delivery status is appended.
- Email destination is skipped when SMTP is nil.

### Task 16: Envtest coverage

**Files:**
- Create: `internal/controller/pipelines/notification_envtest_test.go`

- [ ] **Step 1: Write envtest spec**

```go
package controller

var _ = ginkgo.Describe("Notification Controller", func() {
    ctx := context.Background()

    ginkgo.It("delivers a webhook notification when an Application fails", func() {
        // Start a httptest server, create a NotificationConfig with its URL,
        // create an Application, force its status to Failed, publish an event,
        // and assert the server received a JSON payload with phase=Failed.
    })
})
```

### Task 17: Final verification

- [ ] **Step 1: Run linter**

```bash
make lint
```

Expected: no errors.

- [ ] **Step 2: Run unit/envtest suite**

```bash
make test
```

Expected: all tests pass.

- [ ] **Step 3: Commit the implementation**

```bash
git add -A
git commit -m "feat(pipelines): add notifications (SMTP, secrets, toasts)

- Extend NotificationConfig with SMTP, destination secrets/headers, and rate limiting
- Add SMTP email sender
- Enrich application/release events with previous phase, reason, and message
- Record delivery status on NotificationConfig
- Add ListNotificationConfigs RPC and UI notification toasts/center"
```

---

## Notes for Implementers

- The design spec is at `/Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-16-notifications-design.md`.
- Do not modify `config/crd/bases/*.yaml`, `config/rbac/role.yaml`,
  `**/zz_generated.*.go`, or `PROJECT` by hand; always regenerate via `make`.
- Keep the notification controller fail-open: one bad destination must not
  break another.
- UI toasts should be unobtrusive; the notification center is the primary way
  to review historical events.
