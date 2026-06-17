export default function AuthGuidePage() {
  return (
    <div>
      <h1>Authentication Setup</h1>
      <p className="lead">
        Paprika supports basic and bearer token authentication for the API server and dashboard. Configure credentials before exposing the API externally.
      </p>

      <hr />

      <h2>Basic authentication</h2>
      <p>
        Create a secret with a username and password pair. Reference it when deploying the API server.
      </p>
      <pre><code>{`kubectl create secret generic paprika-basic-auth \\
  --from-literal=username=admin \\
  --from-literal=password='change-me-please' \\
  -n paprika-system`}</code></pre>
      <p>Enable basic auth by setting the environment variable on the deployment:</p>
      <pre><code>{`env:
  - name: PAPRIKA_AUTH_BASIC_SECRET
    value: paprika-basic-auth`}</code></pre>

      <h2>Token authentication</h2>
      <p>Create a secret containing one or more valid bearer tokens:</p>
      <pre><code>{`kubectl create secret generic paprika-tokens \\
  --from-literal=token-1='super-secret-token' \\
  -n paprika-system`}</code></pre>
      <p>Enable token auth by referencing the secret:</p>
      <pre><code>{`env:
  - name: PAPRIKA_AUTH_TOKEN_SECRET
    value: paprika-tokens`}</code></pre>

      <h2>CLI configuration</h2>
      <p>Once auth is enabled, configure the CLI to send credentials on every request.</p>
      <pre><code>{`paprika config set-auth basic --username admin --password
paprika config set-auth token --token super-secret-token`}</code></pre>

      <h2>Disabling authentication</h2>
      <p>
        For local development only, you can leave both secrets unset. Do not disable authentication when exposing the dashboard or API to a network.
      </p>
    </div>
  )
}
