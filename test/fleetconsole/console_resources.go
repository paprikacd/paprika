package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

const (
	checkoutFixtureNamespace = "team-00"
	checkoutFixtureName      = "checkout-service"
	checkoutFixtureSet       = "checkout-service-6d8b9f7c4"
	checkoutFixtureContainer = "checkout"
	checkoutFixtureMarker    = "paprika.io/synthetic-demo"
)

var errFixtureResourceNotFound = errors.New("synthetic resource not found")

func isCheckoutFixture(namespace, name string) bool {
	return namespace == checkoutFixtureNamespace && name == checkoutFixtureName
}

// GetResourceTreeDetailed enriches only the first application's existing
// healthy Deployment. The other applications keep their real status-derived
// tree, including genuinely missing resources. Delegating first preserves the
// real application's existence and authorization checks before adding any data.
func (c *consoleServer) GetResourceTreeDetailed(
	ctx context.Context,
	req *connect.Request[paprikav1.GetResourceTreeDetailedRequest],
) (*connect.Response[paprikav1.GetResourceTreeDetailedResponse], error) {
	response, err := c.PaprikaServer.GetResourceTreeDetailed(ctx, req)
	if err != nil || !isCheckoutFixture(req.Msg.GetApplicationNamespace(), req.Msg.GetApplicationName()) {
		return response, err
	}
	response.Msg.Nodes = checkoutFixtureTree()
	return response, nil
}

func checkoutFixtureTree() []*paprikav1.ResourceTreeNode {
	nodes := make([]*paprikav1.ResourceTreeNode, 0, 5)
	nodes = append(nodes,
		&paprikav1.ResourceTreeNode{
			Kind: "Deployment", Name: checkoutFixtureName, Namespace: checkoutFixtureNamespace,
			SyncStatus: "Synced", Health: "Healthy", HealthMessage: "Synthetic fixture: all 3 replicas are available; prior dependency failure recovered.",
			Uid: "synthetic-checkout-deployment", Managed: true, Phase: "Available", Ready: 3, Total: 3,
		},
		&paprikav1.ResourceTreeNode{
			Kind: "ReplicaSet", Name: checkoutFixtureSet, Namespace: checkoutFixtureNamespace,
			SyncStatus: "Synced", Health: "Healthy", HealthMessage: "Synthetic fixture: 3 ready replicas.",
			ParentKind: "Deployment", ParentName: checkoutFixtureName, Uid: "synthetic-checkout-replicaset",
			Phase: "Available", Ready: 3, Total: 3,
		},
	)
	for _, suffix := range []string{"b7q2m", "k4n8r", "v9x3p"} {
		name := checkoutFixtureSet + "-" + suffix
		nodes = append(nodes, &paprikav1.ResourceTreeNode{
			Kind: "Pod", Name: name, Namespace: checkoutFixtureNamespace,
			SyncStatus: "Synced", Health: "Healthy", HealthMessage: "Synthetic fixture: readiness recovered; database_app is responding.",
			ParentKind: "ReplicaSet", ParentName: checkoutFixtureSet, Uid: "synthetic-" + name,
			Phase: "Running", Ready: 1, Total: 1, Containers: []string{checkoutFixtureContainer},
		})
	}
	return nodes
}

func checkoutFixtureResource(kind, name, namespace string) (*paprikav1.ResourceTreeNode, error) {
	if namespace == "" {
		namespace = checkoutFixtureNamespace
	}
	for _, node := range checkoutFixtureTree() {
		if node.Kind == kind && node.Name == name && node.Namespace == namespace {
			return node, nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, errFixtureResourceNotFound)
}

// GetResource serves explicitly marked synthetic manifests and Kubernetes
// events for the same nodes returned by the tree. Healthy/synced resources have
// no invented diff; discovered children have no desired manifest of their own.
func (c *consoleServer) GetResource(
	ctx context.Context,
	req *connect.Request[paprikav1.GetResourceRequest],
) (*connect.Response[paprikav1.GetResourceResponse], error) {
	response, err := c.PaprikaServer.GetResource(ctx, req)
	if err != nil || !isCheckoutFixture(req.Msg.GetApplicationNamespace(), req.Msg.GetApplicationName()) {
		return response, err
	}
	node, err := checkoutFixtureResource(req.Msg.GetResourceKind(), req.Msg.GetResourceName(), req.Msg.GetResourceNamespace())
	if err != nil {
		return nil, err
	}
	application, err := c.checkoutFixtureApplication(ctx, req.Msg.GetApplicationNamespace(), req.Msg.GetApplicationName())
	if err != nil {
		return nil, err
	}
	apiVersion, resource := "apps/v1", "deployments"
	switch node.Kind {
	case "Pod":
		apiVersion, resource = "v1", "pods"
	case "ReplicaSet":
		resource = "replicasets"
	}
	manifest := checkoutFixtureManifest(node, apiVersion)
	response.Msg = &paprikav1.GetResourceResponse{
		Kind: node.Kind, Name: node.Name, Namespace: node.Namespace,
		SyncStatus: node.SyncStatus, HealthStatus: node.Health, HealthMessage: node.HealthMessage,
		LiveManifest: manifest, ApiVersion: apiVersion, Version: "v1", Resource: resource, Uid: node.Uid,
		Labels:      map[string]string{"app.kubernetes.io/name": checkoutFixtureName, checkoutFixtureMarker: "true"},
		Annotations: map[string]string{checkoutFixtureMarker: "Recovered dependency incident replay. No live cluster."},
		Events:      checkoutFixtureEvents(node, checkoutFixtureRecoveryMs(application)),
	}
	if node.Managed {
		response.Msg.Group = "apps"
		response.Msg.DesiredManifest = strings.Split(manifest, "\nstatus:")[0] + "\n"
	} else if node.Kind == "ReplicaSet" {
		response.Msg.Group = "apps"
	}
	return response, nil
}

// checkoutFixtureApplication deliberately calls the real handler. In
// particular, the log stream must not skip read authorization just because its
// backing data is synthetic. The seeded health check is the replay's clock:
// repeat reads agree, and logs and events describe the failure the Health tab
// already recorded rather than a second, contradictory incident.
func (c *consoleServer) checkoutFixtureApplication(ctx context.Context, namespace, name string) (*paprikav1.Application, error) {
	response, err := c.PaprikaServer.GetApplication(ctx, connect.NewRequest(&paprikav1.GetApplicationRequest{
		Namespace: namespace, Name: name,
	}))
	if err != nil {
		return nil, err
	}
	return response.Msg.GetApplication(), nil
}

func checkoutFixtureRecoveryMs(application *paprikav1.Application) int64 {
	for _, check := range application.GetHealthChecks() {
		if check.GetName() == "internal-deepcheck" && check.GetCheckedAt() > 0 {
			// HealthCheckResult.checked_at is Unix seconds, LogChunk is ms.
			return check.GetCheckedAt() * 1000
		}
	}
	return consoleNowUnixMs()
}

func checkoutFixtureManifest(node *paprikav1.ResourceTreeNode, apiVersion string) string {
	metadata := fmt.Sprintf(`# Synthetic Paprika console fixture. No live cluster.
apiVersion: %s
kind: %s
metadata:
  name: %s
  namespace: %s
  labels:
    app.kubernetes.io/name: checkout-service
    paprika.io/synthetic-demo: "true"
`, apiVersion, node.Kind, node.Name, node.Namespace)
	container := `      containers:
        - name: checkout
          image: example.invalid/fixture/checkout-service:v1.8.3
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /deepcheck
              port: 8080
            periodSeconds: 10
`
	if node.Kind == "Pod" {
		return metadata + `  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: checkout-service-6d8b9f7c4
      uid: synthetic-checkout-replicaset
      controller: true
spec:
` + strings.TrimPrefix(strings.ReplaceAll("\n"+container, "\n    ", "\n"), "\n") + `status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
      reason: SyntheticDependencyRecovered
  containerStatuses:
    - name: checkout
      ready: true
      restartCount: 0
`
	}
	if node.Kind == "ReplicaSet" {
		metadata += `  ownerReferences:
    - apiVersion: apps/v1
      kind: Deployment
      name: checkout-service
      uid: synthetic-checkout-deployment
      controller: true
`
	}
	return metadata + `spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: checkout-service
  template:
    metadata:
      labels:
        app.kubernetes.io/name: checkout-service
    spec:
` + container + `status:
  replicas: 3
  readyReplicas: 3
  availableReplicas: 3
`
}

func checkoutFixtureEvents(node *paprikav1.ResourceTreeNode, recoveryMs int64) []*paprikav1.KubernetesEvent {
	return []*paprikav1.KubernetesEvent{
		{
			Type: "Warning", Reason: "Unhealthy", Count: 3,
			Message:            "[Synthetic, recovered] Readiness probe returned HTTP 503: database_app dependency unavailable.",
			LastTimestamp:      time.UnixMilli(recoveryMs - 5*60*1000).UTC().Format(time.RFC3339),
			InvolvedObjectKind: node.Kind, InvolvedObjectName: node.Name,
		},
		{
			Type: "Normal", Reason: "ReadinessRecovered", Count: 1,
			Message:            "[Synthetic] database_app responded in 3 ms; readiness returned HTTP 200. All replicas are ready now.",
			LastTimestamp:      time.UnixMilli(recoveryMs).UTC().Format(time.RFC3339),
			InvolvedObjectKind: node.Kind, InvolvedObjectName: node.Name,
		},
	}
}

// StreamResourceLogs emits a bounded replay and completes even for follow=true.
// A finite synthetic recording should not pretend to be a live kubelet stream.
// No Kubernetes client or external endpoint is consulted.
func (c *consoleServer) StreamResourceLogs(
	ctx context.Context,
	req *connect.Request[paprikav1.StreamResourceLogsRequest],
	stream *connect.ServerStream[paprikav1.LogChunk],
) error {
	if !isCheckoutFixture(req.Msg.GetApplicationNamespace(), req.Msg.GetApplicationName()) {
		return c.PaprikaServer.StreamResourceLogs(ctx, req, stream)
	}
	application, err := c.checkoutFixtureApplication(ctx, req.Msg.GetApplicationNamespace(), req.Msg.GetApplicationName())
	if err != nil {
		return err
	}
	node, err := checkoutFixtureResource(req.Msg.GetResourceKind(), req.Msg.GetResourceName(), req.Msg.GetResourceNamespace())
	if err != nil {
		return err
	}
	if req.Msg.GetContainerName() != "" && req.Msg.GetContainerName() != checkoutFixtureContainer {
		return connect.NewError(connect.CodeNotFound, errors.New("synthetic container not found"))
	}
	podName := node.Name
	if node.Kind != "Pod" {
		podName = checkoutFixtureSet + "-b7q2m"
	}
	for _, chunk := range checkoutFixtureLogChunks(podName, checkoutFixtureRecoveryMs(application)) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := stream.Send(chunk); err != nil {
			return fmt.Errorf("send synthetic log replay: %w", err)
		}
	}
	return nil
}

func checkoutFixtureLogChunks(podName string, recoveryMs int64) []*paprikav1.LogChunk {
	entries := []struct {
		offset int64
		line   string
	}{
		{-301000, "SYNTHETIC REPLAY | checkout-service | prior dependency incident | no live cluster"},
		{-300000, "WARN dependency=database_app state=unavailable latency_ms=5000 error=dependency_unavailable"},
		{-299000, "WARN GET /deepcheck status=503 readiness=false reason=database_app_unavailable"},
		{-298000, "INFO retry dependency=database_app attempt=1 backoff_ms=1000"},
		{-1000, "INFO dependency=database_app state=ok latency_ms=3 connection_pool=ready"},
		{0, "INFO GET /deepcheck status=200 readiness=true frontend_backend=ok database_app=ok"},
		{1000, "INFO recovery=complete ready_replicas=3/3 health=Healthy synthetic_replay=end"},
	}
	chunks := make([]*paprikav1.LogChunk, 0, len(entries))
	for _, entry := range entries {
		at := recoveryMs + entry.offset
		chunks = append(chunks, &paprikav1.LogChunk{
			PodName: podName, ContainerName: checkoutFixtureContainer, TimestampMs: at,
			Line: time.UnixMilli(at).UTC().Format("15:04:05.000") + " " + entry.line,
		})
	}
	return chunks
}
