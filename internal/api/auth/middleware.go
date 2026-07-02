package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Config combines authentication and authorization configuration.
type Config struct {
	Enabled   bool
	BasicAuth *BasicAuthConfig
	OIDC      *OIDCConfig
	RBACRules []RBACRule
}

// Interceptor creates a connect.UnaryInterceptorFunc from auth config.
func Interceptor(ctx context.Context, cfg Config, reader client.Reader) (connect.UnaryInterceptorFunc, error) {
	if !cfg.Enabled {
		return func(next connect.UnaryFunc) connect.UnaryFunc {
			return next
		}, nil
	}

	authn, authz, err := buildAuthnAuthz(ctx, cfg, reader)
	if err != nil {
		return nil, err
	}

	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			httpReq := requestFromSpec(req)
			if httpReq != nil {
				ctx = context.WithValue(ctx, requestContextKey{}, httpReq)
			}

		principal, err := authn.Authenticate(ctx)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, err)
		}

			ctx = WithPrincipal(ctx, principal)

			action, resource := classify(req.Spec().Procedure)
			namespace := namespaceFromRequest(req)
			project := projectFromRequest(req)

			if err := authz.Authorize(ctx, principal, action, resource, namespace, project); err != nil {
				return nil, connect.NewError(connect.CodePermissionDenied, err)
			}

			return next(ctx, req)
		}
	}, nil
}

func buildAuthnAuthz(ctx context.Context, cfg Config, reader client.Reader) (Authenticator, Authorizer, error) {
	authenticators := []Authenticator{}

	if cfg.BasicAuth != nil {
		basic, err := NewBasicAuthenticator(*cfg.BasicAuth)
		if err != nil {
			return nil, nil, fmt.Errorf("basic auth: %w", err)
		}
		authenticators = append(authenticators, basic)
	}

	if cfg.OIDC != nil {
		oidcAuth, err := NewOIDCAuthenticator(ctx, cfg.OIDC)
		if err != nil {
			return nil, nil, fmt.Errorf("oidc auth: %w", err)
		}
		authenticators = append(authenticators, oidcAuth)
	}

	if len(authenticators) == 0 {
		return nil, nil, errors.New("auth enabled but no authenticators configured")
	}

	authz, err := BuildAuthorizer(cfg, reader)
	if err != nil {
		return nil, nil, err
	}

	return NewMultiAuthenticator(authenticators...), authz, nil
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

func projectFromRequest(req connect.AnyRequest) string {
	type projectGetter interface {
		GetProject() string
	}
	msg := req.Any()
	if g, ok := msg.(projectGetter); ok {
		return g.GetProject()
	}
	return ""
}

func requestFromSpec(req connect.AnyRequest) *httpRequest {
	peer := req.Peer()
	if peer.Protocol == "" {
		return nil
	}

	// We cannot recover the original *http.Request from connect request.
	// This is a minimal wrapper for header extraction.
	hdr := make(http.Header)
	for key, vals := range req.Header() {
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

func classify(procedure string) (Action, Resource) {
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
	// Try to extract namespace from common request message fields.
	// This uses reflection to find Namespace string fields.
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
	return "", false
}
