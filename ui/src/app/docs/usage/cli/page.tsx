export default function CLIUsagePage() {
  return (
    <div>
      <h1>CLI Usage</h1>
      <p className="lead">
        The <code>paprika</code> CLI lets you interact with the Paprika API server from a terminal. Build it from source, configure the server endpoint, and start managing applications.
      </p>

      <hr />

      <h2>Installation</h2>
      <p>Build the CLI binary from the project root:</p>
      <pre><code>{`make build-cli
# Binary is written to bin/paprika
./bin/paprika --help`}</code></pre>

      <h2>Configure the server</h2>
      <p>Point the CLI at a Paprika API server. The default example uses <code>http://localhost:3000</code>.</p>
      <pre><code>{`paprika config init --server http://localhost:3000 -n paprika-system`}</code></pre>
      <p>The configuration is stored in <code>~/.paprika/config.yaml</code>. You can override any value with flags such as <code>--server</code>, <code>--namespace</code>, <code>--username</code>, or <code>--token</code>.</p>

      <h2>Authentication</h2>
      <p>The CLI supports basic and bearer token authentication. Credentials are sent on every request.</p>

      <h3>Basic auth</h3>
      <pre><code>{`paprika config init --server http://localhost:3000 --username admin --password`}</code></pre>
      <p>Or pass them as flags for a single command:</p>
      <pre><code>{`paprika apps list --username admin --password`}</code></pre>

      <h3>Token auth</h3>
      <pre><code>{`paprika config init --server http://localhost:3000 --token $PAPRIKA_TOKEN`}</code></pre>
      <p>Or pass it as a flag:</p>
      <pre><code>{`paprika apps list --token $PAPRIKA_TOKEN`}</code></pre>

      <h2>Application commands</h2>
      <p>List all applications:</p>
      <pre><code>{`paprika apps list`}</code></pre>

      <p>Get a single application:</p>
      <pre><code>{`paprika apps get my-app --namespace paprika-system`}</code></pre>

      <p>Trigger a manual sync (re-resolve sources, re-render, and re-apply):</p>
      <pre><code>{`paprika apps sync my-app --namespace paprika-system`}</code></pre>

      <p>Sync and watch until the rollout reaches a terminal phase:</p>
      <pre><code>{`paprika apps sync my-app --namespace paprika-system --watch --timeout 600`}</code></pre>

      <h2>Pipeline, release, and stage commands</h2>
      <pre><code>{`paprika pipelines list
paprika releases list
paprika stages list`}</code></pre>

      <h2>Gate commands</h2>
      <p>Approve a gate for an application:</p>
      <pre><code>{`paprika gates approve my-app qa-approval --namespace paprika-system`}</code></pre>

      <h2>Rendering and resolution</h2>
      <p>Render a template spec locally without applying it:</p>
      <pre><code>{`paprika render --file template.yaml --values values.json`}</code></pre>

      <p>Resolve a template source to its local path and revision:</p>
      <pre><code>{`paprika resolve --file template.yaml`}</code></pre>

      <h2>Output formats</h2>
      <p>Use the <code>--output</code> flag to change the presentation of results.</p>
      <pre><code>{`paprika apps list --output table   # default human-readable table
paprika apps list --output json    # JSON for scripting
paprika apps list --output yaml    # YAML for inspection`}</code></pre>
    </div>
  )
}
