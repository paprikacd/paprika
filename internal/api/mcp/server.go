package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
)

// codeScopeDenied is the JSON-RPC application error code returned for
// ErrScopeDenied. -32000..-32099 is the range the JSON-RPC spec reserves for
// implementation-defined server errors (distinct from -32700..-32600, which
// it reserves for its own predefined errors), so this is a legitimate,
// intentional use of that range rather than a code that risks colliding
// with a spec-defined one.
const codeScopeDenied int64 = -32001

// implementationName and implementationVersion identify this server during
// the MCP initialize handshake.
const (
	implementationName    = "paprika"
	implementationVersion = "0.1.0"
)

// ServerConfig configures a Server. NewServer validates Registry,
// Authenticator, Cache, and Secret; the rest support the OAuth surface
// Task 14 adds via RegisterOAuthRoutes.
type ServerConfig struct {
	Registry      *Registry
	Authenticator auth.Authenticator
	Confirmer     *Confirmer
	Auditor       audit.Auditor
	Cache         *cache.Cache
	Secret        []byte // HMAC secret for minting access tokens
	PublicURL     string // external base URL, used in discovery metadata
	ClientID      string // statically registered OAuth client
	RedirectURIs  []string
	AccessTTL     time.Duration
	RefreshTTL    time.Duration

	// Client is the Connect client tools/call dispatches through. Task 15's
	// buildMCPHandlers constructs it over NewInProcessTransport(connectHandler),
	// so a tool call re-enters the SAME otel -> auth -> audit -> service chain
	// that serves console requests — see the package doc on the blocker this
	// closes. Client is deliberately not part of NewServer's required-field
	// validation: a server built without one still serves tools/list and the
	// unauthenticated-401 path (what this task's given tests exercise); it
	// only fails a tools/call, cleanly, with no client configured.
	Client v1connect.PaprikaServiceClient
}

// Server serves the MCP protocol: tool discovery and invocation over
// Streamable HTTP, authenticating every request with the same Authenticator
// the console API uses.
type Server struct {
	registry      *Registry
	authenticator auth.Authenticator
	invoker       *Invoker
	cache         *cache.Cache
	publicURL     string
	clientID      string
	redirectURIs  []string
	streamable    http.Handler
}

// NewServer validates cfg and builds a Server. Registry, Authenticator,
// Cache, and Secret are required — a server missing its authenticator must
// not start.
//
//nolint:gocritic // cfg is ServerConfig by value per the spec's literal constructor signature (Task 15's buildMCPHandlers constructs one inline); switching to a pointer would change the public API.
func NewServer(cfg ServerConfig) (*Server, error) {
	if cfg.Registry == nil {
		return nil, errors.New("mcp: ServerConfig.Registry is required")
	}
	if cfg.Authenticator == nil {
		return nil, errors.New("mcp: ServerConfig.Authenticator is required")
	}
	if cfg.Cache == nil {
		return nil, errors.New("mcp: ServerConfig.Cache is required")
	}
	if len(cfg.Secret) == 0 {
		return nil, errors.New("mcp: ServerConfig.Secret is required")
	}
	if err := validatePublicURL(cfg.PublicURL); err != nil {
		return nil, err
	}

	s := &Server{
		registry:      cfg.Registry,
		authenticator: cfg.Authenticator,
		cache:         cfg.Cache,
		publicURL:     cfg.PublicURL,
		clientID:      cfg.ClientID,
		redirectURIs:  cfg.RedirectURIs,
	}
	if cfg.Client != nil {
		s.invoker = NewInvoker(cfg.Registry, cfg.Client, cfg.Confirmer, cfg.Auditor)
	}
	s.streamable = newStreamableHandler(s, cfg.Registry)
	return s, nil
}

// validatePublicURL requires publicURL to be an absolute URL. It is embedded
// verbatim into the WWW-Authenticate challenge's resource_metadata parameter
// (writeUnauthenticated); RFC 9728 section 3.2 requires that to be an
// absolute URL, and an empty or relative PublicURL would silently produce a
// challenge no client can resolve.
func validatePublicURL(publicURL string) error {
	u, err := url.Parse(publicURL)
	if err != nil {
		return fmt.Errorf("mcp: ServerConfig.PublicURL: %w", err)
	}
	if !u.IsAbs() {
		return fmt.Errorf("mcp: ServerConfig.PublicURL must be an absolute URL, got %q", publicURL)
	}
	return nil
}

// newStreamableHandler builds the SDK's Streamable HTTP handler around a
// server carrying every tool in r, in Stateless+JSONResponse mode: each
// request is served against a fresh, default-initialized session and the
// response body is plain JSON rather than an SSE stream. That combination
// matches this package's request/response tool-call model and lets a caller
// invoke a tool without first running the initialize handshake.
func newStreamableHandler(s *Server, r *Registry) *sdkmcp.StreamableHTTPHandler {
	sdkSrv := sdkmcp.NewServer(&sdkmcp.Implementation{
		Name:    implementationName,
		Version: implementationVersion,
	}, nil)

	for _, tool := range r.All() {
		destructive := tool.Destructive
		sdkSrv.AddTool(&sdkmcp.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.InputSchema,
			Annotations: &sdkmcp.ToolAnnotations{
				ReadOnlyHint:    tool.Scope == ScopeRead,
				DestructiveHint: &destructive,
			},
		}, s.callTool)
	}

	return sdkmcp.NewStreamableHTTPHandler(
		func(*http.Request) *sdkmcp.Server { return sdkSrv },
		&sdkmcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true},
	)
}

// Handler returns the http.Handler that serves the MCP protocol. It
// authenticates every request with the configured Authenticator before
// delegating to the underlying Streamable HTTP handler, so an unauthenticated
// request never reaches tool dispatch.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.serveHTTP)
}

// RegisterOAuthRoutes wires the MCP OAuth 2.1 authorization surface
// (authorization endpoint, token endpoint, dynamic client registration,
// protected-resource and authorization-server metadata) onto mux.
//
// Implemented in Task 14. It is a deliberate no-op here so that NewServer's
// signature — and ServerConfig's Secret/ClientID/RedirectURIs/AccessTTL/
// RefreshTTL fields, which only that OAuth surface consumes — already match
// what Task 15's buildMCPHandlers requires, without this task reaching into
// OAuth flow logic that is out of its scope.
func (s *Server) RegisterOAuthRoutes(_ *http.ServeMux) {}

// serveHTTP authenticates r, attaches the resulting Principal and the raw
// bearer token to its context, and delegates to the Streamable HTTP handler.
//
// The bearer token is what closes the blocker this task exists for: nothing
// else attaches credentials to the in-process Connect request tools/call
// eventually issues, so without it every tool call would fail
// CodeUnauthenticated against a production chain that always has auth
// enabled. Stashing it here — once, right after authenticating it ourselves
// — lets NewInProcessTransport's RoundTrip (transport.go) forward it as the
// outgoing request's Authorization header, so the SAME Connect auth
// interceptor that guards console requests validates it again and derives
// the Principal the Authorizer enforces project scoping against. See
// ConfirmationRequiredError and the package-level blocker note for the rest
// of the flow.
func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := auth.WithRequest(r.Context(), r)
	principal, err := s.authenticator.Authenticate(ctx)
	if err != nil {
		if errors.Is(err, auth.ErrUnauthenticated) {
			s.writeUnauthenticated(w)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	ctx = auth.WithPrincipal(ctx, principal)
	token, ok := bearerToken(r)
	if !ok {
		// Authentication succeeded but no bearer token could be extracted —
		// e.g. a non-bearer Authenticator Task 15 might configure, or a
		// scheme this function fails to recognise. Proceeding here would
		// let the request continue with nothing for RoundTrip to forward,
		// and every tool call would then die deep in the chain with a
		// misleading CodeUnauthenticated that looks like a client auth
		// failure rather than the real, server-side problem: this front
		// door has no credential to hand downstream. Fail loudly here
		// instead, naming the real cause.
		http.Error(w, "mcp: authenticated request carries no forwardable bearer token", http.StatusInternalServerError)
		return
	}
	ctx = withBearerToken(ctx, token)
	r = r.WithContext(ctx)
	r = ensureStreamableAccept(r)
	s.streamable.ServeHTTP(w, r)
}

// ensureStreamableAccept widens r's Accept header, if needed, to what the
// SDK's Streamable HTTP handler requires on every request regardless of
// StreamableHTTPOptions.JSONResponse: both "application/json" and
// "text/event-stream". This server always runs in JSONResponse mode, so it
// never actually sends an event-stream response — a plain JSON-RPC caller
// like a raw curl POST (or this package's own doJSONRPC test helper)
// shouldn't have to know that SSE is part of the wire contract just to ask
// for JSON. A client that already sent a satisfying Accept header is left
// untouched.
//
// When widening is needed, this returns a CLONE of r rather than mutating
// r.Header in place: r's Header map is shared with the *http.Request the
// caller (net/http) owns — r.WithContext does not copy it — so mutating it
// directly would be visible outside this handler and violate the
// http.Handler contract that a handler must not modify the request it was
// given.
func ensureStreamableAccept(r *http.Request) *http.Request {
	jsonOK, streamOK := acceptsStreamable(r.Header.Values("Accept"))
	if jsonOK && streamOK {
		return r
	}
	clone := r.Clone(r.Context())
	clone.Header.Set("Accept", "application/json, text/event-stream")
	return clone
}

// acceptsStreamable reports whether values already indicates the caller
// accepts "application/json" and/or "text/event-stream", mirroring the
// SDK's own streamableAccepts parsing (mcp/streamable.go) — comma-separated
// values, base media type only, "*/*" and the relevant "type/*" wildcards
// counting for both — but additionally honouring an explicit q=0, which
// RFC 9110 section 12.5.1 defines as the client explicitly refusing that
// media type. A naive substring match would treat
// "application/json;q=0" as acceptance; it is the opposite.
func acceptsStreamable(values []string) (jsonOK, streamOK bool) {
	for _, value := range values {
		for _, raw := range strings.Split(value, ",") {
			base, params, _ := strings.Cut(strings.TrimSpace(raw), ";")
			if isZeroQuality(params) {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(base)) {
			case "application/json", "application/*":
				jsonOK = true
			case "text/event-stream", "text/*":
				streamOK = true
			case "*/*":
				jsonOK, streamOK = true, true
			}
		}
	}
	return jsonOK, streamOK
}

// isZeroQuality reports whether params (the ";"-separated parameters
// following a media type in an Accept header) contains an explicit "q=0".
func isZeroQuality(params string) bool {
	for _, p := range strings.Split(params, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(p), "=")
		if ok && strings.EqualFold(strings.TrimSpace(name), "q") && strings.TrimSpace(value) == "0" {
			return true
		}
	}
	return false
}

// writeUnauthenticated writes the 401 response an MCP client needs to
// discover this server's authorization server and re-run OAuth: the
// WWW-Authenticate challenge points at protected-resource metadata rather
// than naming any credential, so nothing sensitive appears in it.
func (s *Server) writeUnauthenticated(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate",
		fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, s.publicURL))
	w.WriteHeader(http.StatusUnauthorized)
}

// bearerToken extracts the raw bearer token from r's Authorization header,
// if present, for serveHTTP to hand to withBearerToken. It never appears in
// a log line or error message anywhere in this package.
func bearerToken(r *http.Request) (string, bool) {
	v := r.Header.Get("Authorization")
	// Matches SelfSignedAuthenticator.Authenticate's own parsing
	// (self_signed_token.go): scheme compared case-insensitively per
	// RFC 6750 section 2.1, which permits "bearer", "Bearer", or any
	// other casing. Diverging from that here would re-open the blocker
	// this task exists to close for any request whose scheme the
	// authenticator accepts but this function's old case-sensitive match
	// did not — the request would authenticate at the front door and
	// then forward no token at all.
	parts := strings.SplitN(v, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", false
	}
	token := parts[1]
	if token == "" {
		return "", false
	}
	return token, true
}

// callTool is the ToolHandler installed for every tool in the registry. It
// dispatches by name through Invoker.Call rather than closing over any one
// tool, so the mapping from name to behaviour has exactly one source of
// truth: the registry itself.
func (s *Server) callTool(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
	name := req.Params.Name
	result, err := s.invoke(ctx, auth.PrincipalFromContext(ctx), name, req.Params.Arguments)
	if err != nil {
		return s.mapInvokeError(ctx, name, err)
	}
	return toolResult(result)
}

// invoke guards Invoker.Call against a Server built with no Client: calling
// a tool on one would otherwise panic inside the tool's own Invoke func,
// which dereferences the client unconditionally.
func (s *Server) invoke(ctx context.Context, p *auth.Principal, name string, args json.RawMessage) (any, error) {
	if s.invoker == nil {
		return nil, &sdkjsonrpc.Error{
			Code:    sdkjsonrpc.CodeInternalError,
			Message: "mcp: server has no Connect client configured",
		}
	}
	return s.invoker.Call(ctx, p, name, args)
}

// mapInvokeError translates an error from Invoker.Call into what callTool
// should return. Order matches the brief exactly:
//
//   - *ConfirmationRequiredError becomes a SUCCESSFUL tool result carrying
//     the preview and token, not a protocol error — the model needs to see
//     it to act on it, which an error response would hide.
//   - ErrScopeDenied becomes a JSON-RPC error naming the missing scope, at
//     an application-defined code outside the JSON-RPC reserved range.
//   - ErrToolNotFound becomes a standard JSON-RPC method-not-found error.
//     In practice the SDK's own dispatcher rejects an unregistered tool name
//     before callTool ever runs (every registered handler corresponds to a
//     tool the registry has), so this arm is defence in depth rather than a
//     path normal traffic reaches — see mapInvokeError's test for direct
//     coverage of it.
//   - Anything else becomes a JSON-RPC CodeInternalError with a fixed,
//     generic message — never the upstream error's own text, which can
//     name resources or details the caller has no business seeing (e.g. a
//     Connect error naming a namespace or resource the caller cannot list).
//     The real error is logged server-side instead of discarded.
func (s *Server) mapInvokeError(ctx context.Context, name string, err error) (*sdkmcp.CallToolResult, error) {
	var confirmErr *ConfirmationRequiredError
	if errors.As(err, &confirmErr) {
		return confirmationResult(confirmErr)
	}
	switch {
	case errors.Is(err, ErrScopeDenied):
		return nil, &sdkjsonrpc.Error{Code: codeScopeDenied, Message: s.scopeDeniedMessage(name)}
	case errors.Is(err, ErrToolNotFound):
		return nil, &sdkjsonrpc.Error{Code: sdkjsonrpc.CodeMethodNotFound, Message: err.Error()}
	default:
		log.FromContext(ctx).Error(err, "mcp: tool call failed", "tool", name)
		return nil, &sdkjsonrpc.Error{Code: sdkjsonrpc.CodeInternalError, Message: "mcp: internal error"}
	}
}

// scopeDeniedMessage names the scope a tool requires, for the -32001 error
// mapInvokeError returns for ErrScopeDenied. ErrScopeDenied is a bare
// sentinel with no such detail of its own, so this looks the tool back up in
// the registry to find it. Falling back to the sentinel's own text if the
// lookup somehow misses keeps this total rather than panicking on a name
// Invoker.Call itself would already have rejected as ErrToolNotFound.
func (s *Server) scopeDeniedMessage(name string) string {
	tool, ok := s.registry.Lookup(name)
	if !ok {
		return ErrScopeDenied.Error()
	}
	return fmt.Sprintf("tool %q requires scope %q", name, tool.Scope)
}

// confirmationResult renders a ConfirmationRequiredError as a successful
// CallToolResult: human-readable preview as text content, and the token the
// model must echo back via confirmation_token as structured content.
func confirmationResult(e *ConfirmationRequiredError) (*sdkmcp.CallToolResult, error) {
	structured := struct {
		Tool string `json:"tool"`
		// confirmation_token deliberately stays snake_case: it must match
		// the wire name the write tools' InputSchema declares (see
		// confirmationTokenProperty in tools_write.go), which the model
		// echoes back verbatim to execute the confirmed call.
		ConfirmationToken string `json:"confirmation_token"` //nolint:tagliatelle // must match the tool InputSchema's wire field name
	}{Tool: e.Tool, ConfirmationToken: e.Token}

	data, err := json.Marshal(structured)
	if err != nil {
		return nil, fmt.Errorf("mcp: marshal confirmation result: %w", err)
	}
	return &sdkmcp.CallToolResult{
		Content:           []sdkmcp.Content{&sdkmcp.TextContent{Text: e.Preview}},
		StructuredContent: json.RawMessage(data),
	}, nil
}

// toolResult renders a successful tool return value as a CallToolResult.
// Tool Invoke funcs typically return a Connect response's Msg — a proto.Message
// — so proto values are marshalled with protojson to get the field names and
// conventions an MCP client actually expects (snake_case JSON names,
// well-known-type handling); anything else falls back to encoding/json.
func toolResult(v any) (*sdkmcp.CallToolResult, error) {
	data, err := marshalToolResult(v)
	if err != nil {
		return nil, err
	}
	return &sdkmcp.CallToolResult{
		Content:           []sdkmcp.Content{&sdkmcp.TextContent{Text: string(data)}},
		StructuredContent: json.RawMessage(data),
	}, nil
}

func marshalToolResult(v any) ([]byte, error) {
	if msg, ok := v.(proto.Message); ok {
		data, err := protojson.Marshal(msg)
		if err != nil {
			return nil, fmt.Errorf("mcp: protojson marshal: %w", err)
		}
		return data, nil
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("mcp: json marshal: %w", err)
	}
	return data, nil
}
