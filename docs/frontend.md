# Paprika Dashboard

The Paprika operator serves a built-in web dashboard on port `3000` (configurable via `--ui-bind-address`). The dashboard provides a real-time view of applications, pipelines, releases, stages, and cluster events.

## Accessing the Dashboard

The dashboard is not exposed outside the cluster by default. Use `kubectl port-forward` to access it locally:

```sh
kubectl port-forward -n paprika-system deployment/paprika-controller-manager 3000:3000
```

Then open:

```text
http://localhost:3000
```

If you are running the API or operator in a different mode, port-forward the relevant deployment:

```sh
kubectl port-forward -n paprika-system deployment/paprika-api 3000:3000
```

## Dashboard Overview

The home page (`/dashboard`) aggregates the most important delivery data:

- **Stat cards** — high-level counts for applications, pipelines, releases, and stages, plus overall health.
- **Application cards** — each application shows its current phase, current stage, sync state, and health.
- **Release table** — recent releases with phase, target stage, pipeline, and promotion history.
- **Pipeline cards** — pipeline phase, step progress, and max parallel settings.

Click any card or row to drill into the detail page for that resource.

## Live Events Stream

The dashboard subscribes to Server-Sent Events (SSE) at:

```text
GET /events?topic=apps
```

This keeps the UI in sync with the cluster without polling. Events are published by the API server's event broker and are available in-memory by default, or backed by Redis when `NewPaprikaServerWithRedis` is configured for multi-replica fan-out.

### Connection Status Indicator

The dashboard header shows a connection status indicator for the SSE stream:

- **Connected** — actively receiving events.
- **Reconnecting** — the connection dropped and the client is retrying with exponential backoff.
- **Disconnected** — the client stopped retrying, usually due to a terminal error or auth failure.

If the indicator stays disconnected, check that the port-forward is active and that the API server pod is healthy.

## Resource Pages

Each resource type has a dedicated page:

- `/dashboard` — overview
- Application detail — phase, stages, sync status, health checks, resources, and gates
- Pipeline detail — step definitions and live step statuses
- Release detail — promotion history and current stage
- Stage detail — ring, cluster reference, canary config, and traffic router

Pages retry failed fetches automatically with exponential backoff, so transient API errors do not require a manual refresh.

## Authentication

When the operator runs with `--auth-enabled=true`, the dashboard and API both require authentication. The dashboard supports the same Basic and OIDC flows as the API; configure them on the operator as described in the [authentication guide](guides/auth.md).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Dashboard blank or 404 | Verify the operator is running in `operator` or `api` mode and that port `3000` is forwarded. |
| Live updates stop | Check the SSE connection indicator; refresh the page or restart the port-forward. |
| Auth errors | Confirm `--auth-enabled` flags match your CLI/dashboard session and that the token has not expired. |
