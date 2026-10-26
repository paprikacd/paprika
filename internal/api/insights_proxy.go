package apiserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/api/auth"
)

const InsightsPrefix = "/api/insights"

// InsightsProxyOptions enables delegation to the separately authorized Observe gateway.
// The issuer must match that gateway's configured public URL.
type InsightsProxyOptions struct {
	ObservabilityIssuer string
}

type insightsObserveTokenKey struct{}

// NewInsightsProxy keeps provider credentials and the service token out of the
// browser. Only configured destinations are accepted; browser-provided URLs,
// cookies, authorization, and forwarding headers are never sent upstream.
func NewInsightsProxy(ctx context.Context, cfg auth.Config, endpoint, token string, options ...InsightsProxyOptions) (http.Handler, error) {
	if endpoint == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			insightsProxyError(w, http.StatusServiceUnavailable, "Insights service is not configured")
		}), nil
	}
	var issuer string
	if len(options) > 0 {
		issuer = options[0].ObservabilityIssuer
	}
	if issuer != "" && (!cfg.Enabled || len(cfg.TokenSecret) == 0) {
		return nil, errors.New("insights observability integration requires authentication and a signing secret")
	}
	u, err := insightsEndpoint(endpoint, token)
	if err != nil {
		return nil, err
	}
	middleware, err := auth.HTTPMiddleware(ctx, insightsGlobalAuthConfig(cfg), nil, insightsRequestPermission)
	if err != nil {
		return nil, fmt.Errorf("configure insights authentication: %w", err)
	}
	proxy, err := insightsReverseProxy(u, token)
	if err != nil {
		return nil, err
	}
	return middleware(insightsProxyRequestHandler(proxy, cfg, issuer)), nil
}

func insightsEndpoint(endpoint, token string) (*url.URL, error) {
	u, err := url.Parse(endpoint)
	if err != nil || !validInsightsOrigin(u) {
		return nil, errors.New("PAPRIKA_INSIGHTS_URL must be an HTTP(S) origin without credentials")
	}
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("PAPRIKA_INSIGHTS_TOKEN must contain at least 32 characters")
	}
	return u, nil
}

func validInsightsOrigin(u *url.URL) bool {
	return u.Hostname() != "" && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Path == "" || u.Path == "/")
}

func insightsGlobalAuthConfig(cfg auth.Config) auth.Config {
	// Insights currently exposes instance-wide providers/dashboards. Existing
	// project-scoped wildcard rules must not silently gain global access through
	// the ordinary authorizer's empty-project fallback.
	globalConfig := cfg
	globalConfig.RBACRules = nil
	for _, rule := range cfg.RBACRules {
		if len(rule.Projects) == 0 || slices.Contains(rule.Projects, "*") {
			globalConfig.RBACRules = append(globalConfig.RBACRules, rule)
		}
	}
	return globalConfig
}

func insightsRequestPermission(r *http.Request) (auth.Action, auth.Resource) {
	if r.URL.Path == InsightsPrefix+"/provider-configs" || strings.HasPrefix(r.URL.Path, InsightsPrefix+"/provider-configs/") {
		return auth.ActionAdmin, auth.ResourceInsights
	}
	readPost := r.Method == http.MethodPost && (r.URL.Path == InsightsPrefix+"/query" || r.URL.Path == InsightsPrefix+"/query-dashboard" || (strings.HasPrefix(r.URL.Path, InsightsPrefix+"/providers/") && strings.HasSuffix(r.URL.Path, "/test")))
	if r.Method == http.MethodGet || r.Method == http.MethodHead || readPost {
		return auth.ActionRead, auth.ResourceInsights
	}
	return auth.ActionWrite, auth.ResourceInsights
}

func insightsReverseProxy(u *url.URL, token string) (*httputil.ReverseProxy, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("insights proxy requires an HTTP transport")
	}
	transport := base.Clone()
	transport.ResponseHeaderTimeout = 25 * time.Second
	transport.MaxIdleConnsPerHost = 16
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(u)
			pr.Out.URL.Path = "/api" + strings.TrimPrefix(pr.In.URL.Path, InsightsPrefix)
			pr.Out.URL.RawPath = ""
			// Allow only API data and concurrency headers, never end-user secrets.
			pr.Out.Header = make(http.Header)
			for _, name := range []string{"Content-Type", "If-Match", "If-None-Match"} {
				if v := pr.In.Header.Get(name); v != "" {
					pr.Out.Header.Set(name, v)
				}
			}
			pr.Out.Header.Set("Accept", "application/json")
			pr.Out.Header.Set("Authorization", "Bearer "+token)
			if delegated, ok := pr.In.Context().Value(insightsObserveTokenKey{}).(string); ok {
				pr.Out.Header.Set("X-Paprika-Observe-Token", delegated)
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Del("Set-Cookie")
			if resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.StatusCode != http.StatusNotModified {
				return errors.New("unexpected service redirect")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			insightsProxyError(w, http.StatusBadGateway, "Insights service is unavailable")
		},
	}
	return proxy, nil
}

func insightsProxyRequestHandler(proxy http.Handler, cfg auth.Config, issuer string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, InsightsPrefix+"/") {
			insightsProxyError(w, 404, "Insights endpoint not found")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 28*time.Second)
		defer cancel()
		if issuer != "" {
			principal := auth.PrincipalFromContext(ctx)
			if principal == nil || principal.Subject == "" {
				insightsProxyError(w, http.StatusUnauthorized, "authentication required")
				return
			}
			delegated, err := auth.IssueTokenWithOptions(auth.TokenOptions{
				Subject: principal.Subject, Email: principal.Email, Name: principal.Name,
				Groups:   append([]string{}, principal.Groups...),
				Audience: "paprika-observability", Issuer: issuer, Scope: "paprika:observe",
				TTL: 30 * time.Second, Secret: cfg.TokenSecret,
			})
			if err != nil {
				insightsProxyError(w, 503, "Observability authorization is unavailable")
				return
			}
			ctx = context.WithValue(ctx, insightsObserveTokenKey{}, delegated)
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		proxy.ServeHTTP(w, r.WithContext(ctx))
	})
}

func insightsProxyError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message}) //nolint:errcheck // The status is already written; a failed error response cannot be recovered.
}
