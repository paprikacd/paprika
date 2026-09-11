package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// Pagination bounds shared by every list tool. page_size defaults to
// defaultPageSize and is clamped server-side to maxPageSize: the schema's
// "maximum" is advisory only, so the Go code is the actual control.
const (
	defaultPageSize  = 50
	maxPageSize      = 200
	defaultTailLines = 200
	maxTailLines     = 2000
)

// readToolRPCs maps each read tool to the Connect RPC(s) it covers. Task 10's
// completeness guard consumes this to verify every proto RPC is either
// exposed as a tool or explicitly opted out. get_resource_tree and get_logs
// each dispatch to two RPCs behind a parameter, so both must be listed.
//
//nolint:unused // consumed by Task 10's coverage_test.go, added in a later task.
var readToolRPCs = map[string][]string{
	"fleet_status":      {"GetSystemStatus"},
	"list_clusters":     {"ListClusters"},
	"fleet_map":         {"QueryFleetMap"},
	"list_applications": {"QueryApplications"},
	"get_application":   {"GetApplication"},
	"investigate":       {"Investigate"},
	"get_resource_tree": {"GetResourceTree", "GetResourceTreeDetailed"},
	"get_logs":          {"GetResourceLogs", "GetStepLogs"},
	"list_pipelines":    {"ListPipelines"},
	"get_pipeline_run":  {"GetPipelineRun"},
	"list_releases":     {"ListReleases"},
	"list_rollouts":     {"ListRollouts"},
	"get_rollout":       {"GetRollout"},
	"query_cost":        {"QueryCost"},
}

// fleetGroupDimensions and fleetSizeMetrics translate the string enums used
// in tool schemas into the proto enums QueryFleetMap expects. The empty
// string is a valid input meaning "no grouping" / "default metric" and maps
// to each enum's UNSPECIFIED member; any other unrecognised value is
// rejected by lookupFleetGroupDimension/lookupFleetSizeMetric below rather
// than silently degrading to UNSPECIFIED, since a caller who asked to group
// and mistyped the dimension should see an error, not a differently-shaped
// result with no signal that anything went wrong.
var fleetGroupDimensions = map[string]v1.FleetGroupDimension{
	"project": v1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
	"cluster": v1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
	"stage":   v1.FleetGroupDimension_FLEET_GROUP_DIMENSION_STAGE,
	"health":  v1.FleetGroupDimension_FLEET_GROUP_DIMENSION_HEALTH,
}

var fleetSizeMetrics = map[string]v1.FleetSizeMetric{
	"resource_count": v1.FleetSizeMetric_FLEET_SIZE_METRIC_RESOURCE_COUNT,
	"request_rate":   v1.FleetSizeMetric_FLEET_SIZE_METRIC_REQUEST_RATE,
}

// lookupFleetGroupDimension validates the group argument against
// fleetGroupDimensions. Empty means "no grouping"; anything else not in the
// map is an error naming the invalid value and the accepted ones, matching
// how get_logs handles an unrecognised kind.
func lookupFleetGroupDimension(s string) (v1.FleetGroupDimension, error) {
	if s == "" {
		return v1.FleetGroupDimension_FLEET_GROUP_DIMENSION_UNSPECIFIED, nil
	}
	v, ok := fleetGroupDimensions[s]
	if !ok {
		return 0, fmt.Errorf("fleet_map: group must be one of %q, got %q",
			[]string{"project", "cluster", "stage", "health"}, s)
	}
	return v, nil
}

// lookupFleetSizeMetric is lookupFleetGroupDimension for size_metric.
func lookupFleetSizeMetric(s string) (v1.FleetSizeMetric, error) {
	if s == "" {
		return v1.FleetSizeMetric_FLEET_SIZE_METRIC_UNSPECIFIED, nil
	}
	v, ok := fleetSizeMetrics[s]
	if !ok {
		return 0, fmt.Errorf("fleet_map: size_metric must be one of %q, got %q",
			[]string{"resource_count", "request_rate"}, s)
	}
	return v, nil
}

// RegisterReadTools registers the read-only tool surface. Each tool maps to
// one or more Connect RPCs; near-duplicate RPCs are merged behind a
// parameter rather than exposed separately, to keep tool selection
// unambiguous.
func RegisterReadTools(r *Registry) error {
	tools := []Tool{
		readFleetStatusTool(),
		readListClustersTool(),
		readFleetMapTool(),
		readListApplicationsTool(),
		readGetApplicationTool(),
		readInvestigateTool(),
		readGetResourceTreeTool(),
		readGetLogsTool(),
		readListPipelinesTool(),
		readGetPipelineRunTool(),
		readListReleasesTool(),
		readListRolloutsTool(),
		readGetRolloutTool(),
		readQueryCostTool(),
	}
	for _, t := range tools {
		if err := r.Register(t); err != nil {
			return err
		}
	}
	return nil
}

// toolArgs is a decoded tool-call argument object. Read tools decode into
// this rather than a struct with json tags: the wire protocol's field names
// (page_size, application_namespace, ...) are snake_case by MCP convention,
// which this repo's tagliatelle configuration (camelCase json tags) would
// otherwise flag on every field.
type toolArgs map[string]any

// decodeArgs parses a tool call's raw arguments. Absent or literal-null
// arguments decode to an empty toolArgs rather than erroring, since every
// field below has a documented default.
func decodeArgs(raw json.RawMessage) (toolArgs, error) {
	if len(raw) == 0 {
		return toolArgs{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode arguments: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return toolArgs(m), nil
}

func (a toolArgs) string(key string) string {
	if s, ok := a[key].(string); ok {
		return s
	}
	return ""
}

func (a toolArgs) bool(key string) bool {
	if b, ok := a[key].(bool); ok {
		return b
	}
	return false
}

// uint32 reads a JSON number field. JSON numbers decode to float64 in a
// map[string]any, so negative or absent values are reported as 0 and left
// to the caller's own clamping/default logic.
func (a toolArgs) uint32(key string) uint32 {
	f, ok := a[key].(float64)
	if !ok || f < 0 {
		return 0
	}
	return uint32(f)
}

func (a toolArgs) int32(key string) int32 {
	f, ok := a[key].(float64)
	if !ok {
		return 0
	}
	return int32(f)
}

// clampPageSize enforces [1, maxPageSize], defaulting an unset or
// out-of-range value to defaultPageSize.
func clampPageSize(n uint32) uint32 {
	if n == 0 || n > maxPageSize {
		return defaultPageSize
	}
	return n
}

// clampPageSizeInt32 is clampPageSize for the RPCs (ListReleases) that
// declare page_size as a signed int32 rather than uint32.
func clampPageSizeInt32(n int32) int32 {
	if n <= 0 || n > maxPageSize {
		return defaultPageSize
	}
	return n
}

// clampTailLines enforces [1, maxTailLines], defaulting an unset or
// out-of-range value to defaultTailLines.
func clampTailLines(n int32) int32 {
	if n <= 0 || n > maxTailLines {
		return defaultTailLines
	}
	return n
}

// optionalString returns nil for an empty string and a pointer to s
// otherwise. Several request messages use an optional *string namespace
// field where nil means "no filter" and a non-nil pointer to "" is treated
// as an explicit, invalid namespace (see optionalNamespaceScope in
// console_stub.go, which rejects &"" via IsDNS1123Label). Every tool that
// forwards an optional namespace argument onto such a field must go through
// this helper rather than taking &namespace directly, or an omitted
// argument turns into a rejected request.
func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// truncated marks a cursor-paginated response so the model knows it is not
// seeing the whole fleet. Silent truncation would let it reason confidently
// over partial data.
func truncated(payload any, nextCursor string) map[string]any {
	out := map[string]any{"data": payload}
	if nextCursor != "" {
		out["truncated"] = true
		out["next_cursor"] = nextCursor
		out["note"] = "More results exist. Re-call with cursor to continue."
	}
	return out
}

// truncatedOffset is truncated for the one RPC (ListReleases) that paginates
// by page_offset rather than an opaque cursor.
func truncatedOffset(payload any, nextOffset string) map[string]any {
	out := map[string]any{"data": payload}
	if nextOffset != "" {
		out["truncated"] = true
		out["next_page_offset"] = nextOffset
		out["note"] = "More results exist. Re-call with page_offset to continue."
	}
	return out
}

// truncatedBySize caps items to pageSize when the RPC itself returns
// everything with no cursor of its own (ListPipelines, ListRollouts), so the
// model still gets an explicit marker instead of silently seeing a partial
// list with no indication more exists.
func truncatedBySize[T any](items []T, pageSize uint32) map[string]any {
	if len(items) <= int(pageSize) {
		return map[string]any{"data": items}
	}
	out := map[string]any{"data": items[:pageSize]}
	out["truncated"] = true
	out["note"] = "More results exist than fit in this response. Narrow with namespace or project to see the rest."
	return out
}

// maxFleetMapNodes bounds the TOTAL number of nodes (every root plus every
// descendant reachable through Children, recursively) that fleet_map returns
// in one response. QueryFleetMap has no server-side pagination of its own,
// and — critically — the server defaults an omitted/UNSPECIFIED group to "by
// project" rather than "ungrouped" (normalizeGroupDimension in
// internal/fleet/map.go), so a bare fleet_map{} call is ALWAYS grouped:
// Roots is one node per project/cluster/stage/health bucket, which in a
// realistic fleet is a small number, nowhere near a 200-node cap. The actual
// bulk of the payload is every application as a leaf in each root's
// Children, which a roots-only cap does not bound at all. This constant is
// therefore applied against the total node count across the whole tree, not
// len(Roots) — reusing maxPageSize (200), the same bound already applied to
// every other list tool, since nothing about fleet_map's payload risk
// differs enough from theirs to justify a different number.
const maxFleetMapNodes = maxPageSize

// truncatedFleetMap caps a QueryFleetMap response to at most
// maxFleetMapNodes total nodes — roots and every descendant in Children,
// recursively, combined — and marks the response when the full tree
// exceeded that cap. Nodes are kept in the server's own order (roots first,
// then each root's own children in order) and dropped once the budget is
// exhausted, so a truncated response is always a deterministic prefix of
// the full tree, never an arbitrary subset, and children are trimmed
// in place rather than silently omitted with no signal.
func truncatedFleetMap(msg *v1.QueryFleetMapResponse) map[string]any {
	total := countFleetMapNodes(msg.Roots)
	if total <= maxFleetMapNodes {
		return map[string]any{"data": msg}
	}
	budget := maxFleetMapNodes
	capped := &v1.QueryFleetMapResponse{
		Roots:           capFleetMapNodes(msg.Roots, &budget),
		Total:           msg.Total,
		IndexGeneration: msg.IndexGeneration,
		Facets:          msg.Facets,
	}
	shown := maxFleetMapNodes - budget
	return map[string]any{
		"data":      capped,
		"truncated": true,
		"note": fmt.Sprintf(
			"Showing %d of %d fleet map nodes (roots and children combined; children were trimmed, not just top-level groups). "+
				"Narrow with group, search, or a namespace/project filter to see the rest.",
			shown, total),
	}
}

// countFleetMapNodes counts every node in a tree: each element of nodes,
// plus every descendant reachable through its Children, recursively.
func countFleetMapNodes(nodes []*v1.FleetMapNode) int {
	count := len(nodes)
	for _, n := range nodes {
		count += countFleetMapNodes(n.Children)
	}
	return count
}

// capFleetMapNodes returns a prefix of nodes — and, within each kept node, a
// prefix of its own children — that fits within *budget total nodes,
// decrementing budget by one for every node emitted (root or descendant).
// Once budget reaches zero, no further nodes are emitted at any level, so a
// node's children are never included without the node itself, and a later
// sibling is never included ahead of an earlier one.
func capFleetMapNodes(nodes []*v1.FleetMapNode, budget *int) []*v1.FleetMapNode {
	if *budget <= 0 || len(nodes) == 0 {
		return nil
	}
	kept := make([]*v1.FleetMapNode, 0, len(nodes))
	for _, n := range nodes {
		if *budget <= 0 {
			break
		}
		*budget--
		// proto.Clone rather than a plain struct copy (copyNode := *n):
		// FleetMapNode embeds a protoimpl.MessageState containing a
		// sync.Mutex, which govet's copylocks check correctly refuses to let
		// a raw value copy duplicate.
		cloned := proto.Clone(n)
		copyNode, ok := cloned.(*v1.FleetMapNode)
		if !ok {
			// proto.Clone always returns the same concrete type it was
			// given; unreachable in practice, but keeps the type assertion
			// checked rather than blindly discarded.
			copyNode = n
		}
		copyNode.Children = capFleetMapNodes(n.Children, budget)
		kept = append(kept, copyNode)
	}
	return kept
}

func readFleetStatusTool() Tool {
	return Tool{
		Name:        "fleet_status",
		Description: "Overall fleet health: application counts by state, degraded applications, and configured data sources.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
			resp, err := c.GetSystemStatus(ctx, connect.NewRequest(&v1.GetSystemStatusRequest{}))
			if err != nil {
				return nil, fmt.Errorf("fleet_status: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func readListClustersTool() Tool {
	return Tool{
		Name:        "list_clusters",
		Description: "List clusters in the fleet, optionally including CPU and memory capacity meters.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"include_capacity":{"type":"boolean","default":false},
				"page_size":{"type":"integer","default":50,"maximum":200},
				"cursor":{"type":"string"}
			},
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			pageSize := clampPageSize(in.uint32("page_size"))
			resp, err := c.ListClusters(ctx, connect.NewRequest(&v1.ListClustersRequest{
				Namespace:       optionalString(in.string("namespace")),
				IncludeCapacity: in.bool("include_capacity"),
				PageSize:        pageSize,
				Cursor:          in.string("cursor"),
			}))
			if err != nil {
				return nil, fmt.Errorf("list_clusters: %w", err)
			}
			return truncated(resp.Msg, resp.Msg.NextCursor), nil
		},
	}
}

func readFleetMapTool() Tool {
	return Tool{
		Name:        "fleet_map",
		Description: "Hierarchical fleet topology grouped by project, cluster, stage, or health, sized by resource count or request rate.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"search":{"type":"string"},
				"group":{"type":"string","enum":["","project","cluster","stage","health"],"default":""},
				"size_metric":{"type":"string","enum":["","resource_count","request_rate"],"default":""}
			},
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			group, err := lookupFleetGroupDimension(in.string("group"))
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			sizeMetric, err := lookupFleetSizeMetric(in.string("size_metric"))
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.QueryFleetMap(ctx, connect.NewRequest(&v1.QueryFleetMapRequest{
				Search:     in.string("search"),
				Group:      group,
				SizeMetric: sizeMetric,
			}))
			if err != nil {
				return nil, fmt.Errorf("fleet_map: %w", err)
			}
			return truncatedFleetMap(resp.Msg), nil
		},
	}
}

func readListApplicationsTool() Tool {
	return Tool{
		Name:        "list_applications",
		Description: "List applications across the fleet, with optional namespace and free-text filtering, and pagination.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"search":{"type":"string"},
				"page_size":{"type":"integer","default":50,"maximum":200},
				"cursor":{"type":"string"}
			},
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			pageSize := clampPageSize(in.uint32("page_size"))
			var filter *v1.FleetFilter
			if namespace := in.string("namespace"); namespace != "" {
				filter = &v1.FleetFilter{Namespaces: []string{namespace}}
			}
			resp, err := c.QueryApplications(ctx, connect.NewRequest(&v1.QueryApplicationsRequest{
				Filter:   filter,
				Search:   in.string("search"),
				PageSize: pageSize,
				Cursor:   in.string("cursor"),
			}))
			if err != nil {
				return nil, fmt.Errorf("list_applications: %w", err)
			}
			return truncated(resp.Msg, resp.Msg.NextCursor), nil
		},
	}
}

func readGetApplicationTool() Tool {
	return Tool{
		Name:        "get_application",
		Description: "Fetch full detail for one application by name and namespace.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"name":{"type":"string"},
				"namespace":{"type":"string"}
			},
			"required":["name","namespace"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.GetApplication(ctx, connect.NewRequest(&v1.GetApplicationRequest{
				Name:      in.string("name"),
				Namespace: in.string("namespace"),
			}))
			if err != nil {
				return nil, fmt.Errorf("get_application: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func readInvestigateTool() Tool {
	return Tool{
		Name:        "investigate",
		Description: "Run automated root-cause investigation against an application or one of its resources, returning findings and a narrated summary.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"application_namespace":{"type":"string"},
				"application_name":{"type":"string"},
				"resource_kind":{"type":"string"},
				"resource_name":{"type":"string"},
				"resource_namespace":{"type":"string"}
			},
			"required":["application_namespace","application_name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.Investigate(ctx, connect.NewRequest(&v1.InvestigateRequest{
				ApplicationNamespace: in.string("application_namespace"),
				ApplicationName:      in.string("application_name"),
				ResourceKind:         in.string("resource_kind"),
				ResourceName:         in.string("resource_name"),
				ResourceNamespace:    in.string("resource_namespace"),
			}))
			if err != nil {
				return nil, fmt.Errorf("investigate: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

// readGetResourceTreeTool merges GetResourceTree and GetResourceTreeDetailed
// behind a detailed parameter. The two RPCs take differently named fields
// for the same identifiers (namespace/name vs application_namespace/
// application_name), so the tool exposes one namespace/name pair and maps it
// onto whichever the chosen RPC expects.
func readGetResourceTreeTool() Tool {
	return Tool{
		Name:        "get_resource_tree",
		Description: "Fetch an application's resource tree. Set detailed=true for the richer per-resource tree used by the console (health, sync, images) rather than the compact node list.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"},
				"detailed":{"type":"boolean","default":false}
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: readGetResourceTreeInvoke,
	}
}

func readGetResourceTreeInvoke(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	in, err := decodeArgs(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	namespace, name := in.string("namespace"), in.string("name")

	if in.bool("detailed") {
		detailedResp, detailedErr := c.GetResourceTreeDetailed(ctx, connect.NewRequest(&v1.GetResourceTreeDetailedRequest{
			ApplicationNamespace: namespace,
			ApplicationName:      name,
		}))
		if detailedErr != nil {
			return nil, fmt.Errorf("get_resource_tree: %w", detailedErr)
		}
		return detailedResp.Msg, nil
	}

	resp, err := c.GetResourceTree(ctx, connect.NewRequest(&v1.GetResourceTreeRequest{
		Namespace: namespace,
		Name:      name,
	}))
	if err != nil {
		return nil, fmt.Errorf("get_resource_tree: %w", err)
	}
	return resp.Msg, nil
}

// readGetLogsTool merges GetResourceLogs and GetStepLogs behind a required
// kind parameter, since StreamResourceLogs (the third logs RPC) is
// server-streaming and cannot be exposed as a request/response tool call.
func readGetLogsTool() Tool {
	return Tool{
		Name:        "get_logs",
		Description: "Fetch tailed logs, either from a live Kubernetes resource (kind=resource) or a pipeline step (kind=step).",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"kind":{"type":"string","enum":["resource","step"]},
				"tail_lines":{"type":"integer","default":200,"maximum":2000},
				"application_namespace":{"type":"string"},
				"application_name":{"type":"string"},
				"resource_kind":{"type":"string"},
				"resource_name":{"type":"string"},
				"resource_namespace":{"type":"string"},
				"pipeline_name":{"type":"string"},
				"pipeline_namespace":{"type":"string"},
				"step_name":{"type":"string"}
			},
			"required":["kind","tail_lines"],
			"additionalProperties":false
		}`),
		Invoke: readGetLogsInvoke,
	}
}

func readGetLogsInvoke(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	in, err := decodeArgs(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	tailLines := clampTailLines(in.int32("tail_lines"))

	switch kind := in.string("kind"); kind {
	case "resource":
		resp, err := c.GetResourceLogs(ctx, connect.NewRequest(&v1.GetResourceLogsRequest{
			ApplicationNamespace: in.string("application_namespace"),
			ApplicationName:      in.string("application_name"),
			ResourceKind:         in.string("resource_kind"),
			ResourceName:         in.string("resource_name"),
			ResourceNamespace:    in.string("resource_namespace"),
			TailLines:            tailLines,
		}))
		if err != nil {
			return nil, fmt.Errorf("get_logs: %w", err)
		}
		return resp.Msg, nil
	case "step":
		resp, err := c.GetStepLogs(ctx, connect.NewRequest(&v1.GetStepLogsRequest{
			PipelineName:      in.string("pipeline_name"),
			PipelineNamespace: in.string("pipeline_namespace"),
			StepName:          in.string("step_name"),
			TailLines:         tailLines,
		}))
		if err != nil {
			return nil, fmt.Errorf("get_logs: %w", err)
		}
		return resp.Msg, nil
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("get_logs: kind must be %q or %q, got %q", "resource", "step", kind))
	}
}

func readListPipelinesTool() Tool {
	return Tool{
		Name:        "list_pipelines",
		Description: "List pipelines in the fleet, optionally scoped to a namespace or project.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"project":{"type":"string"},
				"page_size":{"type":"integer","default":50,"maximum":200}
			},
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			pageSize := clampPageSize(in.uint32("page_size"))
			resp, err := c.ListPipelines(ctx, connect.NewRequest(&v1.ListPipelinesRequest{
				Namespace: optionalString(in.string("namespace")),
				Project:   in.string("project"),
			}))
			if err != nil {
				return nil, fmt.Errorf("list_pipelines: %w", err)
			}
			return truncatedBySize(resp.Msg.Pipelines, pageSize), nil
		},
	}
}

func readGetPipelineRunTool() Tool {
	return Tool{
		Name:        "get_pipeline_run",
		Description: "Fetch the current status and step detail for one pipeline run.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"}
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.GetPipelineRun(ctx, connect.NewRequest(&v1.GetPipelineRunRequest{
				Namespace: in.string("namespace"),
				Name:      in.string("name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("get_pipeline_run: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func readListReleasesTool() Tool {
	return Tool{
		Name:        "list_releases",
		Description: "List releases for an application, project, or namespace, newest first.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"project":{"type":"string"},
				"application_name":{"type":"string"},
				"page_size":{"type":"integer","default":50,"maximum":200},
				"page_offset":{"type":"integer","default":0}
			},
			"additionalProperties":false
		}`),
		Invoke: readListReleasesInvoke,
	}
}

func readListReleasesInvoke(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	in, err := decodeArgs(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	pageSize := clampPageSizeInt32(in.int32("page_size"))
	pageOffset := in.int32("page_offset")
	if pageOffset < 0 {
		pageOffset = 0
	}

	resp, err := c.ListReleases(ctx, connect.NewRequest(&v1.ListReleasesRequest{
		Namespace:       optionalString(in.string("namespace")),
		Project:         in.string("project"),
		ApplicationName: in.string("application_name"),
		PageSize:        pageSize,
		PageOffset:      pageOffset,
	}))
	if err != nil {
		return nil, fmt.Errorf("list_releases: %w", err)
	}
	nextOffset := ""
	if int64(pageOffset)+int64(len(resp.Msg.Releases)) < int64(resp.Msg.TotalCount) {
		nextOffset = strconv.Itoa(int(pageOffset) + len(resp.Msg.Releases))
	}
	return truncatedOffset(resp.Msg, nextOffset), nil
}

func readListRolloutsTool() Tool {
	return Tool{
		Name:        "list_rollouts",
		Description: "List progressive rollouts in the fleet, optionally scoped to a namespace or project.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"project":{"type":"string"},
				"page_size":{"type":"integer","default":50,"maximum":200}
			},
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			pageSize := clampPageSize(in.uint32("page_size"))
			resp, err := c.ListRollouts(ctx, connect.NewRequest(&v1.ListRolloutsRequest{
				Namespace: optionalString(in.string("namespace")),
				Project:   in.string("project"),
			}))
			if err != nil {
				return nil, fmt.Errorf("list_rollouts: %w", err)
			}
			return truncatedBySize(resp.Msg.Rollouts, pageSize), nil
		},
	}
}

func readGetRolloutTool() Tool {
	return Tool{
		Name:        "get_rollout",
		Description: "Fetch full detail for one progressive rollout by name and namespace.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"namespace":{"type":"string"},
				"name":{"type":"string"}
			},
			"required":["namespace","name"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			resp, err := c.GetRollout(ctx, connect.NewRequest(&v1.GetRolloutRequest{
				Namespace: in.string("namespace"),
				Name:      in.string("name"),
			}))
			if err != nil {
				return nil, fmt.Errorf("get_rollout: %w", err)
			}
			return resp.Msg, nil
		},
	}
}

func readQueryCostTool() Tool {
	return Tool{
		Name:        "query_cost",
		Description: "Query fleet cost broken down by application and cluster. Reports an explicit data state (e.g. not configured) rather than empty results when no cost source is wired up.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"page_size":{"type":"integer","default":50,"maximum":200},
				"cursor":{"type":"string"}
			},
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			pageSize := clampPageSize(in.uint32("page_size"))
			resp, err := c.QueryCost(ctx, connect.NewRequest(&v1.QueryCostRequest{
				PageSize: pageSize,
				Cursor:   in.string("cursor"),
			}))
			if err != nil {
				return nil, fmt.Errorf("query_cost: %w", err)
			}
			return truncated(resp.Msg, resp.Msg.NextCursor), nil
		},
	}
}
