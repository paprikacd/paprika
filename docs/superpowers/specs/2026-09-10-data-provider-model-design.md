# Data provider model — design

Status: approved in outline, spec under review
Date: 2026-09-10

## Problem

The console draws capacity meters, application signals and cost. Paprika has
none of that data. It cannot: capacity `used` needs metrics-server, per-service
latency and error rates need a metrics backend, and real spend needs a billing
source. Which of those exist is a property of the installation, not of Paprika.

Phase 0 of the console redesign made absence honest — every data class carries a
`DataState`, and `NOT_CONFIGURED` hides a surface rather than zeroing it. This
design supplies the other half: a way for an operator to say *where the data
comes from*, scoped to part of the fleet rather than all of it.

## Shape

Two concepts, following idioms already in this repo.

**Providers** select an implementation that works out an answer for a scenario.
Some read the Kubernetes API, some compute from data already held, some call an
external system. Where an implementation does need credentials, the provider is
where they live, which makes providers platform-team objects.

One kind per data class, because the classes have genuinely different
configuration:

- `CapacityProvider` — CPU and memory used, against requested and allocatable.
- `SignalProvider` — request rate, error rate, latency.
- `CostProvider` — spend, with an explicit basis.

**Bindings** attach a provider to part of the fleet. `DataProviderBinding` is a
single kind covering all three provider kinds via a typed reference. It holds no
credentials, so it can be delegated to project owners without granting access to
the secret the provider uses.

The split matters wherever credentials are involved. With scope inline on the
provider, delegating "which projects use this Prometheus" requires write access
to the object holding the Prometheus token. Separating them puts the RBAC
boundary where the trust boundary already is, and it follows `FeatureFlag` +
`FeatureFlagBinding`, which is how this repo already expresses "define once,
bind to a scope".

It earns its place even for credential-free implementations: one
`KubernetesCapacity` provider can be bound to every cluster without copying the
object per scope.

A provider instance names an **implementation from the registry** and carries
that implementation's configuration. The implementation is the primary thing; an
endpoint is configuration that some implementations happen to need and others do
not.

```yaml
apiVersion: providers.paprika.io/v1alpha1
kind: CapacityProvider
metadata: {name: in-cluster, namespace: paprika-system}
spec:
  provider: KubernetesCapacity   # registry key
  config: {}                     # this one needs nothing
  staleAfter: 90s
```

```yaml
apiVersion: providers.paprika.io/v1alpha1
kind: CapacityProvider
metadata: {name: prom-prod, namespace: paprika-system}
spec:
  provider: Prometheus
  config:
    endpoint: https://prom.internal:9090
    secretRef: {name: prom-auth, key: token}
    queries:
      cpuUsed: 'sum(rate(container_cpu_usage_seconds_total{cluster="$cluster"}[5m]))'
      memoryUsed: 'sum(container_memory_working_set_bytes{cluster="$cluster"})'
```

`config` is a `RawExtension`. Each registered implementation supplies its own
schema and validation, run at admission, so a provider is rejected for bad
configuration at apply time rather than discovered broken on first fetch. This
keeps the CRD from becoming a union of every implementation's fields — the
alternative that makes a provider registry unpleasant to extend.

```yaml
apiVersion: providers.paprika.io/v1alpha1
kind: DataProviderBinding
metadata: {name: prod-capacity, namespace: paprika-system}
spec:
  providerRef: {kind: CapacityProvider, name: prom-prod}
  scope: {kind: Cluster, name: prod-eu-1}   # or selector
```

## Resolution

One resolver, keyed by `(scope, class)`, returning the winning provider and its
`DataState`.

Precedence, most specific first: **Namespace > Cluster > Project > Global**.

Two bindings matching the same scope at the same level for the same class are
**rejected at admission**, not resolved arbitrarily. Two providers silently
competing for one scope is a 3am problem; a webhook rejection is a Tuesday
problem.

### On organisations

Paprika has no org or tenant type today — authorization scopes on `AppProject`
and namespace. An `Org` precedence level is therefore deliberately **not** built
here: there is nothing to bind it to and no way to test that it means anything.

The design leaves it cheap to add. `scope` is a `{kind, name}` pair rather than
a field per level, and precedence is an ordered list inside the resolver. If org
tenancy arrives elsewhere in Paprika, adding it here is one enum value and one
entry in that list — no schema migration, and nothing already bound changes
meaning.

## The provider registry

A provider is an implementation that works out an answer for a scenario, not a
transport. Some read the Kubernetes API, some compute from data already held,
some call out over the network. The registry holds them all behind one
interface, following the compile-time registration pattern already used by
`internal/investigator`.

An implementation declares three things: the config schema it accepts, whether
it needs network egress, and which fields of its data class it can actually
supply. That last one is what lets the console be honest per field rather than
per board.

### Base implementations

| Implementation | Class | Supplies | Reads | Egress |
|---|---|---|---|---|
| `KubernetesCapacity` | Capacity | `allocatable`, `requested` | `Node.status.allocatable`, pod `resources.requests` | none |
| `MetricsServer` | Capacity | `used` | `metrics.k8s.io` | none |
| `Prometheus` | Capacity, Signals | `used`, RED signals | PromQL over HTTP | yes |
| `RateCard` | Cost | estimated spend | requested capacity × a rate table | none |

`KubernetesCapacity` is the important one. It needs no configuration and no
external system, so **a default install has real allocatable and requested
capacity** — the console's capacity board works out of the box, with `used`
reporting `NOT_CONFIGURED` until `MetricsServer` or `Prometheus` is bound. That
is precisely the split `ResourceMeter`'s per-component `DataState` was designed
for, arrived at from the other direction.

It also lands on machinery that now exists: `internal/kube` gives it a warm,
protobuf-negotiated client per cluster, and nodes and pods are built-in types —
exactly the case where protobuf is both safe and worthwhile.

`RateCard` is the reason cost degrades usefully rather than absolutely: an
installation with no billing integration still gets an estimate, wire-labelled
`COST_BASIS_RATE_CARD` so it can never be mistaken for an invoice.

### Extending it

`Prometheus` is deliberately general — its queries are configuration, so Thanos,
Mimir, VictoriaMetrics and Grafana Cloud are all served by pointing it at a
different endpoint with different PromQL. No new implementation required.

A source that genuinely needs different logic — a cloud billing API, a bespoke
capacity model — ships as a new registered implementation. The interface is
small by construction: config in, a typed reading out, plus a declaration of
what it can supply.

## Security

Egress is a **per-implementation capability**, not a property of the model. Most
base implementations make no outbound call at all, and the controls below apply
only to those that declare they need one — which today is `Prometheus`.

For those, a user-supplied URL that the control plane fetches is an SSRF
primitive holding a service-account identity inside the cluster:

- **Egress allowlist** (CIDR and host) in operator configuration. Deny by
  default; a provider whose endpoint is not allowed fails admission.
- **Link-local is blocked outright.** `169.254.169.254` is the cloud metadata
  endpoint; reaching it is the whole attack.
- **No redirect following** — an allowlisted host must not be able to bounce the
  request somewhere else.
- **Credentials by `secretRef` only.** An inline credential is rejected at
  admission rather than accepted and logged.
- **Bounded responses**: request timeout, response size cap, series-cardinality
  cap, per-provider rate limit.
- **Fetches never run on the reconcile path.** Results are cached against
  `staleAfter`, so a slow provider degrades to `STALE` instead of stalling
  reconciliation.

## Reaching the console

No proto churn. The resolver populates the existing contract:

- `GetDataSources` reports each class as `OK` / `NOT_CONFIGURED` /
  `NOT_AVAILABLE` / `STALE` / `ERROR` for the caller's scope.
- `ResourceMeter`'s per-component states carry the asymmetry that motivated
  them: `requested` and `allocatable` stay `OK` from the Kubernetes API while
  `used` reports `NOT_CONFIGURED` until a `CapacityProvider` is bound.

This also resolves audit finding **B7**, where `capacity-meter.tsx` conflates
`NOT_CONFIGURED` with `NOT_AVAILABLE`. Under this model those become genuinely
different states with different fixes: *nobody bound a provider* versus *a bound
provider is failing*, the latter carrying its reason.

## Build order

1. **CRDs, binding, resolver, registry, admission** — the model itself, with no
   implementation that touches anything external.
2. **`KubernetesCapacity`** — no config, no egress, real numbers. This alone
   takes the capacity board from "cannot be built" to working on a default
   install, with `used` honestly absent.
3. **`MetricsServer`** — completes the meter by supplying `used`.
4. **`RateCard`** — cost as a labelled estimate, still no egress.
5. **`Prometheus`** behind the egress allowlist — the first outbound fetch, with
   the security controls above as its entry criteria.
6. **`SignalProvider`** on the proven machinery.

Steps 1–4 involve no outbound network call at all. Stopping after 3 leaves a
coherent, shippable system: capacity meters fully real, cost and signals
honestly absent.

## Testing

- Resolver: table tests over the precedence chain, including ties and the
  no-binding case.
- Admission: duplicate binding rejected; unknown `provider` key rejected; config
  failing the implementation's own schema rejected; inline credential rejected;
  endpoint outside the allowlist rejected; link-local rejected.
- Registry: an implementation that declares it supplies only `used` must not
  cause `allocatable` to be reported as `OK`.
- `KubernetesCapacity`: against a fake clientset with known node allocatable and
  pod requests, including pods that are pending (not yet scheduled, so not
  counted) and pods with no requests set at all.
- `MetricsServer` and `RateCard`: against fakes with known inputs.
- `Prometheus`: an httptest server for the happy path, plus explicit tests that
  a redirect is refused, an oversized response is truncated, and a timeout
  surfaces as `STALE` rather than an error.
- Console: a bound provider renders meters; an unbound one hides them; a failing
  one greys them with a reason.
