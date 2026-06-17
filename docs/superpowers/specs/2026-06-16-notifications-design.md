# Notifications Design

## Goal

Make Paprika actively tell operators when something important happens, not just
record it in the cluster:

- **Slack alerts** on sync failure, rollback, and health degradation.
- **Email alerts** through an operator-managed SMTP relay.
- **Generic webhook notifications** for custom integrations (PagerDuty, Teams,
  custom incident systems).
- **Real-time UI toasts + notification center** surfaced from the existing
  Server-Sent Events (SSE) stream.

## Context

A surprising amount of the notification plumbing already exists:

- `api/pipelines/v1alpha1/notificationconfig_types.go` defines
  `NotificationConfig`, `NotificationTrigger`, and `NotificationDestination`.
- `internal/controller/pipelines/notification_controller.go` subscribes to
  `events.TopicDashboard`, matches triggers, and dispatches Slack / generic
  webhook payloads.
- `internal/api/events/broker.go` provides an in-memory or Redis-backed pub/sub
  broker used by both controllers and the UI.
- `internal/controller/pipelines/application_controller.go` publishes
  `application` events on every phase change via `publishApplicationEvent`.
- `internal/controller/pipelines/release_controller.go` publishes `release`
  events when a Release reaches a terminal phase (`Complete`, `Failed`,
  `RolledBack`).
- `internal/api/sse.go` exposes `/events?topic=dashboard` to the UI.
- `ui/src/lib/connection-context.tsx` already consumes the SSE stream and stores
  the last 100 events.

This design extends those pieces instead of building a parallel notification
system.

## What Already Works

| Feature | Status | Notes |
|---|---|---|
| `NotificationConfig` CRD | ✅ | Triggers, destinations, Go template |
| Slack incoming webhook | ✅ | `sendSlack` in notification controller |
| Generic JSON webhook | ✅ | `sendWebhook` in notification controller |
| Controller event publishing | ✅ | Application + Release phase changes |
| SSE event streaming | ✅ | `/events?topic=dashboard` |
| UI event consumption | ✅ | `connection-context.tsx` |
| RBAC for `NotificationConfig` | ✅ | `config/rbac/role.yaml` |

## What Must Be Added

1. **Email delivery** via SMTP.
2. **Destination authentication** (Kubernetes Secrets for webhook bearer tokens,
   SMTP credentials).
3. **Richer event payload** so notifications can include previous phase,
   failure reason, and human-readable message.
4. **Delivery status tracking** on `NotificationConfig`.
5. **API/UI surface**: proto messages, RPCs, toast stack, notification center.
6. **Rate limiting / cooldown** so a flapping Application does not spam a
   channel.

## API Changes

### `api/pipelines/v1alpha1/notificationconfig_types.go`

Extend the destination with auth and headers:

```go
// NotificationDestination describes where to deliver matched notifications.
type NotificationDestination struct {
    // Name is a human-readable identifier for this destination.
    // +optional
    Name string `json:"name,omitempty"`

    // WebhookURL is a generic HTTP endpoint that receives a JSON payload.
    // +optional
    WebhookURL string `json:"webhookUrl,omitempty"`

    // SlackWebhookURL is a Slack incoming webhook URL.
    // +optional
    SlackWebhookURL string `json:"slackWebhookUrl,omitempty"`

    // Email is a recipient email address.
    // +optional
    Email string `json:"email,omitempty"`

    // SecretRef names a Secret in the same namespace that holds credentials.
    // Keys depend on the destination type:
    //   - webhook/slack: "token" (bearer token) or "username"/"password".
    // +optional
    SecretRef string `json:"secretRef,omitempty"`

    // Headers are extra HTTP headers sent to webhookURL.
    // +optional
    Headers map[string]string `json:"headers,omitempty"`
}
```

Add SMTP configuration at the spec level (one relay per `NotificationConfig`):

```go
// SMTPConfig configures an email relay for this NotificationConfig.
type SMTPConfig struct {
    // Host of the SMTP relay.
    Host string `json:"host"`

    // Port of the SMTP relay. Defaults to 587.
    // +kubebuilder:default=587
    // +optional
    Port int `json:"port,omitempty"`

    // From address used in the envelope.
    From string `json:"from"`

    // TLSEnabled uses TLS instead of STARTTLS. When false (default) the
    // controller attempts STARTTLS and falls back to plain text if the server
    // does not advertise it.
    // +optional
    TLSEnabled bool `json:"tlsEnabled,omitempty"`

    // AuthSecretRef names a Secret in the same namespace with keys:
    //   - username
    //   - password
    // +optional
    AuthSecretRef string `json:"authSecretRef,omitempty"`
}
```

Add rate limiting:

```go
// NotificationRateLimit controls how often a matched trigger may fire.
type NotificationRateLimit struct {
    // MinInterval between notifications for the same (resource,phase) tuple.
    // Defaults to 5m.
    // +kubebuilder:default="5m"
    // +optional
    MinInterval string `json:"minInterval,omitempty"`
}
```

Add them to `NotificationConfigSpec`:

```go
type NotificationConfigSpec struct {
    Triggers []NotificationTrigger `json:"triggers,omitempty"`
    Destinations []NotificationDestination `json:"destinations,omitempty"`
    Template string `json:"template,omitempty"`

    // SMTP relay used for email destinations.
    // +optional
    SMTP *SMTPConfig `json:"smtp,omitempty"`

    // RateLimit reduces noise from flapping resources.
    // +optional
    RateLimit *NotificationRateLimit `json:"rateLimit,omitempty"`
}
```

Add delivery status:

```go
// NotificationDelivery records the outcome of one dispatch attempt.
type NotificationDelivery struct {
    DestinationName string `json:"destinationName"`
    Phase string `json:"phase,omitempty"`
    SentAt *metav1.Time `json:"sentAt,omitempty"`
    Success bool `json:"success"`
    Error string `json:"error,omitempty"`
}

// NotificationConfigStatus defines the observed state of NotificationConfig.
type NotificationConfigStatus struct {
    // Deliveries keeps the last N delivery attempts.
    // +optional
    Deliveries []NotificationDelivery `json:"deliveries,omitempty"`
}
```

### `api/pipelines/v1alpha1/application_types.go` / `release_types.go`

No CRD fields change. Events are constructed from existing status fields.

## Controller Behavior

### Rich event payload

`internal/controller/pipelines/notification_controller.go` currently decodes a
minimal payload. Replace `eventPayload` with a richer struct:

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

Update the publishers:

- `ApplicationReconciler.publishApplicationEvent` already has access to the
  phase. Capture the phase **before** `updatePhase` mutates `app.Status.Phase`,
  and pass it as `previousPhase`. Use the most recent condition's `Reason` and
  `Message` for the `reason` / `message` fields.
- `ReleaseReconciler.publishReleaseEvent` already receives `oldPhase`; pass it
  as `previousPhase` and include the latest condition's `Message`.

The notification controller still matches on `ResourceType`, `Phase`, and
`Reason`.

### Email sender

Create `internal/controller/pipelines/email_sender.go`:

```go
type EmailSender struct {
    SMTP SMTPConfig
}

func (s *EmailSender) Send(ctx context.Context, to, subject, body string) error
```

Implementation uses `net/smtp`:

- If `TLSEnabled` is true, dial with `tls.Dial` and send via `smtp.NewClient`.
- Otherwise, dial plain TCP, then attempt `STARTTLS` if the server advertises
  it, falling back to plain text.
- If `AuthSecretRef` is set, read the Secret and use `smtp.PlainAuth`.
- Build a MIME message with `text/plain` and `text/html` parts.

### Secret lookup

Add a small helper in the notification controller:

```go
func (r *NotificationConfigReconciler) resolveSecret(ctx context.Context, ns, name string) (map[string]string, error)
```

It reads the named Secret in the config's namespace and returns a map of
string keys. Use it for:

- SMTP `AuthSecretRef`.
- Destination `SecretRef` for webhook bearer tokens or basic auth.

### Dispatch flow

In `NotificationConfigReconciler.handleEvent`:

1. Decode the rich payload.
2. List all `NotificationConfigs` in the event's namespace.
3. For each config:
   - Skip if `rateLimit` would throttle this `(resource, phase)` tuple.
   - Skip if no trigger matches.
   - For each destination:
     - Build the message from `cfg.Spec.Template` or the default template.
     - Resolve the destination's `SecretRef` if set.
     - If `WebhookURL` is set, POST JSON with optional auth headers.
     - If `SlackWebhookURL` is set, POST the rendered text.
     - If `Email` is set and `cfg.Spec.SMTP` is configured, send email.
     - Record the delivery result.
4. After processing all configs, patch `cfg.Status.Deliveries`, keeping only
   the last 20 entries.

### Default templates

The existing default template is:

```
"{{ .namespace }}/{{ .name }} is now {{ .phase }}"
```

Update it to include reason when present:

```
"{{ .namespace }}/{{ .name }} is now {{ .phase }}{{ if .reason }} ({{ .reason }}){{ end }}"
```

Expose all rich payload keys to the Go template.

## API / UI Impact

### Proto additions

Add to `proto/paprika/v1/api.proto`:

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

Add RPCs to `service PaprikaService`:

```protobuf
rpc ListNotificationConfigs(ListNotificationConfigsRequest) returns (ListNotificationConfigsResponse);
```

Map `NotificationConfig` in `internal/api/server.go`:

```go
func convertNotificationConfig(c *pipelinesv1alpha1.NotificationConfig) *paprikav1.NotificationConfig
```

### UI changes

- **Toast stack**: create `ui/src/components/notifications/toast-stack.tsx`.
  It consumes `useConnection()`, filters events for `phase` in
  `{Failed, Degraded, RolledBack, Complete}` (with a user-dismissible toast),
  and renders them for 8 seconds.
- **Notification center**: add a bell icon to `ui/src/components/layout/nav.tsx`
  with a dropdown showing recent SSE events, timestamps, and a "Clear" action.
- Persist read state in `localStorage` so the bell badge reflects unread events.
- Add a new `ui/src/app/dashboard/notifications/page.tsx` for a full history
  view if needed.

## Safety

- **No loops**: the notification controller never publishes to
  `events.TopicDashboard`, so updating `NotificationConfig` status cannot
  trigger new notifications.
- **Secret isolation**: credentials are read from Secrets in the same namespace
  as the `NotificationConfig`; the controller never logs secret values.
- **Rate limiting**: per-config `minInterval` prevents alert storms.
- **Fail-open**: a failing destination must not block other destinations or
  other configs.
- **Email fallback**: if SMTP is not configured, email destinations are skipped
  with a clear status error.

## Status Conditions

No new top-level condition type is required. Delivery success/failure is
recorded in `status.deliveries`:

| Field | Meaning |
|---|---|
| `destinationName` | Which destination was tried |
| `phase` | Phase that triggered the dispatch |
| `sentAt` | Timestamp of the attempt |
| `success` | Whether delivery succeeded |
| `error` | Error message on failure |

## Generated Artifacts

Run after API and proto changes:

```bash
make generate manifests
make generate-proto
```

This updates:

- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/pipelines.paprika.io_notificationconfigs.yaml`
- `charts/chart/templates/crd/notificationconfigs.pipelines.paprika.io.yaml`
- `config/rbac/role.yaml` (new Secret read RBAC)
- `proto/paprika/v1/api.proto`
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

## Open Questions

1. Should we support per-destination templates? Useful but out of scope for the
   first iteration; use one template per `NotificationConfig`.
2. Should failed deliveries be retried with backoff? Out of scope; the
   controller records failures and relies on Kubernetes events / status.
3. Should notifications be cluster-scoped? Keep them namespaced so each team
   can manage its own alert routing.
