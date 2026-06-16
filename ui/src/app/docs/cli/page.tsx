export default function CLIPage() {
  return (
    <div>
      <h1><code>paprika apply</code></h1>
      <p className="lead">
        Apply raw Kubernetes manifests through Paprika so they are versioned, governed by policy, and tracked in the dashboard.
      </p>

      <hr />

      <h2>Overview</h2>
      <p>
        <code>paprika apply</code> is a <code>kubectl apply</code>-like command that submits a local manifest bundle to the Paprika API server. The server creates an <code>Application</code>, a <code>Stage</code>, a versioned <code>Release</code>, and a snapshot <code>ConfigMap</code>. The operator then applies the snapshot to the cluster, evaluates health, and reports progress back to the CLI.
      </p>
      <p>The command works in three phases:</p>
      <ol>
        <li><strong>Render</strong> — Load one or more YAML files or directories and concatenate them into a single manifest bundle.</li>
        <li><strong>Submit</strong> — Send the bundle to the <code>ApplyBundle</code> Connect-RPC method.</li>
        <li><strong>Watch</strong> — Poll <code>GetApplication</code> and render an interactive TUI (or plain output in CI) until the rollout reaches a terminal phase.</li>
      </ol>

      <h2>Flags</h2>
      <table>
        <thead>
          <tr><th>Flag</th><th>Shorthand</th><th>Description</th><th>Default</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--file</code></td><td><code>-f</code></td><td>File or directory to apply. Repeatable.</td><td><em>required</em></td></tr>
          <tr><td><code>--namespace</code></td><td><code>-n</code></td><td>Target namespace for resources.</td><td>Current kubeconfig context namespace, or <code>default</code></td></tr>
          <tr><td><code>--name</code></td><td></td><td>Application name.</td><td>First resource name, or directory/file base name</td></tr>
          <tr><td><code>--project</code></td><td></td><td><code>AppProject</code> that governs the application.</td><td><code>default</code></td></tr>
          <tr><td><code>--skip-policy</code></td><td></td><td>Skip a named <code>Policy</code> for this apply. Repeatable.</td><td></td></tr>
          <tr><td><code>--policy-override</code></td><td></td><td>Override a policy action (<code>name=enforce</code> or <code>name=warn</code>). Repeatable.</td><td></td></tr>
          <tr><td><code>--dry-run</code></td><td></td><td>Render and evaluate policies without creating resources.</td><td><code>false</code></td></tr>
          <tr><td><code>--wait</code></td><td></td><td>Block and watch until the rollout is terminal.</td><td><code>true</code></td></tr>
          <tr><td><code>--timeout</code></td><td></td><td>Watch timeout.</td><td><code>5m</code></td></tr>
          <tr><td><code>--server</code></td><td></td><td>Paprika API server URL.</td><td><code>$PAPRIKA_SERVER</code>, or <code>http://localhost:3000</code></td></tr>
        </tbody>
      </table>

      <h2>Workflow</h2>

      <h3>Namespace and naming</h3>
      <p>
        If a manifest omits <code>metadata.namespace</code>, Paprika defaults it to the value of <code>-n/--namespace</code>. Explicit namespaces are preserved. The application name is derived from the first named resource in the bundle; use <code>--name</code> to pin it.
      </p>

      <h3>Policy evaluation</h3>
      <p>Before any cluster mutation, Paprika evaluates cluster-scoped <code>Policy</code> CRDs against the bundle. Evaluation order:</p>
      <ol>
        <li><code>--skip-policy</code> removes named policies from the run.</li>
        <li><code>--policy-override</code> changes a policy&apos;s action for this apply (<code>enforce</code> or <code>warn</code>).</li>
        <li>Policies with <code>action: enforce</code> that fail block the apply. No resources are created.</li>
        <li>Policies with <code>action: warn</code> that fail emit a warning but do not block.</li>
      </ol>

      <h3>Dry run</h3>
      <p>
        With <code>--dry-run</code>, the server renders and evaluates policies but returns before creating <code>Application</code>, <code>Stage</code>, <code>Release</code>, or <code>ConfigMap</code> resources. Use it to preview policy results in CI or local workflows.
      </p>

      <h3>Watching</h3>
      <p>
        By default the CLI opens a Bubble Tea TUI showing phase, resource health, and policy results. In non-TTY environments it falls back to plain polling output. Set <code>--wait=false</code> to submit and return immediately.
      </p>

      <h2>Exit codes</h2>
      <table>
        <thead>
          <tr><th>Code</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>0</code></td><td>Apply succeeded and reached <code>Healthy</code>.</td></tr>
          <tr><td><code>1</code></td><td>Apply was blocked by policy, failed, degraded, timed out, or the RPC failed.</td></tr>
        </tbody>
      </table>

      <h2>Examples</h2>

      <h3>Basic apply</h3>
      <pre><code>{`paprika apply -f ./manifests \\
  -n production \\
  --name payments-api \\
  --project payments`}</code></pre>
      <p>
        The command loads all <code>.yaml</code> and <code>.yml</code> files in <code>./manifests</code>, creates an Application named <code>payments-api</code> in the <code>production</code> namespace, and watches the rollout.
      </p>

      <h3>Dry-run with policy override</h3>
      <pre><code>{`paprika apply -f deployment.yaml \\
  -n staging \\
  --name checkout \\
  --project payments \\
  --dry-run \\
  --policy-override require-labels=warn \\
  --skip-policy no-latest-tag`}</code></pre>
      <p>
        This renders the bundle, evaluates policies, downgrades <code>require-labels</code> to a warning, skips <code>no-latest-tag</code>, and exits without mutating the cluster.
      </p>

      <h2>Reading policy results</h2>
      <p>Successful applies print a summary table:</p>
      <pre><code>{`Policy results:
  require-labels                 PASS  severity=critical action=enforce
  no-latest-tag                  FAIL  severity=critical action=enforce  (Deployment/nginx uses image 'nginx:latest')`}</code></pre>
      <p>If the apply is blocked, the CLI exits with the blocking reason:</p>
      <pre><code>{`Policy results:
  no-latest-tag                  FAIL  severity=critical action=enforce  (Deployment/nginx uses image 'nginx:latest')

apply blocked: policy no-latest-tag failed`}</code></pre>
      <p>A warning-only result looks like this:</p>
      <pre><code>{`Policy results:
  require-labels                 FAIL  severity=warning action=warn  (missing label 'team')`}</code></pre>
      <p>The apply proceeds and the warning is stored in the <code>Release</code> status.</p>
    </div>
  )
}
