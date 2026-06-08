# CI/CD and Deployment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dual-mode operator/api-server binary, Helm chart, GHCR CI pipelines, and Cloud Run + GKE deployment workflows.

**Architecture:** Single binary with `--mode` flag (`operator`=full controller manager, `api`=lightweight connect-go server). CI builds and pushes to GHCR. Deploy workflows use Helm on GKE and `gcloud run deploy` on Cloud Run.

**Tech Stack:** Go 1.25, controller-runtime, connect-go, GitHub Actions, GHCR, Helm, GKE, Cloud Run, Workload Identity Federation

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `cmd/main.go` | Entrypoint: mode dispatch, operator vs api startup | Modify |
| `cmd/main_test.go` | Unit test for api mode startup | Create |
| `internal/api/server.go` | connect-go handler (reads CRDs via client.Reader) | Unchanged |
| `internal/api/uihandler.go` | Embed static UI, serve FileServer | Unchanged |
| `.github/workflows/build-push.yml` | Build + push image to GHCR on main push | Create |
| `.github/workflows/deploy-gke.yml` | Helm deploy full operator to GKE dev | Create |
| `.github/workflows/deploy-cloudrun.yml` | Cloud Run deploy api mode to dev | Create |
| `.github/workflows/release.yml` | Tag-based release to prod | Create |
| `config/cloudrun/service.yaml` | Cloud Run service definition (api mode) | Create |
| `charts/chart/` | Helm chart directory (generated) | Generate |
| `Makefile` | IMG default, helm-generate target | Modify |
| `README.md` | Deployment instructions for CI/CD | Modify |

---

## Chunk 1: Dual-Mode Binary

### Task 1.1: Add `--mode` flag and conditional startup

**Files:**
- Modify: `cmd/main.go`

- [ ] **Add mode, k8s-api-server, k8s-token-file flags**

Add these flag variable declarations alongside the existing ones (around line 66):

```go
var mode string
var k8sAPIServer string
var k8sTokenFile string
```

Add these `flag.StringVar` calls after the existing `flag.StringVar(&uiAddr ...)` line:

```go
flag.StringVar(&mode, "mode", "operator",
    "Running mode: 'operator' (controllers + API) or 'api' (API server only).")
flag.StringVar(&k8sAPIServer, "k8s-api-server", "",
    "Kubernetes API server URL. Only used in 'api' mode.")
flag.StringVar(&k8sTokenFile, "k8s-token-file", "",
    "Path to Kubernetes service account token. Only used in 'api' mode.")
```

- [ ] **Add mode validation after flag.Parse**

```go
if mode != "operator" && mode != "api" {
    setupLog.Error(fmt.Errorf("invalid mode: %s", mode), "Must be 'operator' or 'api'")
    os.Exit(1)
}

if mode == "api" {
    runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr)
    os.Exit(0)
}
```

- [ ] **Extract operator-mode body into a function**

The entire operator startup (mgr creation through mgr.Start) becomes:

```go
func runOperatorMode(uiAddr, metricsAddr, probeAddr, webhookCertPath, webhookCertName, webhookCertKey,
    metricsCertPath, metricsCertName, metricsCertKey, operatorNamespace string,
    enableLeaderElection, secureMetrics, enableHTTP2 bool) {
    // ... existing code from the body of main() after flag.Parse ...
}
```

The `main()` function becomes:

```go
func main() {
    // declare flags (all flags, including mode)
    // flag.Parse()
    // ctrl.SetLogger(...)
    // validate mode
    // switch on mode:
    //   "api"    -> runAPIMode(...); os.Exit(0)
    //   default  -> runOperatorMode(...)
}
```

- [ ] **Implement `runAPIMode` function** (returns `error` for testability)

```go
func runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr string) error {
    var config *rest.Config
    var err error

    if k8sAPIServer != "" {
        token := ""
        if k8sTokenFile != "" {
            data, err := os.ReadFile(k8sTokenFile)
            if err != nil {
                return fmt.Errorf("read token file: %w", err)
            }
            token = string(data)
        } else {
            data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
            if err != nil {
                return fmt.Errorf("no token file or in-cluster token: %w", err)
            }
            token = string(data)
        }
        config = &rest.Config{
            Host:            k8sAPIServer,
            BearerToken:     token,
            TLSClientConfig: rest.TLSClientConfig{Insecure: false},
        }
    } else {
        config, err = rest.InClusterConfig()
        if err != nil {
            return fmt.Errorf("get in-cluster config (use --k8s-api-server): %w", err)
        }
    }

    scheme := runtime.NewScheme()
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))

    client, err := client.New(config, client.Options{Scheme: scheme})
    if err != nil {
        return fmt.Errorf("create k8s client: %w", err)
    }

    paprikaServer := api.NewPaprikaServer(client)
    _, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer)

    mux := http.NewServeMux()
    mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
    mux.Handle("/healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        fmt.Fprintln(w, "ok")
    }))
    mux.Handle("/", api.UIHandler())

    server := &http.Server{Addr: uiAddr, Handler: mux}

    setupLog.Info("Starting API server", "addr", uiAddr)
    if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        return fmt.Errorf("api server error: %w", err)
    }
    return nil
}
```

Update the caller in `main()`:

```go
if mode == "api" {
    if err := runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr); err != nil {
        setupLog.Error(err, "API mode failed")
        os.Exit(1)
    }
    os.Exit(0)
}
```

The `runAPIMode` function requires these imports in `cmd/main.go`:

```go
"context"
"fmt"
"net/http"
"os"

"k8s.io/apimachinery/pkg/runtime"
utilruntime "k8s.io/apimachinery/pkg/util/runtime"
clientgoscheme "k8s.io/client-go/kubernetes/scheme"
"k8s.io/client-go/rest"
"sigs.k8s.io/controller-runtime/pkg/client"

pipelinesv1alpha1 "github.com/benebsworth/paprika/api/v1alpha1"
"github.com/benebsworth/paprika/internal/api"
"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
```

Most of these are already imported by the existing `main()`. Some may become
unused after extracting `runOperatorMode` — `go build` will catch them.
Add `_` prefixes or remove as needed.

- [ ] **Verify the code compiles**

Run: `go build ./cmd/...`
Expected: clean compile, no errors

- [ ] **Vet the code**

Run: `go vet ./cmd/...`
Expected: no vet issues

### Task 1.2: Write unit test for api mode

**Files:**
- Create: `cmd/main_test.go`

- [ ] **Write the test**

```go
package main

import (
    "net/http"
    "net/http/httptest"
    "os"
    "testing"
    "time"
)

func TestAPIModeStartsWithoutError(t *testing.T) {
    fakeK8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{}`))
    }))
    defer fakeK8s.Close()

    tokenFile, err := os.CreateTemp(t.TempDir(), "token")
    if err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(tokenFile.Name(), []byte("fake-token"), 0644); err != nil {
        t.Fatal(err)
    }
    tokenFile.Close()

    errCh := make(chan error, 1)
    go func() {
        errCh <- runAPIMode(fakeK8s.URL, tokenFile.Name(), "localhost:0")
    }()

    select {
    case err := <-errCh:
        if err != nil {
            t.Fatalf("runAPIMode returned error: %v", err)
        }
    case <-time.After(500 * time.Millisecond):
        // Still running — server started successfully
    }
}
```

- [ ] **Run the test**

Run: `go test ./cmd/ -run TestAPIMode -v -count=1`
Expected: PASS

- [ ] **Verify existing tests still pass**

Run: `go test ./... -count=1 -short 2>&1 | tail -10`
Expected: `ok` or no failures

### Task 1.3: Commit

```bash
git add cmd/main.go cmd/main_test.go
git commit -m "feat: add --mode flag with operator/api dual-mode binary"
```

---

## Chunk 2: Helm Chart

### Task 2.1: Generate Helm chart via kubebuilder plugin

- [ ] **Check kubebuilder is installed**

Run: `which kubebuilder`
Expected: path to kubebuilder binary

- [ ] **Generate chart**

Run: `kubebuilder edit --plugins=helm/v2-alpha --output-dir=charts`
Expected: `charts/chart/` directory created with Chart.yaml, values.yaml, templates/

- [ ] **Verify chart structure**

Run: `ls -la charts/chart/`
Expected: Chart.yaml, values.yaml, templates/, manager/

### Task 2.2: Customize Helm chart for dual-mode support

**Files:**
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/manager/manager.yaml` (if needed for mode arg)

- [ ] **Read generated values.yaml to understand defaults**

Run: `cat charts/chart/values.yaml`
Expected: Print current content

- [ ] **Add mode + remoteCluster to values.yaml**

Add after the image section:

```yaml
# -- Deployment mode: "operator" (full controller manager) or "api" (API server only)
mode: operator

# Remote cluster connection (api mode only)
remoteCluster:
  # -- Kubernetes API server URL (e.g., https://1.2.3.4:443)
  apiServer: ""
  # -- Path to mounted service account token file
  tokenFile: ""
```

- [ ] **Add mode argument to manager args**

The kubebuilder helm plugin uses `charts/chart/manager/manager.yaml` as a
values-driven template embedded in the Deployment. Edit this file to add:

```yaml
args:
  - --leader-elect
  - --health-probe-bind-address=:8081
  - --ui-bind-address=:3000
  - --mode={{ .Values.mode }}
```

- [ ] **Add conditional template guards for api mode**

The Helm chart's Deployment template (at `charts/chart/templates/deployment.yaml`)
should only include RBAC, ServiceAccount, ClusterRole/Binding, and Namespace
resources when `mode == "operator"`. In api mode, only a minimal Deployment +
Service should be rendered.

The actual template files depend on what kubebuilder generates. After generating,
inspect the templates and wrap RBAC-heavy resources in:

```yaml
{{- if eq .Values.mode "operator" }}
# ... RBAC, ServiceAccount, ClusterRole resources ...
{{- end }}
```

For the api mode Service, add a minimal Service template:

```yaml
{{- if eq .Values.mode "api" }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "paprika.fullname" . }}-api
  labels:
    {{- include "paprika.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
      name: http
  selector:
    {{- include "paprika.selectorLabels" . | nindent 4 }}
{{- end }}
```

And the api mode Deployment reuses the main deployment template but with
different args (no leader-elect, no health-probe). In practice, the simplest
approach is: always deploy the full Deployment, but the `--mode=api` flag makes
the binary ignore unnecessary components. This avoids template complexity and
is the pragmatic approach recommended here.

### Task 2.3: Commit

```bash
git add charts/
git commit -m "feat: generate Helm chart with dual-mode support"
```

---

## Chunk 3: CI Workflows + Cloud Run Config

### Task 3.1: Create build-push.yml

**Files:**
- Create: `.github/workflows/build-push.yml`

- [ ] **Write build-push.yml**

```yaml
name: Build & Push

on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    name: Build and push to GHCR
    runs-on: ubuntu-latest
    steps:
      - name: Clone the code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - name: Setup Go
        uses: actions/setup-go@4b73464bb391d4059bd26b0524d20df3927bd417 # v6.3.0
        with:
          go-version-file: go.mod

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ghcr.io/benebsworth/paprika:latest
            ghcr.io/benebsworth/paprika:sha-${{ github.sha }}
```

### Task 3.2: Create deploy-gke.yml

**Files:**
- Create: `.github/workflows/deploy-gke.yml`

- [ ] **Write deploy-gke.yml**

```yaml
name: Deploy GKE Dev

on:
  workflow_run:
    workflows: [Build & Push]
    types: [completed]
    branches: [main]
  workflow_dispatch: {}

concurrency: deploy-gke-dev

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    name: Deploy operator to GKE dev
    runs-on: ubuntu-latest
    steps:
      - name: Clone the code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

      - name: Setup gcloud
        uses: google-github-actions/setup-gcloud@v2

      - name: Get GKE credentials
        run: |
          gcloud container clusters get-credentials ${{ vars.GKE_CLUSTER_NAME }} \
            --zone ${{ vars.GKE_CLUSTER_ZONE }} \
            --project ${{ vars.GKE_CLUSTER_PROJECT }}

      - name: Install CRDs
        run: make install

      - name: Deploy via Helm
        run: |
          helm upgrade --install paprika-dev ./charts/chart \
            --set image.repository=ghcr.io/benebsworth/paprika \
            --set image.tag=sha-${{ github.sha }} \
            --set mode=operator \
            --wait \
            --timeout 5m
```

### Task 3.3: Create deploy-cloudrun.yml

**Files:**
- Create: `.github/workflows/deploy-cloudrun.yml`

- [ ] **Write deploy-cloudrun.yml**

```yaml
name: Deploy Cloud Run Dev

on:
  workflow_run:
    workflows: [Build & Push]
    types: [completed]
    branches: [main]
  workflow_dispatch: {}

concurrency: deploy-cloudrun-dev

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    name: Deploy API server to Cloud Run
    runs-on: ubuntu-latest
    steps:
      - name: Clone the code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

      - name: Setup gcloud
        uses: google-github-actions/setup-gcloud@v2

      - id: gke-info
        name: Discover GKE API endpoint
        run: |
          ENDPOINT=$(gcloud container clusters describe ${{ vars.GKE_CLUSTER_NAME }} \
            --zone ${{ vars.GKE_CLUSTER_ZONE }} \
            --project ${{ vars.GKE_CLUSTER_PROJECT }} \
            --format 'value(endpoint)')
          echo "endpoint=https://${ENDPOINT}:443"
          echo "endpoint=https://${ENDPOINT}:443" >> $GITHUB_OUTPUT

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy paprika-api-dev \
            --image=ghcr.io/benebsworth/paprika:sha-${{ github.sha }} \
            --args="--mode=api,--k8s-api-server=${{ steps.gke-info.outputs.endpoint }}" \
            --region=${{ vars.CLOUDRUN_REGION }} \
            --service-account=${{ vars.CLOUDRUN_SA }} \
            --allow-unauthenticated \
            --cpu=1 \
            --memory=256Mi \
            --min-instances=0 \
            --max-instances=5
```

### Task 3.4: Create release.yml

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Write release.yml**

```yaml
name: Release

on:
  push:
    tags: [v*]

concurrency: release

permissions:
  contents: write
  packages: write
  id-token: write

jobs:
  release:
    name: Build, release, and deploy
    runs-on: ubuntu-latest
    steps:
      - name: Clone the code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - name: Setup Go
        uses: actions/setup-go@4b73464bb391d4059bd26b0524d20df3927bd417 # v6.3.0
        with:
          go-version-file: go.mod

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract semver tag
        id: tag
        run: echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Build and push image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ghcr.io/benebsworth/paprika:${{ github.ref_name }}
            ghcr.io/benebsworth/paprika:latest

      - name: Generate install.yaml
        run: make build-installer IMG=ghcr.io/benebsworth/paprika:${{ github.ref_name }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          name: Release ${{ github.ref_name }}
          generate_release_notes: true
          files: dist/install.yaml

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

      - name: Setup gcloud
        uses: google-github-actions/setup-gcloud@v2

      - name: Get GKE prod credentials
        run: |
          gcloud container clusters get-credentials ${{ vars.GKE_CLUSTER_NAME }} \
            --zone ${{ vars.GKE_CLUSTER_ZONE }} \
            --project ${{ vars.GKE_CLUSTER_PROJECT }}

      - name: Install CRDs on GKE prod
        run: make install

      - name: Deploy operator to GKE prod
        run: |
          helm upgrade --install paprika-prod ./charts/chart \
            --set image.repository=ghcr.io/benebsworth/paprika \
            --set image.tag=${{ github.ref_name }} \
            --set mode=operator \
            --wait \
            --timeout 5m

      - id: gke-prod-info
        name: Discover GKE prod API endpoint
        run: |
          ENDPOINT=$(gcloud container clusters describe ${{ vars.GKE_CLUSTER_NAME }} \
            --zone ${{ vars.GKE_CLUSTER_ZONE }} \
            --project ${{ vars.GKE_CLUSTER_PROJECT }} \
            --format 'value(endpoint)')
          echo "endpoint=https://${ENDPOINT}:443"
          echo "endpoint=https://${ENDPOINT}:443" >> $GITHUB_OUTPUT

      - name: Deploy API server to Cloud Run prod
        run: |
          gcloud run deploy paprika-api-prod \
            --image=ghcr.io/benebsworth/paprika:${{ github.ref_name }} \
            --args="--mode=api,--k8s-api-server=${{ steps.gke-prod-info.outputs.endpoint }}" \
            --region=${{ vars.CLOUDRUN_REGION }} \
            --service-account=${{ vars.CLOUDRUN_SA }} \
            --allow-unauthenticated \
            --cpu=1 \
            --memory=256Mi \
            --min-instances=1 \
            --max-instances=10
```

### Task 3.5: Create Cloud Run service YAML

**Files:**
- Create: `config/cloudrun/service.yaml`

- [ ] **Write config/cloudrun/service.yaml**

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: paprika-api
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: "5"
        autoscaling.knative.dev/minScale: "0"
    spec:
      containers:
        - image: ghcr.io/benebsworth/paprika:latest
          args:
            - --mode=api
          ports:
            - containerPort: 3000
              name: http
          resources:
            limits:
              cpu: "1"
              memory: 256Mi
          startupProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            periodSeconds: 30
      serviceAccountName: paprika-cloudrun
```

### Task 3.6: Commit

```bash
git add .github/workflows/ config/cloudrun/
git commit -m "feat: add CI/CD workflows and Cloud Run service config"
```

---

## Chunk 4: Makefile + README

### Task 4.1: Update Makefile

**Files:**
- Modify: `Makefile`

- [ ] **Update IMG default**

Change line 2 from:
```makefile
IMG ?= controller:latest
```
to:
```makefile
IMG ?= ghcr.io/benebsworth/paprika:latest
```

- [ ] **Add HELM_OUTPUT_DIR variable**

After `CONTAINER_TOOL` block (around line 17):
```makefile
HELM_OUTPUT_DIR ?= charts
```

- [ ] **Add helm-generate target**

Add after the `build-installer` target (around line 151):
```makefile
.PHONY: helm-generate
helm-generate: kustomize ## Generate Helm chart from Kustomize manifests.
	@echo "Backing up custom Helm values..."
	@if [ -f $(HELM_OUTPUT_DIR)/chart/values.yaml ]; then \
	  cp $(HELM_OUTPUT_DIR)/chart/values.yaml /tmp/helm-values-backup.yaml; \
	fi
	kubebuilder edit --plugins=helm/v2-alpha --output-dir=$(HELM_OUTPUT_DIR) --force
	@echo "Restoring custom Helm values..."
	@if [ -f /tmp/helm-values-backup.yaml ]; then \
	  cp /tmp/helm-values-backup.yaml $(HELM_OUTPUT_DIR)/chart/values.yaml; \
	fi
```

- [ ] **Verify Makefile syntax**

Run: `make -n help`
Expected: prints help with new targets visible

### Task 4.2: Update README

**Files:**
- Modify: `README.md`

- [ ] **Replace placeholder image registry references**

The README has two sections referencing `<some-registry>/paprika:tag`:
1. At line 19 (`To Deploy on the cluster`): change `make docker-build docker-push IMG=<some-registry>/paprika:tag` to `make docker-build docker-push IMG=ghcr.io/benebsworth/paprika:sha-<commit>`
2. At line 35: change `make deploy IMG=<some-registry>/paprika:tag` to `make deploy IMG=ghcr.io/benebsworth/paprika:sha-<commit>`
3. At line 78 (`build-installer` example): change `make build-installer IMG=...` to `make build-installer IMG=ghcr.io/benebsworth/paprika:<tag>`

- [ ] **Add CI/CD section to README**

Add a section before "Contributing":

```markdown
## CI/CD

This project uses GitHub Actions for CI/CD and GHCR for container registry.

### Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| Lint | push, PR | golangci-lint |
| Tests | push, PR | Unit tests with coverage |
| E2E Tests | push, PR | End-to-end tests on Kind |
| Build & Push | push to main | Build and push image to GHCR |
| Deploy GKE Dev | after Build & Push | Deploy full operator to GKE dev cluster |
| Deploy Cloud Run Dev | after Build & Push | Deploy API server to Cloud Run dev |
| Release | tag push (v*) | Build, release, deploy to production |

### Manual Deployment

```sh
# Build and push
make docker-build docker-push IMG=ghcr.io/benebsworth/paprika:sha-<commit>

# Deploy full operator to any cluster
make deploy IMG=ghcr.io/benebsworth/paprika:sha-<commit>

# Deploy API server mode
docker run --rm -p 3000:3000 ghcr.io/benebsworth/paprika:sha-<commit> --mode=api
```
```

- [ ] **Verify README renders cleanly**

Read the file and check for markdown issues.

### Task 4.3: Commit

```bash
git add Makefile README.md
git commit -m "docs: update Makefile and README for GHCR and CI/CD"
```

---

## Verification

After all chunks are implemented, run the full verification:

- [ ] `go build ./cmd/...` — compiles cleanly
- [ ] `go vet ./cmd/...` — no vet issues
- [ ] `go test ./... -count=1 -short 2>&1 | tail -10` — unit tests pass
- [ ] `make manifests generate` — regenerates without errors
- [ ] Review all created files: workflows, cloudrun yaml, helm chart
