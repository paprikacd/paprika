package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// NewAuthorizedBackend is the production entry point. The gateway service
// account's Kubernetes permissions are not the caller's permissions: every
// query must pass the existing human RBAC rules before reading provider or
// credential objects. NewBackend is reserved for trusted internal callers.
func NewAuthorizedBackend(k8sClient client.Client, authorizer auth.Authorizer) Backend {
	inner := &k8sBackend{client: k8sClient, credentialAuthorizer: authorizer}
	return &authorizedBackend{backend: inner, authorizer: authorizer}
}

type authorizedBackend struct {
	backend    Backend
	authorizer auth.Authorizer
}

func (b *authorizedBackend) principal(ctx context.Context) (*auth.Principal, error) {
	p := auth.PrincipalFromContext(ctx)
	if p == nil || p.Subject == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("an authenticated observability principal is required"))
	}
	if b.authorizer == nil {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("observability provider access is not authorized"))
	}
	return p, nil
}

func (b *authorizedBackend) authorize(ctx context.Context, provider string) error {
	p, err := b.principal(ctx)
	if err != nil {
		return err
	}
	namespace, name, found := strings.Cut(provider, "/")
	if !found || namespace == "" || name == "" || strings.Contains(name, "/") {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("provider must be namespace/name"))
	}
	if err := b.authorizer.Authorize(ctx, p, auth.ActionRead, auth.ResourceObservabilityProviders, namespace, ""); err != nil {
		return connect.NewError(connect.CodePermissionDenied, errors.New("observability provider access is not authorized"))
	}
	return nil
}

func (b *authorizedBackend) ListProviders(ctx context.Context) ([]ProviderInfo, error) {
	if _, err := b.principal(ctx); err != nil {
		return nil, err
	}
	providers, err := b.backend.ListProviders(ctx)
	if err != nil {
		return nil, fmt.Errorf("list authorized observability providers: %w", err)
	}
	visible := make([]ProviderInfo, 0, len(providers))
	for _, provider := range providers {
		if err := b.authorize(ctx, provider.Name); err == nil {
			visible = append(visible, provider)
		}
	}
	return visible, nil
}

//nolint:gocritic // QueryRequest travels by value to satisfy the shared Backend interface.
func (b *authorizedBackend) Query(ctx context.Context, provider string, req connector.QueryRequest) (*connector.QueryResult, error) {
	if err := b.authorize(ctx, provider); err != nil {
		return nil, err
	}
	result, err := b.backend.Query(ctx, provider, req)
	if err != nil {
		return nil, fmt.Errorf("query authorized observability provider: %w", err)
	}
	return result, nil
}

//nolint:gocritic // ExploreRequest travels by value to satisfy the shared Backend interface.
func (b *authorizedBackend) Explore(ctx context.Context, provider string, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if err := b.authorize(ctx, provider); err != nil {
		return nil, err
	}
	result, err := b.backend.Explore(ctx, provider, req)
	if err != nil {
		return nil, fmt.Errorf("explore authorized observability provider: %w", err)
	}
	return result, nil
}

// gatewayError is the RFC 6749-shaped error body every HTTP surface of this
// gateway — the MCP protocol endpoints, the usage endpoint, the catalog
// endpoints — answers with on auth and request failures. It mirrors
// mcp.oauthError so one gateway speaks one error dialect; descriptions are
// fixed sentences, never derived from internal error text.
//
//nolint:tagliatelle // RFC 6749 mandates these exact snake_case field names.
type gatewayError struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description,omitempty"`
}

// writeGatewayJSON is the gateway's shared response writer, modeled on
// writeJSON in internal/api/mcp/oauth.go: one content type, one status, then
// a best-effort body — once the status is written the error cannot be
// recovered anyway.
func writeGatewayJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) //nolint:errcheck // best-effort: the status/headers are already written
}

// Authenticator is the slice of the self-signed token authenticator the
// gateway's HTTP surfaces authenticate with: one Authenticate call against
// the request-scoped context. *auth.SelfSignedAuthenticator satisfies it.
type Authenticator interface {
	Authenticate(ctx context.Context) (*auth.Principal, error)
}

// RequireObserveScope returns middleware that protects an HTTP handler with
// exactly the protection the MCP protocol surface has: the request's bearer
// token must authenticate against the paprika-observability audience (the
// authenticator was built for that audience; publicURL and routePrefix
// locate the RFC 9728 protected-resource metadata the 401 answer points at),
// and the resulting principal must carry the paprika:observe scope — the
// same scope every tool behind these endpoints requires.
//
// 401 means the bearer token was missing, malformed, wrongly audiences or
// wrongly issued; 403 means it was valid but observe-scoped access was not
// granted. Both answer the gateway's shared RFC 6749-shaped JSON error
// dialect rather than redirecting, because these endpoints serve the
// console's own fetch, not a browser navigation.
func RequireObserveScope(authenticator Authenticator, publicURL, routePrefix string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := auth.WithRequest(r.Context(), r)
			principal, err := authenticator.Authenticate(ctx)
			if err != nil {
				w.Header().Set("WWW-Authenticate",
					fmt.Sprintf(`Bearer resource_metadata="%s%s/.well-known/oauth-protected-resource"`, publicURL, routePrefix))
				writeGatewayJSON(w, http.StatusUnauthorized,
					gatewayError{Error: "invalid_token", ErrorDescription: "a paprika-observability bearer token is required"})
				return
			}
			if !principalObserves(principal) {
				writeGatewayJSON(w, http.StatusForbidden,
					gatewayError{Error: "insufficient_scope", ErrorDescription: "the paprika:observe scope is required"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// principalObserves reports whether p carries the observability scope. It
// mirrors mcp's reading of Principal.Scopes — the self-signed token's scope
// claim, not the OIDC claim map — so a token that would pass a tool's scope
// gate also passes this middleware.
func principalObserves(p *auth.Principal) bool {
	if p == nil {
		return false
	}
	for _, scope := range p.Scopes {
		if scope == string(mcp.ScopeObserve) {
			return true
		}
	}
	return false
}
