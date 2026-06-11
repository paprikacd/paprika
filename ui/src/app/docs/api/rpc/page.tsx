export default function RPCPage() {
  return (
    <div>
      <h1>RPC API</h1>
      <p className="lead">
        Paprika exposes a gRPC API for listing resources, syncing applications, and approving gates. The API is defined in <code>proto/paprika/v1/api.proto</code> and served by the operator on the gRPC port.
      </p>

      <hr />

      <h2>Service Definition</h2>
      <pre><code>{`service PaprikaService {
  rpc ListPipelines(ListPipelinesRequest) returns (ListPipelinesResponse);
  rpc ListReleases(ListReleasesRequest) returns (ListReleasesResponse);
  rpc ListStages(ListStagesRequest) returns (ListStagesResponse);
  rpc ListApplications(ListApplicationsRequest) returns (ListApplicationsResponse);
  rpc GetApplication(GetApplicationRequest) returns (GetApplicationResponse);
  rpc SyncApplication(SyncApplicationRequest) returns (SyncApplicationResponse);
  rpc ApproveGate(ApproveGateRequest) returns (ApproveGateResponse);
}`}</code></pre>

      <h2>RPC Reference</h2>

      <h3>ListPipelines</h3>
      <p>Returns all Pipeline resources, optionally filtered by namespace.</p>
      <pre><code>{`Request:
  namespace: string (optional)

Response:
  pipelines: []Pipeline`}</code></pre>

      <h3>ListReleases</h3>
      <p>Returns all Release resources, optionally filtered by namespace.</p>
      <pre><code>{`Request:
  namespace: string (optional)

Response:
  releases: []Release`}</code></pre>

      <h3>ListStages</h3>
      <p>Returns all Stage resources, optionally filtered by namespace.</p>
      <pre><code>{`Request:
  namespace: string (optional)

Response:
  stages: []Stage`}</code></pre>

      <h3>ListApplications</h3>
      <p>Returns all Application resources, optionally filtered by namespace.</p>
      <pre><code>{`Request:
  namespace: string (optional)

Response:
  applications: []Application`}</code></pre>

      <h3>GetApplication</h3>
      <p>Returns a single Application by name and namespace.</p>
      <pre><code>{`Request:
  name:      string
  namespace: string

Response:
  application: Application`}</code></pre>

      <h3>SyncApplication</h3>
      <p>Triggers a manual sync of the given Application. Creates a new Release if the source has changed.</p>
      <pre><code>{`Request:
  name:      string
  namespace: string

Response:
  application: Application (updated)`}</code></pre>

      <h3>ApproveGate</h3>
      <p>Approves a named gate on an Application, allowing promotion to proceed to the next stage.</p>
      <pre><code>{`Request:
  name:      string
  namespace: string
  gate:      string

Response:
  application: Application (with updated gate status)`}</code></pre>

      <h2>Message Types</h2>
      <table>
        <thead>
          <tr><th>Message</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>Application</td><td>Full application state including phase, stages, health, and resources</td></tr>
          <tr><td>ApplicationStage</td><td>Per-stage status (name, ring, phase, release, revision)</td></tr>
          <tr><td>ApplicationSource</td><td>Source configuration</td></tr>
          <tr><td>Pipeline</td><td>Pipeline with steps, phase, and step statuses</td></tr>
          <tr><td>Release</td><td>Release with phase, target, and promotion history</td></tr>
          <tr><td>Promotion</td><td>Promotion history entry (stage, result, timestamp)</td></tr>
          <tr><td>Stage</td><td>Stage summary (name, ring, phase)</td></tr>
          <tr><td>Step</td><td>Pipeline step definition (image, script, dependencies)</td></tr>
          <tr><td>StepStatus</td><td>Step execution status (phase, started/completed time)</td></tr>
          <tr><td>HealthCheck</td><td>CEL expression or HTTP probe check</td></tr>
          <tr><td>HealthCheckResult</td><td>Check result (status, message, optional HTTP details)</td></tr>
          <tr><td>ResourceSync</td><td>Resource sync status (Synced, OutOfSync, Missing, Pruned)</td></tr>
          <tr><td>ResourceHealth</td><td>Resource health status (Healthy, Progressing, Degraded, Unknown)</td></tr>
          <tr><td>GateStatus</td><td>Approval gate state (name, stage, status, approver)</td></tr>
          <tr><td>ChartRef</td><td>Helm chart reference (repo, name, version, local path)</td></tr>
          <tr><td>ArtifactRef</td><td>Pipeline artifact output reference</td></tr>
          <tr><td>TrafficRouter</td><td>Traffic routing config (provider + provider-specific config)</td></tr>
          <tr><td>IstioRouterConfig</td><td>Istio VirtualService route config</td></tr>
          <tr><td>GatewayAPIRouterConfig</td><td>Gateway API HTTPRoute backend config</td></tr>
          <tr><td>HTTPProbe</td><td>HTTP health probe definition (URL, headers, expected status)</td></tr>
        </tbody>
      </table>

      <h2>Connectivity</h2>
      <p>The gRPC API is served on port 8080 (configurable). A gRPC-web proxy may be used for browser clients. The dashboard UI consumes this API to display resource state.</p>
    </div>
  )
}
