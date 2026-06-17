export default function APIUsagePage() {
  return (
    <div>
      <h1>API Usage</h1>
      <p className="lead">
        Paprika exposes a Connect-RPC API. You can call it with any Connect, gRPC, or plain HTTP client.
      </p>

      <hr />

      <h2>Connect-RPC endpoints</h2>
      <p>The API server serves the PaprikaService under the standard Connect path. Endpoints accept unary JSON POST requests and return JSON by default.</p>
      <pre><code>{`POST /api.v1.PaprikaService/ListApplications
POST /api.v1.PaprikaService/GetApplication
POST /api.v1.PaprikaService/SyncApplication
POST /api.v1.PaprikaService/ApproveGate
POST /api.v1.PaprikaService/ListPipelines
POST /api.v1.PaprikaService/ListReleases
POST /api.v1.PaprikaService/ListStages`}</code></pre>

      <h2>cURL example</h2>
      <p>List applications with basic authentication:</p>
      <pre><code>{`curl -X POST http://localhost:3000/api.v1.PaprikaService/ListApplications \\
  -H "Content-Type: application/json" \\
  -u admin:password \\
  -d '{"namespace": "paprika-system"}'`}</code></pre>

      <p>Get a single application:</p>
      <pre><code>{`curl -X POST http://localhost:3000/api.v1.PaprikaService/GetApplication \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $PAPRIKA_TOKEN" \\
  -d '{"name": "my-app", "namespace": "paprika-system"}'`}</code></pre>

      <h2>Auth headers</h2>
      <p>The API server accepts either of the following headers:</p>
      <ul>
        <li><code>Authorization: Basic base64(username:password)</code></li>
        <li><code>Authorization: Bearer &lt;token&gt;</code></li>
      </ul>

      <h2>Go client example</h2>
      <pre><code>{`package main

import (
    "context"
    "fmt"
    "log"
    "net/http"

    apiv1 "github.com/benebsworth/paprika/proto/paprika/v1"
    "connectrpc.com/connect"
)

func main() {
    client := apiv1.NewPaprikaServiceClient(
        http.DefaultClient,
        "http://localhost:3000",
    )

    resp, err := client.ListApplications(context.Background(),
        connect.NewRequest(&apiv1.ListApplicationsRequest{}))
    if err != nil {
        log.Fatal(err)
    }

    for _, app := range resp.Msg.Applications {
        fmt.Println(app.Name, app.Phase)
    }
}`}</code></pre>
    </div>
  )
}
