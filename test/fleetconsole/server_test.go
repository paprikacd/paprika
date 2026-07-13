package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func TestParseConfigDefaultsAndOverrides(t *testing.T) {
	t.Parallel()

	defaults, err := parseConfig(nil)
	if err != nil {
		t.Fatalf("parse defaults: %v", err)
	}
	if defaults.listen != "127.0.0.1:3100" {
		t.Fatalf("default listen = %q, want 127.0.0.1:3100", defaults.listen)
	}
	if defaults.assets != "ui/out" {
		t.Fatalf("default assets = %q, want ui/out", defaults.assets)
	}
	if defaults.applications != 250 {
		t.Fatalf("default applications = %d, want 250", defaults.applications)
	}

	overrides, err := parseConfig([]string{
		"--listen", "127.0.0.1:0",
		"--assets", "compiled-ui",
		"--applications", "37",
	})
	if err != nil {
		t.Fatalf("parse overrides: %v", err)
	}
	if overrides.listen != "127.0.0.1:0" || overrides.assets != "compiled-ui" || overrides.applications != 37 {
		t.Fatalf("unexpected overrides: %+v", overrides)
	}

	if _, err := parseConfig([]string{"--applications", "-1"}); err == nil {
		t.Fatal("parseConfig accepted a negative application count")
	}
}

func TestStaticHandlerServesExportedRoutesAssetsAndFallback(t *testing.T) {
	t.Parallel()

	assets := t.TempDir()
	writeAsset(t, assets, "index.html", "spa-shell")
	writeAsset(t, assets, "dashboard/applications.html", "fleet-html")
	writeAsset(t, assets, "dashboard/matrix/index.html", "matrix-html")
	writeAsset(t, assets, "_next/static/app.js", "console.log('fleet')")

	handler, err := newStaticHandler(assets)
	if err != nil {
		t.Fatalf("newStaticHandler: %v", err)
	}

	tests := []struct {
		name         string
		path         string
		wantBody     string
		wantCache    string
		wantTypePart string
	}{
		{
			name:         "route dot html without trailing slash",
			path:         "/dashboard/applications",
			wantBody:     "fleet-html",
			wantCache:    "no-cache, no-store, must-revalidate",
			wantTypePart: "text/html",
		},
		{
			name:         "route dot html with trailing slash",
			path:         "/dashboard/applications/",
			wantBody:     "fleet-html",
			wantCache:    "no-cache, no-store, must-revalidate",
			wantTypePart: "text/html",
		},
		{
			name:         "route directory without trailing slash",
			path:         "/dashboard/matrix",
			wantBody:     "matrix-html",
			wantCache:    "no-cache, no-store, must-revalidate",
			wantTypePart: "text/html",
		},
		{
			name:         "route directory with trailing slash",
			path:         "/dashboard/matrix/",
			wantBody:     "matrix-html",
			wantCache:    "no-cache, no-store, must-revalidate",
			wantTypePart: "text/html",
		},
		{
			name:         "safe deep link falls back to shell",
			path:         "/dashboard/unknown/deep-link",
			wantBody:     "spa-shell",
			wantCache:    "no-cache, no-store, must-revalidate",
			wantTypePart: "text/html",
		},
		{
			name:         "compiled asset",
			path:         "/_next/static/app.js",
			wantBody:     "console.log('fleet')",
			wantCache:    "public, max-age=31536000, immutable",
			wantTypePart: "javascript",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, tt.path, nil))
			result := response.Result()
			defer result.Body.Close()

			if result.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", result.StatusCode)
			}
			body, readErr := io.ReadAll(result.Body)
			if readErr != nil {
				t.Fatalf("read body: %v", readErr)
			}
			if string(body) != tt.wantBody {
				t.Fatalf("body = %q, want %q", body, tt.wantBody)
			}
			if got := result.Header.Get("Cache-Control"); got != tt.wantCache {
				t.Fatalf("Cache-Control = %q, want %q", got, tt.wantCache)
			}
			if got := result.Header.Get("Content-Type"); !strings.Contains(got, tt.wantTypePart) {
				t.Fatalf("Content-Type = %q, want substring %q", got, tt.wantTypePart)
			}
		})
	}
}

func TestStaticHandlerRejectsTraversalInsteadOfServingSPAFallback(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	assets := filepath.Join(parent, "out")
	if err := os.MkdirAll(assets, 0o750); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	writeAsset(t, assets, "index.html", "spa-shell")
	writeAsset(t, parent, "secret.txt", "do-not-serve")

	handler, err := newStaticHandler(assets)
	if err != nil {
		t.Fatalf("newStaticHandler: %v", err)
	}

	for _, requestPath := range []string{"/../secret.txt", "/%2e%2e/secret.txt", `/..\secret.txt`} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, requestPath, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("path %q status = %d, want 404", requestPath, response.Code)
		}
		if strings.Contains(response.Body.String(), "do-not-serve") || strings.Contains(response.Body.String(), "spa-shell") {
			t.Fatalf("path %q disclosed content: %q", requestPath, response.Body.String())
		}
	}
}

func TestFixtureServerServesCompiledUIAndRealFleetConnectQueries(t *testing.T) {
	assets := t.TempDir()
	writeAsset(t, assets, "index.html", "spa-shell")
	writeAsset(t, assets, "dashboard/applications/index.html", "compiled-fleet-console")

	fixture, err := seedFixture(t.Context(), 24)
	if err != nil {
		t.Fatalf("seed fixture: %v", err)
	}
	handler, err := newFixtureHandler(fixture, assets)
	if err != nil {
		t.Fatalf("newFixtureHandler: %v", err)
	}

	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	serverContext, cancelServer := context.WithCancel(t.Context())
	serverDone := make(chan error, 1)
	go func() {
		serverDone <- serve(serverContext, listener, handler)
	}()
	var stopOnce sync.Once
	stopServer := func() {
		stopOnce.Do(func() {
			cancelServer()
			select {
			case serveErr := <-serverDone:
				if serveErr != nil {
					t.Errorf("serve after context cancellation: %v", serveErr)
				}
			case <-time.After(3 * time.Second):
				t.Error("server did not shut down after context cancellation")
			}
		})
	}
	t.Cleanup(stopServer)

	baseURL := "http://" + listener.Addr().String()
	httpClient := &http.Client{Timeout: 3 * time.Second}
	assertCompiledFleetRoutes(t, httpClient, baseURL)
	assertFixtureHealth(t, httpClient, baseURL)

	client := v1connect.NewPaprikaServiceClient(httpClient, baseURL)
	assertRealFleetQueries(t, client)
	policies, err := client.ListPolicies(t.Context(), connect.NewRequest(&paprikav1.ListPoliciesRequest{}))
	if err != nil {
		t.Fatalf("ListPolicies: %v", err)
	}
	if len(policies.Msg.GetPolicies()) != 0 {
		t.Fatalf("ListPolicies returned %d policies, want 0", len(policies.Msg.GetPolicies()))
	}
	assertEventsDisabled(t, httpClient, baseURL)
	stopServer()
}

func assertCompiledFleetRoutes(t *testing.T, httpClient *http.Client, baseURL string) {
	t.Helper()

	for _, route := range []string{"/dashboard/applications", "/dashboard/applications/"} {
		status, body := getHTTP(t, httpClient, baseURL+route)
		if status != http.StatusOK || string(body) != "compiled-fleet-console" {
			t.Fatalf("GET %s = (%d, %q), want (200, compiled-fleet-console)", route, status, body)
		}
	}
}

func assertFixtureHealth(t *testing.T, httpClient *http.Client, baseURL string) {
	t.Helper()

	for _, check := range []struct {
		route string
		body  string
	}{{route: "/healthz", body: "ok\n"}, {route: "/readyz", body: "ready\n"}} {
		status, body := getHTTP(t, httpClient, baseURL+check.route)
		if status != http.StatusOK || string(body) != check.body {
			t.Fatalf("GET %s = (%d, %q), want (200, %q)", check.route, status, body, check.body)
		}
	}
}

func assertRealFleetQueries(t *testing.T, client v1connect.PaprikaServiceClient) {
	t.Helper()

	all := queryAllApplications(t, client)
	first := all.GetApplications()[0]
	if first.GetIdentity().GetName() == "" || first.GetProject().GetName() == "" {
		t.Fatalf("projected application lacks identity or project: %+v", first)
	}
	assertFleetSearch(t, client, all.GetTotal())
	assertFleetProjectFilter(t, client, first, all.GetTotal())
}

func queryAllApplications(t *testing.T, client v1connect.PaprikaServiceClient) *paprikav1.QueryApplicationsResponse {
	t.Helper()

	all, err := client.QueryApplications(t.Context(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
		PageSize: 100,
	}))
	if err != nil {
		t.Fatalf("QueryApplications: %v", err)
	}
	if all.Msg.GetTotal() != 24 || len(all.Msg.GetApplications()) != 24 {
		t.Fatalf("unfiltered response = total %d, records %d; want 24, 24", all.Msg.GetTotal(), len(all.Msg.GetApplications()))
	}
	if all.Msg.GetIndexGeneration() == 0 {
		t.Fatal("real projected query returned zero index generation")
	}
	return all.Msg
}

func assertFleetSearch(t *testing.T, client v1connect.PaprikaServiceClient, allTotal uint64) {
	t.Helper()

	const searchIdentity = "checkout-service"
	searched, err := client.QueryApplications(t.Context(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
		Search:   searchIdentity,
		PageSize: 100,
	}))
	if err != nil {
		t.Fatalf("search QueryApplications: %v", err)
	}
	if searched.Msg.GetTotal() == 0 || searched.Msg.GetTotal() >= allTotal {
		t.Fatalf("search total = %d, want > 0 and < %d", searched.Msg.GetTotal(), allTotal)
	}
	if got := searched.Msg.GetApplications()[0].GetIdentity().GetName(); got != searchIdentity {
		t.Fatalf("highest-ranked search identity = %q, want %q", got, searchIdentity)
	}
	foundSearchedIdentity := false
	for _, application := range searched.Msg.GetApplications() {
		if application.GetIdentity().GetNamespace() == "" || application.GetIdentity().GetName() == "" {
			t.Fatalf("search returned invalid identity: %+v", application.GetIdentity())
		}
		if application.GetIdentity().GetName() == searchIdentity {
			foundSearchedIdentity = true
		}
	}
	if !foundSearchedIdentity {
		t.Fatalf("search did not return exact projected identity %q", searchIdentity)
	}
}

func assertFleetProjectFilter(
	t *testing.T,
	client v1connect.PaprikaServiceClient,
	first *paprikav1.ApplicationSummary,
	allTotal uint64,
) {
	t.Helper()

	filtered, err := client.QueryApplications(t.Context(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
		Filter: &paprikav1.FleetFilter{Projects: []*paprikav1.FleetObjectKey{{
			Namespace: first.GetProject().GetNamespace(),
			Name:      first.GetProject().GetName(),
		}}},
		PageSize: 100,
	}))
	if err != nil {
		t.Fatalf("filtered QueryApplications: %v", err)
	}
	if filtered.Msg.GetTotal() == 0 || filtered.Msg.GetTotal() >= allTotal {
		t.Fatalf("project filter total = %d, want > 0 and < %d", filtered.Msg.GetTotal(), allTotal)
	}
	for _, application := range filtered.Msg.GetApplications() {
		if application.GetProject().GetNamespace() != first.GetProject().GetNamespace() ||
			application.GetProject().GetName() != first.GetProject().GetName() {
			t.Fatalf("project filter returned %+v", application.GetProject())
		}
	}
}

func assertEventsDisabled(t *testing.T, httpClient *http.Client, baseURL string) {
	t.Helper()

	status, _ := getHTTP(t, httpClient, baseURL+"/events")
	if status != http.StatusNotFound {
		t.Fatalf("GET /events status = %d, want 404", status)
	}
}

func getHTTP(t *testing.T, httpClient *http.Client, url string) (int, []byte) {
	t.Helper()

	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build GET %s: %v", url, err)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil {
		t.Fatalf("read GET %s: %v", url, readErr)
	}
	if closeErr != nil {
		t.Fatalf("close GET %s: %v", url, closeErr)
	}
	return response.StatusCode, body
}

func TestHTTPServerHasProductionSafeTimeouts(t *testing.T) {
	t.Parallel()

	server := newHTTPServer(http.NotFoundHandler())
	if server.ReadHeaderTimeout <= 0 || server.ReadTimeout <= 0 || server.WriteTimeout <= 0 || server.IdleTimeout <= 0 {
		t.Fatalf("server timeouts must all be positive: %+v", server)
	}
}

func writeAsset(t *testing.T, root, name, contents string) {
	t.Helper()

	fullPath := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o750); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(fullPath), err)
	}
	if err := os.WriteFile(fullPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write %s: %v", fullPath, err)
	}
}
