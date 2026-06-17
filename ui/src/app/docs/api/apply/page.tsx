export default function ApplyAPIPage() {
  return (
    <div>
      <h1>Connect-RPC API — Apply &amp; Rollback</h1>
      <p className="lead">
        This page documents the Connect-RPC methods used by <code>paprika apply</code> and rollback workflows. The full service definition is in <code>proto/paprika/v1/api.proto</code>.
      </p>

      <hr />

      <h2><code>ApplyBundle</code></h2>
      <p>Submit a rendered manifest bundle to create or update an Application, Stage, Release, and manifest snapshot.</p>

      <h3>Request</h3>
      <pre><code>{`message ApplyBundleRequest {
  string namespace = 1;          // Target namespace (required)
  string name = 2;               // Application name (required)
  bytes manifests = 3;           // YAML bundle
  repeated string skip_policies = 4;
  map<string, string> policy_overrides = 5;  // policy name -> "enforce" | "warn"
  bool dry_run = 6;
  string project = 7;            // AppProject name; defaults to "default"
}`}</code></pre>

      <h3>Response</h3>
      <pre><code>{`message ApplyBundleResponse {
  Application application = 1;
  Release release = 2;
  repeated PolicyResult policy_results = 3;
  bool blocked = 4;
  string block_reason = 5;
}`}</code></pre>

      <h3>Behavior</h3>
      <ol>
        <li>The server ensures the target namespace exists.</li>
        <li>It parses the bundle, defaults missing namespaces, and injects <code>app.paprika.io/managed-by</code> and <code>app.paprika.io/name</code> labels.</li>
        <li>It resolves the <code>AppProject</code> (<code>default</code> if empty) and validates project boundaries when governance is enabled.</li>
        <li>It evaluates matching <code>Policy</code> CRDs, honoring <code>skip_policies</code> and <code>policy_overrides</code>.</li>
        <li>If any enforced policy fails, the response has <code>blocked: true</code>, <code>block_reason</code> is set, and no resources are created.</li>
        <li>If <code>dry_run</code> is true, the response contains the rendered Application/Release shapes and policy results but no resources are persisted.</li>
        <li>Otherwise, the server creates or updates the <code>Application</code>, creates a <code>Stage</code> named <code>{"{app}"}-default</code>, creates a unique <code>Release</code>, and stores the bundle in a snapshot <code>ConfigMap</code> named <code>{"{release}"}-manifests</code>.</li>
      </ol>

      <h3>Policy result</h3>
      <pre><code>{`message PolicyResult {
  string name = 1;
  string severity = 2;   // "critical" | "warning"
  string action = 3;     // "enforce" | "warn"
  bool passed = 4;
  string message = 5;
}`}</code></pre>

      <h3>Example curl-like request</h3>
      <pre><code>{`curl -H "Content-Type: application/json" \\
  -H "Connect-Protocol-Version: 1" \\
  --data '{
    "namespace": "production",
    "name": "payments-api",
    "project": "payments",
    "manifests": "YXBpVmVy...",
    "skipPolicies": [],
    "policyOverrides": {"require-labels": "warn"},
    "dryRun": false
  }' \\
  http://localhost:3000/paprika.v1.PaprikaService/ApplyBundle`}</code></pre>

      <h3>Example response</h3>
      <pre><code>{`{
  "application": {
    "name": "payments-api",
    "namespace": "production",
    "phase": "Promoting",
    "project": "payments"
  },
  "release": {
    "name": "payments-api-release-a1b2c3d4-1750000000",
    "namespace": "production",
    "phase": "Promoting",
    "target": "payments-api-default"
  },
  "policyResults": [
    {"name": "require-labels", "severity": "critical", "action": "enforce", "passed": true, "message": ""}
  ],
  "blocked": false
}`}</code></pre>

      <h2><code>RollbackRelease</code></h2>
      <p>Request that a release be rolled back to the previous viable snapshot.</p>

      <h3>Request</h3>
      <pre><code>{`message RollbackReleaseRequest {
  string namespace = 1;
  string name = 2;       // Release name
}`}</code></pre>

      <h3>Response</h3>
      <pre><code>{`message RollbackReleaseResponse {
  Release release = 1;
}`}</code></pre>

      <h3>Behavior</h3>
      <p>
        The server fetches the named <code>Release</code>, sets the annotation <code>paprika.io/rollback-requested: &quot;true&quot;</code>, and ensures <code>spec.onFailure.action</code> is set to <code>rollback</code>. The release controller observes the annotation and applies the previous release&apos;s manifest snapshot. The response returns the updated <code>Release</code> with the new annotation.
      </p>

      <h3>Example curl-like request</h3>
      <pre><code>{`curl -H "Content-Type: application/json" \\
  -H "Connect-Protocol-Version: 1" \\
  --data '{
    "namespace": "production",
    "name": "payments-api-release-a1b2c3d4-1750000000"
  }' \\
  http://localhost:3000/paprika.v1.PaprikaService/RollbackRelease`}</code></pre>

      <h3>Example response</h3>
      <pre><code>{`{
  "release": {
    "name": "payments-api-release-a1b2c3d4-1750000000",
    "namespace": "production",
    "phase": "Failed",
    "rolledBackTo": "payments-api-release-z9y8x7w6-1749900000"
  }
}`}</code></pre>
    </div>
  )
}
