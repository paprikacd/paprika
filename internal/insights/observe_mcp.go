package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"time"

	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// This allowlist is the Paprika Observe data-source contract, not an arbitrary
// MCP tool runner. Authoring tools and provider mutations never reach widgets.
var observeDataTools = map[string]bool{
	"list_observability_providers": true,
	"query_metrics":                true, "query_traces": true,
	"list_metric_names": true, "list_label_names": true, "list_label_values": true,
	"list_metric_series": true, "get_metric_metadata": true, "list_trace_services": true,
}

type observeMCPTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type observeConnectionStatus struct {
	Configured      bool             `json:"configured"`
	Connected       bool             `json:"connected"`
	Transport       string           `json:"transport"`
	Tools           []observeMCPTool `json:"tools"`
	ProviderCount   int              `json:"providerCount"`
	ProtocolVersion string           `json:"protocolVersion,omitempty"`
}

type observeMCPConnection struct {
	ctx     context.Context
	cancel  context.CancelFunc
	session *sdkmcp.ClientSession
	tools   map[string]observeMCPTool
}

// Authorization and sessions are request-local. Neither the process token nor
// another caller's catalog/session may substitute for the delegated identity.
func (g *observeGateway) connect(ctx context.Context, token string) (*observeMCPConnection, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	u := *g.baseURL
	u.Path, u.RawPath = "/observe/mcp", ""
	httpClient := *g.client
	httpClient.Transport = &observeMCPTransport{base: g.client.Transport, token: token, ctx: ctx, endpoint: u.String()}
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "paprika-insights", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdkmcp.StreamableClientTransport{
		Endpoint: u.String(), HTTPClient: &httpClient, MaxRetries: -1,
		DisableStandaloneSSE: true, MaxEventSize: maxResponseBytes,
	}, nil)
	if err != nil {
		cancel()
		return nil, sanitizeObserveMCPError(err)
	}
	connection := &observeMCPConnection{ctx: ctx, cancel: cancel, session: session, tools: make(map[string]observeMCPTool)}
	if err := connection.discover(); err != nil {
		connection.close()
		return nil, err
	}
	return connection, nil
}

func (c *observeMCPConnection) close() { c.cancel(); closeReadBody(c.session) }

func (c *observeMCPConnection) discover() error {
	cursor := ""
	seenCursors := make(map[string]bool)
	seenNames := make(map[string]bool)
	for page := 0; page < 8; page++ {
		result, err := c.session.ListTools(c.ctx, &sdkmcp.ListToolsParams{Cursor: cursor})
		if err != nil {
			return sanitizeObserveMCPError(err)
		}
		if result == nil {
			return errUpstream
		}
		if err := c.addTools(result.Tools, seenNames); err != nil {
			return err
		}
		if result.NextCursor == "" {
			return c.requireTool("list_observability_providers")
		}
		if seenCursors[result.NextCursor] {
			return errUpstream
		}
		seenCursors[result.NextCursor] = true
		cursor = result.NextCursor
	}
	return errUpstream
}

func (c *observeMCPConnection) addTools(tools []*sdkmcp.Tool, seenNames map[string]bool) error {
	for _, tool := range tools {
		if tool == nil || seenNames[tool.Name] || len(seenNames) >= 256 {
			return errUpstream
		}
		seenNames[tool.Name] = true
		if observeDataTools[tool.Name] && tool.Annotations != nil && tool.Annotations.ReadOnlyHint {
			if len(tool.Description) > 8192 {
				return errUpstream
			}
			c.tools[tool.Name] = observeMCPTool{Name: tool.Name, Description: tool.Description}
		}
	}
	return nil
}

func (c *observeMCPConnection) requireTool(name string) error {
	if _, ok := c.tools[name]; !ok || !observeDataTools[name] {
		return &observeError{http.StatusServiceUnavailable, "observability MCP does not expose the required read-only data tool"}
	}
	return nil
}

func (c *observeMCPConnection) call(name string, args any, limit int64) (payload []byte, failed bool, callErr error) {
	if err := c.requireTool(name); err != nil {
		return nil, false, err
	}
	result, err := c.session.CallTool(c.ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return nil, false, sanitizeObserveMCPError(err)
	}
	if result == nil || result.StructuredContent == nil {
		return nil, false, errUpstream
	}
	body, err := json.Marshal(result.StructuredContent)
	if err != nil || int64(len(body)) > limit {
		return nil, false, errUpstream
	}
	if result.IsError {
		var failure struct {
			Error *struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &failure) != nil {
			return nil, false, errUpstream
		}
		if failure.Error != nil {
			return nil, false, observeMCPDomainError(failure.Error.Code)
		}
	}
	// A provider failure is still structured data. Its fixed state maps to the
	// existing sanitized HTTP status; never expose an MCP error's text content.
	return body, result.IsError, nil
}

func (s *Server) observeConnection(w http.ResponseWriter, r *http.Request) {
	status := observeConnectionStatus{Configured: s.observe != nil, Transport: "mcp", Tools: []observeMCPTool{}}
	if s.observe == nil {
		writeJSON(w, http.StatusOK, status)
		return
	}
	token, err := delegatedObserveToken(r)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	connection, err := s.observe.connect(r.Context(), token)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	defer connection.close()
	providers, err := connection.providers()
	if err != nil {
		writeProviderError(w, err)
		return
	}
	status.Connected, status.ProviderCount = true, len(providers)
	for _, tool := range connection.tools {
		status.Tools = append(status.Tools, tool)
	}
	sort.Slice(status.Tools, func(i, j int) bool { return status.Tools[i].Name < status.Tools[j].Name })
	if result := connection.session.InitializeResult(); result != nil {
		status.ProtocolVersion = result.ProtocolVersion
	}
	writeJSON(w, http.StatusOK, status)
}

// Bound JSON responses before the SDK decodes them; its MaxEventSize applies
// only to SSE. Non-2xx bodies may contain credentials and are never forwarded.
type observeMCPTransport struct {
	base     http.RoundTripper
	token    string
	ctx      context.Context
	endpoint string
}

func (t *observeMCPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.String() != t.endpoint {
		return nil, errUpstream
	}
	if err := t.ctx.Err(); err != nil {
		return nil, sanitizeObserveMCPError(err)
	}
	ctx, cancel := context.WithCancel(request.Context())
	stop := context.AfterFunc(t.ctx, cancel) //nolint:contextcheck // Merge the caller operation deadline with each SDK request, including background cancellation notifications.
	defer stop()
	defer cancel()
	r := request.Clone(ctx)
	r.Header.Set("Authorization", "Bearer "+t.token)
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(r)
	if err != nil {
		return nil, sanitizeObserveMCPError(err)
	}
	defer closeReadBody(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, observeHTTPError(response.StatusCode)
	}
	if response.ContentLength > maxResponseBytes {
		return nil, errUpstream
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return nil, errUpstream
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}

func sanitizeObserveMCPError(err error) error {
	var remote *observeError
	if errors.As(err, &remote) {
		return remote
	}
	var protocol *sdkjsonrpc.Error
	if errors.As(err, &protocol) {
		switch protocol.Code {
		case -32001: // Paprika's fixed MCP scope-denied code.
			return observeHTTPError(http.StatusForbidden)
		case sdkjsonrpc.CodeInvalidParams:
			return observeHTTPError(http.StatusBadRequest)
		case sdkjsonrpc.CodeMethodNotFound:
			return &observeError{http.StatusServiceUnavailable, "observability MCP does not expose the required data tool"}
		}
	}
	if errors.Is(err, ErrNotFound) {
		return ErrNotFound
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return observeHTTPError(http.StatusGatewayTimeout)
	}
	return &observeError{http.StatusBadGateway, "observability MCP is unavailable"}
}

// Connect machine codes are part of Paprika's trusted MCP contract. Messages
// and details are intentionally ignored; widgets receive only fixed UI errors.
func observeMCPDomainError(code string) error {
	switch code {
	case "invalid_argument":
		return observeHTTPError(http.StatusBadRequest)
	case "unauthenticated", "permission_denied":
		return observeHTTPError(http.StatusForbidden)
	case "not_found":
		return ErrNotFound
	case "resource_exhausted":
		return observeHTTPError(http.StatusTooManyRequests)
	case "deadline_exceeded":
		return observeHTTPError(http.StatusGatewayTimeout)
	case "canceled":
		return &observeError{http.StatusRequestTimeout, "observability request was canceled"}
	case "failed_precondition":
		return &observeError{http.StatusServiceUnavailable, "observability provider is not fully configured"}
	default:
		return errUpstream
	}
}
