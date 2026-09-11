package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func TestRegisterReadToolsRegistersAllFourteen(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))

	want := []string{
		"fleet_status", "list_clusters", "fleet_map", "list_applications",
		"get_application", "investigate", "get_resource_tree", "get_logs",
		"list_pipelines", "get_pipeline_run", "list_releases", "list_rollouts",
		"get_rollout", "query_cost",
	}
	assert.Len(t, r.All(), len(want))
	for _, name := range want {
		tool, ok := r.Lookup(name)
		require.True(t, ok, "missing tool %q", name)
		assert.Equal(t, ScopeRead, tool.Scope, "%q must be read-scoped", name)
		assert.False(t, tool.Destructive)
	}
}

func TestReadToolSchemasAreValidJSON(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	for _, tool := range r.All() {
		var schema map[string]any
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema), tool.Name)
		assert.Equal(t, "object", schema["type"], tool.Name)
		assert.NotEmpty(t, tool.Description, "%q needs a description", tool.Name)
	}
}

func TestListToolsDefaultPageSizeIsCapped(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	for _, name := range []string{"list_applications", "list_clusters", "list_releases"} {
		tool, ok := r.Lookup(name)
		require.True(t, ok)
		var schema struct {
			Properties struct {
				PageSize struct {
					Default int `json:"default"`
					Maximum int `json:"maximum"`
				} `json:"page_size"` //nolint:tagliatelle // matches the tool's wire schema, which is snake_case
			} `json:"properties"`
		}
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema))
		assert.Equal(t, 50, schema.Properties.PageSize.Default, name)
		assert.LessOrEqual(t, schema.Properties.PageSize.Maximum, 200, name)
	}
}

// recordingListService implements ListClusters, ListPipelines, ListRollouts,
// and ListReleases, recording the exact request each received so tests can
// assert on what a tool sent downstream — in particular, that omitting the
// namespace argument leaves the optional namespace field nil rather than a
// non-nil pointer to "". A non-nil &"" is rejected by optionalNamespaceScope
// (internal/api/console_stub.go), which treats nil as "no filter" and &""
// as an explicit, invalid namespace.
type recordingListService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	clustersReq  *v1.ListClustersRequest
	pipelinesReq *v1.ListPipelinesRequest
	rolloutsReq  *v1.ListRolloutsRequest
	releasesReq  *v1.ListReleasesRequest
}

func (s *recordingListService) ListClusters(
	_ context.Context, req *connect.Request[v1.ListClustersRequest],
) (*connect.Response[v1.ListClustersResponse], error) {
	s.clustersReq = req.Msg
	return connect.NewResponse(&v1.ListClustersResponse{}), nil
}

func (s *recordingListService) ListPipelines(
	_ context.Context, req *connect.Request[v1.ListPipelinesRequest],
) (*connect.Response[v1.ListPipelinesResponse], error) {
	s.pipelinesReq = req.Msg
	return connect.NewResponse(&v1.ListPipelinesResponse{}), nil
}

func (s *recordingListService) ListRollouts(
	_ context.Context, req *connect.Request[v1.ListRolloutsRequest],
) (*connect.Response[v1.ListRolloutsResponse], error) {
	s.rolloutsReq = req.Msg
	return connect.NewResponse(&v1.ListRolloutsResponse{}), nil
}

func (s *recordingListService) ListReleases(
	_ context.Context, req *connect.Request[v1.ListReleasesRequest],
) (*connect.Response[v1.ListReleasesResponse], error) {
	s.releasesReq = req.Msg
	return connect.NewResponse(&v1.ListReleasesResponse{}), nil
}

// TestListToolsOmittedNamespaceLeavesRequestNamespaceNil is a regression test
// for the bug where list_clusters (and, identically, list_pipelines,
// list_rollouts, and list_releases) sent a non-nil pointer to "" for an
// omitted namespace argument. That made list_clusters{} — the single most
// obvious invocation — fail with "namespace must be a valid DNS-1123 label"
// wherever the handler applies optionalNamespaceScope, and would break the
// other three tools the moment their handlers adopt the same helper.
func TestListToolsOmittedNamespaceLeavesRequestNamespaceNil(t *testing.T) {
	svc := &recordingListService{}
	client := newTestClient(t, svc)
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))

	tests := []struct {
		tool string
		get  func() *string
	}{
		{"list_clusters", func() *string { return svc.clustersReq.Namespace }},
		{"list_pipelines", func() *string { return svc.pipelinesReq.Namespace }},
		{"list_rollouts", func() *string { return svc.rolloutsReq.Namespace }},
		{"list_releases", func() *string { return svc.releasesReq.Namespace }},
	}
	for _, tc := range tests {
		t.Run(tc.tool, func(t *testing.T) {
			tool, ok := r.Lookup(tc.tool)
			require.True(t, ok)
			_, err := tool.Invoke(context.Background(), client, json.RawMessage(`{}`))
			require.NoError(t, err)
			assert.Nil(t, tc.get(),
				"%s with no namespace argument must leave the outgoing request's Namespace nil, not a pointer to \"\"", tc.tool)
		})
	}
}

// recordingFleetMapService implements QueryFleetMap, returning whatever
// roots it is configured with.
type recordingFleetMapService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	roots []*v1.FleetMapNode
}

func (s *recordingFleetMapService) QueryFleetMap(
	_ context.Context, _ *connect.Request[v1.QueryFleetMapRequest],
) (*connect.Response[v1.QueryFleetMapResponse], error) {
	return connect.NewResponse(&v1.QueryFleetMapResponse{
		Roots: s.roots,
		Total: uint64(len(s.roots)),
	}), nil
}

// TestFleetMapCapsNodesAndMarksTruncation is a regression test for fleet_map
// being the only list-shaped read tool with no bound: QueryFleetMap has no
// server-side pagination, so with no cap the tool would return the entire
// authorized fleet's map tree directly into the model's context.
func TestFleetMapCapsNodesAndMarksTruncation(t *testing.T) {
	roots := make([]*v1.FleetMapNode, maxFleetMapNodes+1)
	for i := range roots {
		roots[i] = &v1.FleetMapNode{StableId: fmt.Sprintf("node-%d", i)}
	}
	svc := &recordingFleetMapService{roots: roots}
	client := newTestClient(t, svc)
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	tool, ok := r.Lookup("fleet_map")
	require.True(t, ok)

	out, err := tool.Invoke(context.Background(), client, json.RawMessage(`{}`))
	require.NoError(t, err)

	result, ok := out.(map[string]any)
	require.True(t, ok, "fleet_map result must be the truncation-marker shape")
	assert.Equal(t, true, result["truncated"])
	assert.NotEmpty(t, result["note"])

	data, ok := result["data"].(*v1.QueryFleetMapResponse)
	require.True(t, ok)
	assert.Len(t, data.Roots, maxFleetMapNodes)
}

// TestFleetMapUnderTheCapIsNotMarkedTruncated is the companion case: a
// response within bounds must be returned as-is, with no truncation marker.
func TestFleetMapUnderTheCapIsNotMarkedTruncated(t *testing.T) {
	roots := []*v1.FleetMapNode{{StableId: "only-node"}}
	svc := &recordingFleetMapService{roots: roots}
	client := newTestClient(t, svc)
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	tool, ok := r.Lookup("fleet_map")
	require.True(t, ok)

	out, err := tool.Invoke(context.Background(), client, json.RawMessage(`{}`))
	require.NoError(t, err)

	result, ok := out.(map[string]any)
	require.True(t, ok)
	assert.Nil(t, result["truncated"])
	data, ok := result["data"].(*v1.QueryFleetMapResponse)
	require.True(t, ok)
	assert.Len(t, data.Roots, 1)
}

// TestFleetMapRejectsUnrecognisedGroup is a regression test for group/
// size_metric silently degrading to "no grouping" on a typo or an
// unrecognised value: get_logs already errors on an unknown kind, and
// fleet_map's group/size_metric must match that behaviour rather than
// silently returning a larger, differently-shaped result with no signal
// that the requested grouping was ignored.
func TestFleetMapRejectsUnrecognisedGroup(t *testing.T) {
	client := newTestClient(t, &stubService{})
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	tool, ok := r.Lookup("fleet_map")
	require.True(t, ok)

	_, err := tool.Invoke(context.Background(), client, json.RawMessage(`{"group":"namespace"}`))
	require.Error(t, err)
	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)
	assert.Equal(t, connect.CodeInvalidArgument, connectErr.Code())
	assert.Contains(t, connectErr.Message(), "namespace")
}

// TestFleetMapRejectsUnrecognisedSizeMetric is TestFleetMapRejectsUnrecognisedGroup
// for size_metric.
func TestFleetMapRejectsUnrecognisedSizeMetric(t *testing.T) {
	client := newTestClient(t, &stubService{})
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	tool, ok := r.Lookup("fleet_map")
	require.True(t, ok)

	_, err := tool.Invoke(context.Background(), client, json.RawMessage(`{"size_metric":"cpu"}`))
	require.Error(t, err)
	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)
	assert.Equal(t, connect.CodeInvalidArgument, connectErr.Code())
	assert.Contains(t, connectErr.Message(), "cpu")
}

// TestFleetMapAcceptsEmptyGroupAndSizeMetric confirms the empty string is
// still a valid "no grouping" / "default metric" input, not itself rejected
// by the new validation.
func TestFleetMapAcceptsEmptyGroupAndSizeMetric(t *testing.T) {
	client := newTestClient(t, &recordingFleetMapService{})
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	tool, ok := r.Lookup("fleet_map")
	require.True(t, ok)

	_, err := tool.Invoke(context.Background(), client, json.RawMessage(`{}`))
	require.NoError(t, err)
}
