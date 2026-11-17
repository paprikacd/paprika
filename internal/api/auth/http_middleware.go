package auth

import (
	"context"
	"encoding/json"
	"net/http"

	"sigs.k8s.io/controller-runtime/pkg/client"
)

// HTTPMiddleware applies the same authenticators and RBAC policy as the Connect
// API to ordinary HTTP handlers. Pass a nil reader for global resources whose
// access must be explicitly granted by global RBAC, rather than an AppProject.
func HTTPMiddleware(ctx context.Context, cfg Config, reader client.Reader, classifyRequest func(*http.Request) (Action, Resource)) (func(http.Handler) http.Handler, error) {
	if !cfg.Enabled {
		return func(next http.Handler) http.Handler { return next }, nil
	}
	authn, authz, err := buildAuthnAuthz(ctx, cfg, reader)
	if err != nil {
		return nil, err
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestCtx := WithRequest(r.Context(), r)
			principal, err := authn.Authenticate(requestCtx)
			if err != nil {
				httpAuthError(w, http.StatusUnauthorized, "authentication required")
				return
			}
			requestCtx = WithPrincipal(requestCtx, principal)
			action, resource := classifyRequest(r)
			if err := authz.Authorize(requestCtx, principal, action, resource, "", ""); err != nil {
				httpAuthError(w, http.StatusForbidden, "permission denied")
				return
			}
			next.ServeHTTP(w, r.WithContext(requestCtx))
		})
	}, nil
}

func httpAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message}) //nolint:errcheck // The status is already written; a failed error response cannot be recovered.
}
