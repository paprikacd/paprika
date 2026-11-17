package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/metrics"
)

// DefaultProjectName is the project requests resolve to when a
// project-aware RPC leaves its project field empty — handlers and the
// authorization interceptor must agree on it or empty project becomes an
// authorization bypass.
const DefaultProjectName = "default"

// Config combines authentication and authorization configuration.
type Config struct {
	Enabled     bool
	BasicAuth   *BasicAuthConfig
	OIDC        *OIDCConfig
	TokenSecret []byte
	RBACRules   []RBACRule
}

// Interceptor builds the connect.Interceptor that enforces auth config.
//
// Unary RPCs are authenticated and, unless defersProjectSetAuthorization lists
// them, authorized from their request message. A server-streaming RPC is
// authenticated from its request headers before connect reads the request
// body, so a request without valid credentials is answered before its body is
// read and never reaches the handler. Its handler authorizes the request itself,
// so only the procedures in handlerAuthorizedStreams may reach a handler; every
// other streaming procedure is denied. Client streams and bidirectional streams
// are denied for the same reason. With auth disabled, every RPC passes through.
func Interceptor(ctx context.Context, cfg Config, reader client.Reader) (connect.Interceptor, error) {
	if !cfg.Enabled {
		return connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
			return next
		}), nil
	}

	authn, authz, err := buildAuthnAuthz(ctx, cfg, reader)
	if err != nil {
		return nil, err
	}

	return &authInterceptor{authn: authn, authz: authz}, nil
}

// authInterceptor enforces authentication and authorization on connect RPCs.
type authInterceptor struct {
	authn Authenticator
	authz Authorizer
}

// WrapUnary authenticates, then authorizes, a unary request.
func (a *authInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		httpReq := requestFromSpec(req)
		if httpReq != nil {
			ctx = context.WithValue(ctx, requestContextKey{}, httpReq)
		}

		proc := req.Spec().Procedure

		principal, err := a.authenticate(ctx)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, err)
		}

		ctx = WithPrincipal(ctx, principal)
		if defersProjectSetAuthorization(proc) {
			return next(ctx, req)
		}

		action, resource := classify(proc)
		namespace := namespaceFromRequest(req)
		project := projectFromRequest(req)

		if err := a.authz.Authorize(ctx, principal, action, resource, namespace, project); err != nil {
			metrics.AuthzDenials.Add(ctx, 1, metric.WithAttributes(
				attribute.String("action", string(action)),
				attribute.String("resource", string(resource)),
			))
			return nil, connect.NewError(connect.CodePermissionDenied, err)
		}
		metrics.AuthzDecisions.Add(ctx, 1, metric.WithAttributes(attribute.String("decision", "allow")))

		return next(ctx, req)
	}
}

// WrapStreamingClient is a pass-through: this interceptor guards servers only.
func (a *authInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

// WrapStreamingHandler authenticates a server stream from its request headers
// before next runs, so before connect reads the request body. A procedure
// outside handlerAuthorizedStreams is denied after authentication.
func (a *authInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		httpReq := requestFromStream(conn)
		if httpReq != nil {
			ctx = context.WithValue(ctx, requestContextKey{}, httpReq)
		}

		proc := conn.Spec().Procedure

		principal, err := a.authenticate(ctx)
		if err != nil {
			return connect.NewError(connect.CodeUnauthenticated, err)
		}
		ctx = WithPrincipal(ctx, principal)

		if !handlerAuthorizedStreams[proc] {
			action, resource := classify(proc)
			metrics.AuthzDenials.Add(ctx, 1, metric.WithAttributes(
				attribute.String("action", string(action)),
				attribute.String("resource", string(resource)),
			))
			return connect.NewError(connect.CodePermissionDenied,
				fmt.Errorf("streaming procedure %s is not authorized: %w", proc, ErrUnauthorized))
		}

		// The handler re-runs this check on its own schedule while the stream
		// stays open. It uses the same headers, so the re-check sees the same
		// credentials this request presented.
		ctx = withStreamReauthenticator(ctx, func(ctx context.Context) (*Principal, error) {
			if httpReq == nil {
				return nil, ErrUnauthenticated
			}
			return a.authenticate(context.WithValue(ctx, requestContextKey{}, httpReq))
		})
		return next(ctx, conn)
	}
}

// handlerAuthorizedStreams lists the server-streaming procedures whose handler
// authorizes the request itself, with the same action ActionFor returns for the
// procedure. Add a procedure here only after its handler performs that check.
// TestStreamingProceduresAreListedOrDenied fails when a generated streaming
// procedure is missing from this list and is not denied.
var handlerAuthorizedStreams = map[string]bool{
	v1connect.PaprikaServiceStreamResourceLogsProcedure: true,
}

// authenticate runs the configured authenticators and records the same
// metrics for every caller. It returns the principal on success.
func (a *authInterceptor) authenticate(ctx context.Context) (*Principal, error) {
	principal, err := a.authn.Authenticate(ctx)
	if err != nil {
		metrics.AuthFailures.Add(ctx, 1, metric.WithAttributes(attribute.String("method", "unknown")))
		return nil, err //nolint:wrapcheck // the error already wraps ErrUnauthenticated, and unary replies keep its text
	}
	metrics.AuthAttempts.Add(ctx, 1, metric.WithAttributes(attribute.String("subject", principal.Subject)))
	return principal, nil
}

// streamReauthKey carries the re-authenticator for a server stream.
type streamReauthKey struct{}

// withStreamReauthenticator stores the function a streaming handler calls to
// authenticate the stream's original request again. Only the interceptor sets it.
func withStreamReauthenticator(ctx context.Context, fn func(context.Context) (*Principal, error)) context.Context {
	return context.WithValue(ctx, streamReauthKey{}, fn)
}

// StreamReauthenticatorFromContext returns the re-authenticator the interceptor
// stored for a server stream, or nil when the call did not come through the
// streaming interceptor (auth disabled, or a direct call in tests).
func StreamReauthenticatorFromContext(ctx context.Context) func(context.Context) (*Principal, error) {
	if fn, ok := ctx.Value(streamReauthKey{}).(func(context.Context) (*Principal, error)); ok {
		return fn
	}
	return nil
}

func defersProjectSetAuthorization(procedure string) bool {
	switch procedure {
	case v1connect.PaprikaServiceQueryApplicationsProcedure,
		v1connect.PaprikaServiceQueryFleetMapProcedure,
		v1connect.PaprikaServiceQueryFleetMatrixProcedure,
		v1connect.PaprikaServiceGetSystemStatusProcedure,
		v1connect.PaprikaServiceGetSystemHealthProcedure:
		return true
	default:
		return false
	}
}

func buildAuthnAuthz(ctx context.Context, cfg Config, reader client.Reader) (Authenticator, Authorizer, error) {
	authn, err := BuildAuthenticator(ctx, cfg)
	if err != nil {
		return nil, nil, err
	}

	authz, err := BuildAuthorizer(cfg, reader)
	if err != nil {
		return nil, nil, err
	}

	return authn, authz, nil
}

// BuildAuthenticator builds the authenticator stack Interceptor uses to
// authenticate console API calls: Basic auth, OIDC ID tokens, and Paprika
// self-signed tokens, tried in that order. It builds no Authorizer and does not
// wrap the result in a connect.Interceptor.
//
// It is exported so a caller that needs to authenticate a plain *http.Request as
// a console user, outside of a Connect RPC, can reuse this package's
// authenticator construction rather than duplicate it. The MCP OAuth
// authorize/consent surface (internal/api/mcp/oauth.go's handleAuthorize and
// handleAuthorizeConsent) is the first such caller. It must authenticate the
// human in the browser as a console user, accepting the same OIDC and
// self-signed credentials the console accepts, rather than requiring an
// MCP-scoped access token, which nothing but this same authorize flow could
// ever mint.
func BuildAuthenticator(ctx context.Context, cfg Config) (Authenticator, error) {
	authenticators := []Authenticator{}

	if cfg.BasicAuth != nil {
		basic, err := NewBasicAuthenticator(*cfg.BasicAuth)
		if err != nil {
			return nil, fmt.Errorf("basic auth: %w", err)
		}
		authenticators = append(authenticators, basic)
	}

	if cfg.OIDC != nil {
		oidcAuth, err := NewOIDCAuthenticator(ctx, cfg.OIDC)
		if err != nil {
			return nil, fmt.Errorf("oidc auth: %w", err)
		}
		authenticators = append(authenticators, oidcAuth)
	}

	if len(cfg.TokenSecret) > 0 {
		// Strict audience match: a token minted for any OTHER audience (most
		// importantly the MCP server's own "paprika-mcp", see
		// mcp.MCPTokenAudience) must never authenticate here. Before this,
		// NewSelfSignedAuthenticator performed no audience check at all, so
		// a read-scoped MCP token could authenticate directly against this
		// console/CLI Connect API as a full principal — bypassing the MCP
		// layer's scope gate and two-phase confirmation entirely. See
		// ConsoleAPIAudience's doc comment for the full rationale.
		selfSigned, err := NewSelfSignedAuthenticatorForAudience(cfg.TokenSecret, ConsoleAPIAudience, "")
		if err != nil {
			return nil, fmt.Errorf("self-signed auth: %w", err)
		}
		authenticators = append(authenticators, selfSigned)
	}

	if len(authenticators) == 0 {
		return nil, errors.New("auth enabled but no authenticators configured")
	}

	return NewMultiAuthenticator(authenticators...), nil
}

// BuildAuthorizer creates the composed authorizer from config and a Kubernetes reader.
func BuildAuthorizer(cfg Config, reader client.Reader) (Authorizer, error) {
	var authorizers []Authorizer
	if len(cfg.RBACRules) > 0 {
		authorizers = append(authorizers, NewRBACAuthorizer(cfg.RBACRules))
	}
	if reader != nil {
		authorizers = append(authorizers, NewProjectAuthorizer(reader))
	}
	if len(authorizers) == 0 {
		// This should never happen when auth is enabled — the caller should
		// have configured at least RBAC rules or a project-scoped authorizer.
		// Fall back to a DenyAll authorizer so that silence does not mean
		// "allow".
		return &DenyAllAuthorizer{}, nil
	}
	return &multiAuthorizer{authorizers: authorizers}, nil
}

type multiAuthorizer struct {
	authorizers []Authorizer
}

func (m *multiAuthorizer) Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error {
	for _, a := range m.authorizers {
		if err := a.Authorize(ctx, p, action, resource, namespace, project); err != nil {
			return fmt.Errorf("authorizer denied: %w", err)
		}
	}
	return nil
}

func (m *multiAuthorizer) AuthorizedProjects(
	ctx context.Context,
	p *Principal,
	action Action,
	resource Resource,
	candidates []ProjectRef,
) ([]ProjectRef, error) {
	authorized := intersectProjectRefs(candidates, candidates)
	for _, authorizer := range m.authorizers {
		if len(authorized) == 0 {
			return nil, nil
		}
		providerResult, err := authorizer.AuthorizedProjects(ctx, p, action, resource, authorized)
		if err != nil {
			return nil, fmt.Errorf("filter authorized projects: %w", err)
		}
		authorized = intersectProjectRefs(authorized, providerResult)
	}
	return authorized, nil
}

func intersectProjectRefs(input, allowed []ProjectRef) []ProjectRef {
	if len(input) == 0 || len(allowed) == 0 {
		return nil
	}
	allowedSet := make(map[ProjectRef]struct{}, len(allowed))
	for _, project := range allowed {
		allowedSet[project] = struct{}{}
	}
	seen := make(map[ProjectRef]struct{}, len(input))
	intersection := make([]ProjectRef, 0, len(input))
	for _, project := range input {
		if _, duplicate := seen[project]; duplicate {
			continue
		}
		seen[project] = struct{}{}
		if _, accepted := allowedSet[project]; accepted {
			intersection = append(intersection, project)
		}
	}
	return intersection
}

func projectFromRequest(req connect.AnyRequest) string {
	type projectGetter interface {
		GetProject() string
	}
	msg := req.Any()
	if g, ok := msg.(projectGetter); ok {
		// Project-aware RPCs default an empty project to the default
		// project — the handlers do the same, and without it a caller could
		// omit project to skip the AppProject check entirely (the authorizer
		// treats "" as "no project constraint").
		if p := g.GetProject(); p != "" {
			return p
		}
		return DefaultProjectName
	}
	return ""
}

func requestFromSpec(req connect.AnyRequest) *httpRequest {
	return newHTTPRequest(req.Peer(), req.Header())
}

// requestFromStream is requestFromSpec for a server stream, which carries its
// request headers on the connection rather than on a request value.
func requestFromStream(conn connect.StreamingHandlerConn) *httpRequest {
	return newHTTPRequest(conn.Peer(), conn.RequestHeader())
}

// newHTTPRequest copies the request headers into the minimal request the
// authenticators read. It returns nil for a peer without a protocol.
func newHTTPRequest(peer connect.Peer, header http.Header) *httpRequest {
	if peer.Protocol == "" {
		return nil
	}

	// We cannot recover the original *http.Request from connect request.
	// This is a minimal wrapper for header extraction.
	hdr := make(http.Header)
	for key, vals := range header {
		for _, v := range vals {
			hdr.Add(key, v)
		}
	}

	return &httpRequest{headers: hdr}
}

type httpRequest struct {
	headers http.Header
}

func (r *httpRequest) Header() http.Header {
	return r.headers
}

var resourceKeywords = map[string]Resource{
	"application": ResourceApplications,
	"pipeline":    ResourcePipelines,
	"release":     ResourceReleases,
	"stage":       ResourceStages,
	"template":    ResourceTemplates,
	"artifact":    ResourceArtifacts,
	"rollout":     ResourceRollouts,
}

// ActionFor returns the action and resource the unary classifier requires for a
// procedure. Streaming handlers use it so their own checks are at least as
// strict as the unary path.
func ActionFor(procedure string) (Action, Resource) {
	return classify(procedure)
}

func classify(procedure string) (Action, Resource) {
	// Investigation collects existing application evidence. Unlike Get/List
	// RPCs, its name does not identify it as a read to the fallback below.
	if procedure == v1connect.PaprikaServiceInvestigateProcedure {
		return ActionRead, ResourceApplications
	}
	// A follow returns the same pod's log lines as unary GetResourceLogs, which
	// requires read. The name has neither "get" nor "list", so it needs its own case.
	if procedure == v1connect.PaprikaServiceStreamResourceLogsProcedure {
		return ActionRead, ResourceApplications
	}
	lower := strings.ToLower(procedure)

	resource := ResourceApplications
	for keyword, res := range resourceKeywords {
		if strings.Contains(lower, keyword) {
			resource = res
			break
		}
	}

	action := ActionWrite
	if strings.Contains(lower, "list") || strings.Contains(lower, "get") {
		action = ActionRead
	}

	return action, resource
}

func namespaceFromRequest(req connect.AnyRequest) string {
	// Resolve the owning object's namespace, not a subordinate resource's.
	msg := req.Any()
	if ns, ok := extractNamespace(msg); ok {
		return ns
	}
	return ""
}

func extractNamespace(msg interface{}) (string, bool) {
	if msg == nil {
		return "", false
	}
	// Common protobuf patterns for namespace.
	type namespaceGetter interface {
		GetNamespace() string
	}
	if g, ok := msg.(namespaceGetter); ok {
		return g.GetNamespace(), true
	}
	type applicationNamespaceGetter interface {
		GetApplicationNamespace() string
	}
	if g, ok := msg.(applicationNamespaceGetter); ok {
		return g.GetApplicationNamespace(), true
	}
	type pipelineNamespaceGetter interface {
		GetPipelineNamespace() string
	}
	if g, ok := msg.(pipelineNamespaceGetter); ok {
		return g.GetPipelineNamespace(), true
	}
	return "", false
}
