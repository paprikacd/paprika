# In-process ARC observations

The operator optionally publishes ARC inventory to a Cuttlefish control plane.
It is disabled by default. The leader runs it in the manager process using the
manager's existing Kubernetes REST configuration and ServiceAccount. It adds
no RBAC, informer, external cloud identity, job dispatch, agent registration,
pod/node mutation or paid infrastructure.

Configure `PAPRIKA_ARC_OBSERVER_CONFIG` as JSON with an HTTPS origin, one concrete
inventory `projectId` and at most two local scale-set sources:

```json
{"endpoint":"https://control.example","projectId":"project-a","sources":[{"poolName":"ci-pool","runnerNamespace":"runners","systemNamespace":"systems","controllerDeployment":"controller","expectedMinRunners":0,"expectedMaxRunners":1}]}
```

Names and maxima above are examples. Supply the existing private deployment's
actual identities and observed/current configured maxima; they are assertions
of current configuration, not new capacity selections. Maxima drift produces
no new observation. The inventory audience is separate from GitHub repository
runner access and Cuttlefish execution/admission projects.

Set `PAPRIKA_ARC_OBSERVER_TOKEN_FILE` to an absolute path in a read-only mounted
Secret containing a separately approved `capacity-observer` credential bound
to the exact project/pools. Existing chart `manager.extraEnv`, `extraVolumes`
and `extraVolumeMounts` provide the configuration; no chart defaults or roles
need changing. Keep deployment-specific names/overlays in private infrastructure
repositories. Credential issuance requires the control-plane binding enforcement
to be deployed and verified first. Do not borrow GitHub, human, agent or broad
operator tokens.

Disable collection by removing the opt-in configuration through the existing
Helm/Paprika lifecycle. The last samples expire normally; no resource cleanup
or capacity mutation is necessary. Before rolling Cuttlefish back to an API
without writer enforcement, stop publishers and revoke their credentials.

The reader needs only namespaced GET of the named AutoscalingRunnerSet and
controller Deployment, and label-filtered LIST of listener Pods, runner Pods and
EphemeralRunners. It never opens Secret values, logs or exec endpoints. All pages
must complete within one eight-second read budget per round. Lists are bounded
to 512 objects and 16 pages and must maintain their pagination resource version.
There is no wildcard or cross-cluster lookup. Existing manager grants must be
verified before activation; this source does not add them.

Polling occurs every 20 seconds with no overlapping rounds. Each publication
has a three-second deadline; at most two sources keep the bounded round below
the interval. Samples retain their collection timestamp. Missing/incomplete or
old samples are omitted, so the receiver's existing 60-second expiry applies.
An HTTP or Kubernetes 401/403 stops observation until an operator restarts/reconfigures the
manager; no identity fallback or retry is attempted. Redirects are refused.
Read/publish error logs contain only a fixed reason and configured pool name.

Controller readiness checks observed generation and replica health; listener
readiness comes from current, non-terminating listener Pods. Worker counts union
active ER reservations and surviving execution Pods, including terminating Pods.
Unknown or duplicate ownership reports inaccessible. ER `status.phase=Running`
means assigned work in ARC 0.15.0; Pod Running alone never implies busy. Terminal
records disappear only after surviving execution Pods disappear. Node names are
execution Pod placement, not cloud VM inventory or a zero-billing assertion.

The outbound payload is limited to `observedAt`, `state`, `controllerReady`,
`listenerReady`, `workers`, `busy` and `nodes`. Raw objects, job identities,
repositories and credentials never enter it. Unit/race tests use isolated fake
Kubernetes and HTTPS endpoints to cover pagination, partial data, drift,
ownership, stale data, redaction, binding, denial and redirects. No new UI, CRD
or resource mutation exists; live observer acceptance remains a deployment test.
