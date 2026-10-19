package main

import (
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func TestCheckoutResourceTreeDescribesHealthyOwnedReplicaChain(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 5)
	response, err := service.GetResourceTreeDetailed(t.Context(), connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
	}))
	require.NoError(t, err)
	require.Len(t, response.Msg.GetNodes(), 5)

	identities := make(map[string]*paprikav1.ResourceTreeNode)
	for _, node := range response.Msg.GetNodes() {
		key := node.GetKind() + "/" + node.GetName()
		require.NotContains(t, identities, key)
		identities[key] = node
		require.Equal(t, checkoutFixtureNamespace, node.GetNamespace())
		require.Equal(t, "Healthy", node.GetHealth())
		require.Equal(t, "Synced", node.GetSyncStatus())
		require.Equal(t, node.GetTotal(), node.GetReady())
		require.Contains(t, node.GetHealthMessage(), "Synthetic")
		if node.GetParentName() != "" {
			require.Contains(t, identities, node.GetParentKind()+"/"+node.GetParentName(), "parents precede children")
		}
		if node.GetKind() == "Pod" {
			require.Equal(t, "Running", node.GetPhase())
			require.Equal(t, []string{checkoutFixtureContainer}, node.GetContainers())
			require.False(t, node.GetManaged(), "discovered children are not managed roots")
		}
	}
	require.True(t, identities["Deployment/"+checkoutFixtureName].GetManaged())
	require.EqualValues(t, 3, identities["Deployment/"+checkoutFixtureName].GetReady())

	// The existing degraded scenario is not quietly replaced by this richer one.
	other, err := service.GetResourceTreeDetailed(t.Context(), connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: "team-01", ApplicationName: "application-00001",
	}))
	require.NoError(t, err)
	require.Len(t, other.Msg.GetNodes(), 1)
	require.Equal(t, "Missing", other.Msg.GetNodes()[0].GetSyncStatus())
}

func TestCheckoutResourceDetailsMatchTreeAndRecoveredHealthEvidence(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 5)
	application, err := service.GetApplication(t.Context(), connect.NewRequest(&paprikav1.GetApplicationRequest{
		Namespace: checkoutFixtureNamespace, Name: checkoutFixtureName,
	}))
	require.NoError(t, err)
	health := application.Msg.GetApplication().GetHealthChecks()[0]
	require.Equal(t, "Healthy", health.GetStatus())
	require.Len(t, health.GetRecentFailures(), 1)
	recoveryMs := health.GetCheckedAt() * 1000

	for _, node := range checkoutFixtureTree() {
		t.Run(node.GetKind()+"/"+node.GetName(), func(t *testing.T) {
			response, err := service.GetResource(t.Context(), connect.NewRequest(&paprikav1.GetResourceRequest{
				ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
				ResourceKind: node.Kind, ResourceName: node.Name, ResourceNamespace: node.Namespace,
			}))
			require.NoError(t, err)
			detail := response.Msg
			require.Equal(t, node.GetHealth(), detail.GetHealthStatus())
			require.Equal(t, node.GetUid(), detail.GetUid())
			require.Equal(t, "true", detail.GetLabels()[checkoutFixtureMarker])
			require.Empty(t, detail.GetDiff(), "the recovered resource is synced")
			require.Contains(t, detail.GetLiveManifest(), "Synthetic Paprika")

			var manifest map[string]any
			require.NoError(t, yaml.Unmarshal([]byte(detail.GetLiveManifest()), &manifest))
			require.Equal(t, node.GetKind(), manifest["kind"])
			metadata, ok := manifest["metadata"].(map[string]any)
			require.True(t, ok, "manifest metadata must be an object")
			require.Equal(t, node.GetName(), metadata["name"])
			spec, ok := manifest["spec"].(map[string]any)
			require.True(t, ok, "manifest spec must be an object")
			if node.GetKind() == "Pod" {
				containers, ok := spec["containers"].([]any)
				require.True(t, ok, "Pod containers must be a list")
				require.Len(t, containers, 1)
				container, ok := containers[0].(map[string]any)
				require.True(t, ok, "Pod container must be an object")
				require.Equal(t, checkoutFixtureContainer, container["name"])
			} else {
				require.EqualValues(t, 3, spec["replicas"])
			}
			if node.GetManaged() {
				require.Contains(t, detail.GetDesiredManifest(), "replicas: 3")
				require.NotContains(t, detail.GetDesiredManifest(), "\nstatus:")
			} else {
				require.Empty(t, detail.GetDesiredManifest(), "generated children have no independently desired manifest")
			}

			require.Len(t, detail.GetEvents(), 2)
			require.Equal(t, time.Unix(health.GetRecentFailures()[0].GetCheckedAt(), 0).UTC().Format(time.RFC3339), detail.GetEvents()[0].GetLastTimestamp())
			require.Equal(t, time.UnixMilli(recoveryMs).UTC().Format(time.RFC3339), detail.GetEvents()[1].GetLastTimestamp())
			for _, event := range detail.GetEvents() {
				require.Equal(t, node.Kind, event.GetInvolvedObjectKind())
				require.Equal(t, node.Name, event.GetInvolvedObjectName())
				require.Contains(t, event.GetMessage(), "Synthetic")
			}
		})
	}
}

func TestCheckoutResourceReadsRejectUnknownIdentitiesAndPreserveAuthorization(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 5)
	for _, identity := range []struct{ kind, name, namespace string }{
		{"Pod", "not-a-fixture-pod", checkoutFixtureNamespace},
		{"Pod", checkoutFixtureSet + "-b7q2m", "other-namespace"},
		{"Secret", checkoutFixtureName, checkoutFixtureNamespace},
	} {
		_, err := service.GetResource(t.Context(), connect.NewRequest(&paprikav1.GetResourceRequest{
			ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
			ResourceKind: identity.kind, ResourceName: identity.name, ResourceNamespace: identity.namespace,
		}))
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	}
	_, err := service.GetResourceTreeDetailed(t.Context(), connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: "other-namespace", ApplicationName: checkoutFixtureName,
	}))
	require.Error(t, err, "the real handler must still reject an application that does not exist")

	fixture, err := seedFixture(t.Context(), 5)
	require.NoError(t, err)
	denied := &consoleServer{PaprikaServer: apiserver.NewPaprikaServer(fixture.client, nil,
		apiserver.WithAuthorizer(auth.NewRBACAuthorizer([]auth.RBACRule{{
			Subjects: []string{"alice"}, Actions: []string{"read"}, Resources: []string{"applications"},
			Namespaces: []string{"other-namespace"}, Projects: []string{"payments"},
		}})),
	)}
	ctx := auth.WithPrincipal(t.Context(), &auth.Principal{Subject: "alice"})
	_, err = denied.GetResourceTreeDetailed(ctx, connect.NewRequest(&paprikav1.GetResourceTreeDetailedRequest{
		ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
	}))
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	_, err = denied.GetResource(ctx, connect.NewRequest(&paprikav1.GetResourceRequest{
		ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
		ResourceKind: "Deployment", ResourceName: checkoutFixtureName,
	}))
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	err = denied.StreamResourceLogs(ctx, connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
		ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
		ResourceKind: "Deployment", ResourceName: checkoutFixtureName,
	}), nil)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "authorization happens before any stream is used")
}

func TestCheckoutLogStreamIsBoundedRepeatableAndMatchesSelectedPod(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 5)
	_, handler := v1connect.NewPaprikaServiceHandler(service)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := v1connect.NewPaprikaServiceClient(server.Client(), server.URL)
	request := &paprikav1.StreamResourceLogsRequest{
		ApplicationNamespace: checkoutFixtureNamespace, ApplicationName: checkoutFixtureName,
		ResourceKind: "Pod", ResourceName: checkoutFixtureSet + "-b7q2m", ResourceNamespace: checkoutFixtureNamespace,
		ContainerName: checkoutFixtureContainer, Follow: true,
	}
	read := func() []*paprikav1.LogChunk {
		t.Helper()
		stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(request))
		require.NoError(t, err)
		var chunks []*paprikav1.LogChunk
		for stream.Receive() {
			chunks = append(chunks, stream.Msg())
		}
		require.NoError(t, stream.Err())
		require.NoError(t, stream.Close())
		return chunks
	}
	first, second := read(), read()
	require.Equal(t, first, second, "the seeded incident must not change between streams")
	require.Len(t, first, 7, "follow=true still completes the finite replay")
	require.Contains(t, first[0].GetLine(), "SYNTHETIC REPLAY")
	require.Contains(t, first[1].GetLine(), "dependency=database_app state=unavailable")
	require.Contains(t, first[2].GetLine(), "status=503 readiness=false")
	require.Contains(t, first[5].GetLine(), "status=200 readiness=true")
	require.Contains(t, first[6].GetLine(), "health=Healthy synthetic_replay=end")
	for index, chunk := range first {
		require.Equal(t, request.ResourceName, chunk.GetPodName())
		require.Equal(t, checkoutFixtureContainer, chunk.GetContainerName())
		if index > 0 {
			require.Greater(t, chunk.GetTimestampMs(), first[index-1].GetTimestampMs())
		}
	}

	request.ResourceKind, request.ResourceName = "Deployment", checkoutFixtureName
	deployment := read()
	require.Equal(t, first[0].GetPodName(), deployment[0].GetPodName(), "Deployment logs resolve to a child in the same tree")
	request.ContainerName = "not-a-container"
	stream, err := client.StreamResourceLogs(t.Context(), connect.NewRequest(request))
	require.NoError(t, err)
	require.False(t, stream.Receive())
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(stream.Err()))
	require.NoError(t, stream.Close())
}
