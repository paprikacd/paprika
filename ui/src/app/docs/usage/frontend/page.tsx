export default function FrontendUsagePage() {
  return (
    <div>
      <h1>Dashboard Usage</h1>
      <p className="lead">
        The Paprika dashboard is a Next.js UI served by the API server. Use port-forwarding to access it locally, or expose it through an Ingress in production.
      </p>

      <hr />

      <h2>Access the dashboard</h2>
      <p>The dashboard runs inside the controller-manager deployment on port 3000. Forward it to your workstation:</p>
      <pre><code>{`kubectl port-forward -n paprika-system deployment/paprika-controller-manager 3000:3000`}</code></pre>
      <p>Then open <a href="http://localhost:3000">http://localhost:3000</a>.</p>

      <h2>Dashboard cards</h2>
      <p>The landing page shows cards that summarize the state of the system:</p>
      <ul>
        <li><strong>Stats</strong> — Total applications, healthy count, releases in progress, and active gates</li>
        <li><strong>Applications</strong> — List of applications with phase, source type, and last sync time</li>
        <li><strong>Releases</strong> — Recent releases per application, including promotion stage and result</li>
        <li><strong>Pipelines</strong> — Running and completed pipelines with step-level status</li>
      </ul>

      <h2>Live events</h2>
      <p>
        The dashboard subscribes to server-sent events from the API server to update cards in real time. Each event contains a resource type, name, namespace, and phase change. No refresh is required to see new releases or gate approvals.
      </p>

      <h2>Connection status</h2>
      <p>
        A status indicator in the top bar shows whether the UI is connected to the API. If it turns disconnected, check that the port-forward is active and that the API server pod is ready.
      </p>
    </div>
  )
}
