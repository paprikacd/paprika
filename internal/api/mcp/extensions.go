package mcp

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/benebsworth/paprika/internal/api/auth"
	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// The Go server implements the extension wire contracts directly; the view
// bundles the official MCP Apps and OpenAI Extensions browser SDKs.
const (
	consoleResourceURI = "ui://paprika/console"
	consoleMIMEType    = "text/html;profile=mcp-app"
	mentionLimit       = 20
)

//go:embed ui/dist/console.html
var consoleHTML string

func paprikaIcons() []sdkmcp.Icon {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5c1-2 3-3 5-3M11 5c-3-2-7 0-7 4 0 4 2 7 6 8 4-1 6-4 6-8 0-4-3-6-5-4Z"/><path d="M8 8c-1 1-1 3 0 4"/></svg>`
	return []sdkmcp.Icon{{Source: "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg)), MIMEType: "image/svg+xml"}}
}

func readOpenFleetTool() Tool {
	return Tool{
		Name: "open_fleet", Title: "Paprika",
		Description: "Open the interactive Paprika fleet console with application health, drift, releases, investigations, and logs. Accepts empty arguments from navigation or a chat tab.",
		Scope:       ScopeRead, Icons: paprikaIcons(),
		Meta: sdkmcp.Meta{
			"ui":        map[string]any{"resourceUri": consoleResourceURI, "visibility": []string{"model", "app"}},
			"openai/ui": map[string]any{"entrypoints": []map[string]string{{"type": "global"}, {"type": "thread"}}},
		},
		InputSchema: json.RawMessage(`{"type":"object","properties":{"namespace":{"type":"string"},"search":{"type":"string"},"page_size":{"type":"integer","minimum":1,"maximum":200,"default":50},"cursor":{"type":"string"}},"additionalProperties":false}`),
		Invoke:      readOpenFleetInvoke,
	}
}

func readOpenFleetInvoke(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	in, err := decodeArgs(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	namespace := in.string("namespace")
	statusReq := &v1.GetSystemStatusRequest{AttentionLimit: mentionLimit}
	var filter *v1.FleetFilter
	if namespace != "" {
		statusReq.Namespace = &namespace
		filter = &v1.FleetFilter{Namespaces: []string{namespace}}
	}
	status, err := c.GetSystemStatus(ctx, connect.NewRequest(statusReq))
	if err != nil {
		return nil, fmt.Errorf("open_fleet: status: %w", err)
	}
	apps, err := c.QueryApplications(ctx, connect.NewRequest(&v1.QueryApplicationsRequest{
		Filter: filter, Search: in.string("search"), PageSize: clampPageSize(in.uint32("page_size")), Cursor: in.string("cursor"),
	}))
	if err != nil {
		return nil, fmt.Errorf("open_fleet: applications: %w", err)
	}
	fleetJSON, err := marshalToolResult(status.Msg)
	if err != nil {
		return nil, err
	}
	appsJSON, err := marshalToolResult(apps.Msg)
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"fleet": json.RawMessage(fleetJSON), "applications": json.RawMessage(appsJSON),
		"observedAt": time.Now().UTC().Format(time.RFC3339), "namespace": namespace, "search": in.string("search"),
	}
	if connection, ok := connectionFromContext(ctx); ok {
		result["connection"] = connection
	}
	return result, nil
}

func readSearchMentionsTool() Tool {
	return Tool{
		Name: "search_mentions", Title: "Find an application",
		Description: "Search authorized applications for the composer mention picker. Returns bounded application resource links; mentioning an app does not authorize an action.",
		Scope:       ScopeRead,
		Meta: sdkmcp.Meta{
			"openai/extensions": map[string]any{"mentions/search": map[string]any{}},
			"ui":                map[string]any{"visibility": []string{"app"}},
		},
		InputSchema:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","maxLength":256}},"required":["query"],"additionalProperties":false}`),
		OutputSchema: json.RawMessage(`{"type":"object","properties":{"items":{"type":"array","maxItems":20,"items":{"type":"object","properties":{"type":{"const":"resource_link"},"uri":{"type":"string"},"name":{"type":"string"}},"required":["type","uri","name"]}}},"required":["items"]}`),
		Invoke:       readSearchMentionsInvoke,
	}
}

func readSearchMentionsInvoke(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	in, err := decodeArgs(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	query, ok := in["query"].(string)
	if !ok || len(query) > 256 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("query must be a string of at most 256 bytes"))
	}
	resp, err := c.QueryApplications(ctx, connect.NewRequest(&v1.QueryApplicationsRequest{Search: query, PageSize: mentionLimit}))
	if err != nil {
		return nil, fmt.Errorf("search_mentions: %w", err)
	}
	items := make([]*sdkmcp.ResourceLink, 0, mentionLimit)
	for _, app := range resp.Msg.Applications {
		id := app.GetIdentity()
		if id.GetName() == "" || id.GetNamespace() == "" {
			continue
		}
		items = append(items, &sdkmcp.ResourceLink{
			URI: applicationResourceURI(id.Namespace, id.Name), Name: id.Namespace + "/" + id.Name, Title: id.Name,
			MIMEType: "application/json", Icons: paprikaIcons(),
			Description: fmt.Sprintf("%s · health %s · sync %s · %d drifted resources", id.Namespace,
				mentionStateLabel(app.Health.String(), "FLEET_HEALTH_"), mentionStateLabel(app.Sync.String(), "FLEET_SYNC_STATE_"), app.DriftCount),
		})
		if len(items) == mentionLimit {
			break
		}
	}
	data, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		return nil, fmt.Errorf("search_mentions: encode links: %w", err)
	}
	return &sdkmcp.CallToolResult{Content: []sdkmcp.Content{}, StructuredContent: json.RawMessage(data)}, nil
}

func mentionStateLabel(state, prefix string) string {
	label := strings.TrimPrefix(state, prefix)
	if label == "UNSPECIFIED" {
		return "unknown"
	}
	return strings.ToLower(strings.ReplaceAll(label, "_", " "))
}

func applicationResourceURI(namespace, name string) string {
	return "paprika://applications/" + url.PathEscape(namespace) + "/" + url.PathEscape(name)
}

func parseApplicationResourceURI(raw string) (namespace, name string, err error) {
	u, err := url.Parse(raw)
	if err != nil || !validApplicationResourceURL(u) {
		return "", "", errors.New("invalid application resource URI")
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) != 2 || len(validation.IsDNS1123Label(parts[0])) != 0 || len(validation.IsDNS1123Subdomain(parts[1])) != 0 {
		return "", "", errors.New("invalid application resource identity")
	}
	return parts[0], parts[1], nil
}

func validApplicationResourceURL(u *url.URL) bool {
	return u.Scheme == "paprika" && u.Host == "applications" && u.User == nil &&
		u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && u.RawFragment == ""
}

func consoleResourceMeta() sdkmcp.Meta {
	return sdkmcp.Meta{
		"ui": map[string]any{
			"prefersBorder": false,
			"csp":           map[string]any{"connectDomains": []string{}, "resourceDomains": []string{}},
		},
		"openai/ui": map[string]any{"preferredDisplayMode": "fullscreen", "availableDisplayModes": []string{"fullscreen"}},
	}
}

func (s *Server) registerAppResources(server *sdkmcp.Server) {
	server.AddResource(&sdkmcp.Resource{
		URI: consoleResourceURI, Name: "paprika-console", Title: "Paprika delivery fleet",
		Description: "Interactive application health and deployment console.", MIMEType: consoleMIMEType, Meta: consoleResourceMeta(),
	}, func(ctx context.Context, _ *sdkmcp.ReadResourceRequest) (*sdkmcp.ReadResourceResult, error) {
		if !principalHasScope(auth.PrincipalFromContext(ctx), ScopeRead) {
			return nil, &sdkjsonrpc.Error{Code: codeScopeDenied, Message: "Paprika console requires scope paprika:read"}
		}
		return &sdkmcp.ReadResourceResult{Contents: []*sdkmcp.ResourceContents{{URI: consoleResourceURI, MIMEType: consoleMIMEType, Text: consoleHTML, Meta: consoleResourceMeta()}}}, nil
	})
	server.AddResourceTemplate(&sdkmcp.ResourceTemplate{
		URITemplate: "paprika://applications/{namespace}/{name}", Name: "paprika-application", Title: "Application health report",
		Description: "Current authorized application health, drift, release, and rollout evidence.", MIMEType: "application/json",
	}, s.readApplicationResource)
}

func (s *Server) readApplicationResource(ctx context.Context, req *sdkmcp.ReadResourceRequest) (*sdkmcp.ReadResourceResult, error) {
	namespace, name, err := parseApplicationResourceURI(req.Params.URI)
	if err != nil {
		return nil, &sdkjsonrpc.Error{Code: sdkjsonrpc.CodeInvalidParams, Message: "invalid application resource URI"}
	}
	args, err := json.Marshal(map[string]string{"namespace": namespace, "name": name})
	if err != nil {
		return nil, fmt.Errorf("application resource: encode identity: %w", err)
	}
	result, err := s.invoke(ctx, auth.PrincipalFromContext(ctx), "get_application_health", args)
	if err != nil {
		if errors.Is(err, ErrScopeDenied) {
			return nil, &sdkjsonrpc.Error{Code: codeScopeDenied, Message: "Application resources require scope paprika:read"}
		}
		// Resource access must not leak upstream errors or permission-scoped
		// existence information. Full evidence is resolved via the same
		// authenticated Connect chain as ordinary tools.
		if connect.CodeOf(err) == connect.CodeNotFound || connect.CodeOf(err) == connect.CodePermissionDenied {
			return nil, fmt.Errorf("application resource: %w", sdkmcp.ResourceNotFoundError(req.Params.URI))
		}
		log.FromContext(ctx).Error(err, "mcp: application resource read failed")
		return nil, &sdkjsonrpc.Error{Code: sdkjsonrpc.CodeInternalError, Message: "application health report unavailable"}
	}
	data, err := marshalToolResult(result)
	if err != nil {
		return nil, err
	}
	return &sdkmcp.ReadResourceResult{Contents: []*sdkmcp.ResourceContents{{URI: req.Params.URI, MIMEType: "application/json", Text: string(data)}}}, nil
}
