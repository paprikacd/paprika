package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
)

// Config combines authentication and authorization configuration.
type Config struct {
	Enabled     bool
	BasicAuth   *BasicAuthConfig
	OIDC        *OIDCConfig
	RBACRules   []RBACRule
	AllowUnauth bool
}

// Interceptor creates a connect.UnaryInterceptorFunc from auth config.
func Interceptor(cfg Config) (connect.UnaryInterceptorFunc, error) {
	if !cfg.Enabled {
		return func(next connect.UnaryFunc) connect.UnaryFunc {
			return next
		}, nil
	}

	authn, authz, err := buildAuthnAuthz(cfg)
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
				if cfg.AllowUnauth {
					return next(ctx, req)
				}
				return nil, connect.NewError(connect.CodeUnauthenticated, err)
			}

			ctx = WithPrincipal(ctx, principal)

			action, resource := classify(req.Spec().Procedure)
			namespace := namespaceFromRequest(req)

			if err := authz.Authorize(ctx, principal, action, resource, namespace, ""); err != nil {
				return nil, connect.NewError(connect.CodePermissionDenied, err)
			}

			return next(ctx, req)
		}
	}, nil
}

func buildAuthnAuthz(cfg Config) (Authenticator, Authorizer, error) {
	authenticators := []Authenticator{}

	if cfg.BasicAuth != nil {
		basic, err := NewBasicAuthenticator(*cfg.BasicAuth)
		if err != nil {
			return nil, nil, fmt.Errorf("basic auth: %w", err)
		}
		authenticators = append(authenticators, basic)
	}

	if cfg.OIDC != nil {
		oidcAuth, err := NewOIDCAuthenticator(context.Background(), cfg.OIDC)
		if err != nil {
			return nil, nil, fmt.Errorf("oidc auth: %w", err)
		}
		authenticators = append(authenticators, oidcAuth)
	}

	if len(authenticators) == 0 {
		return nil, nil, errors.New("auth enabled but no authenticators configured")
	}

	var authz Authorizer
	if len(cfg.RBACRules) > 0 {
		authz = NewRBACAuthorizer(cfg.RBACRules)
	} else {
		authz = &AllowAllAuthorizer{}
	}

	return NewMultiAuthenticator(authenticators...), authz, nil
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
