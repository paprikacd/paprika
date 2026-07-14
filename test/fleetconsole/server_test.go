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
	assertRealFleetQueries(t, client, 24)
	assertRealApplicationSetDetail(t, client)
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

func assertRealApplicationSetDetail(
	t *testing.T,
	client v1connect.PaprikaServiceClient,
) {
	t.Helper()

	sets, err := client.ListApplicationSets(
		t.Context(),
		connect.NewRequest(&paprikav1.ListApplicationSetsRequest{}),
	)
	if err != nil {
		t.Fatalf("ListApplicationSets: %v", err)
	}
	if len(sets.Msg.GetApplicationsets()) != fixtureNamespaceCount {
		t.Fatalf("ListApplicationSets returned %d sets, want %d",
			len(sets.Msg.GetApplicationsets()), fixtureNamespaceCount)
	}

	detail, err := client.GetApplicationSet(
		t.Context(),
		connect.NewRequest(&paprikav1.GetApplicationSetRequest{
			Namespace: "team-04",
			Name:      "fixture-applications",
		}),
	)
	if err != nil {
		t.Fatalf("GetApplicationSet: %v", err)
	}
	set := detail.Msg.GetApplicationset()
	if set.GetNamespace() != "team-04" || set.GetName() != "fixture-applications" ||
		set.GetPhase() != "Ready" || set.GetApplications() != 2 {
		t.Fatalf("unexpected ApplicationSet detail: %+v", set)
	}
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

type fixtureFleetQueryClient interface {
	QueryApplications(context.Context, *connect.Request[paprikav1.QueryApplicationsRequest]) (*connect.Response[paprikav1.QueryApplicationsResponse], error)
	QueryFleetMap(context.Context, *connect.Request[paprikav1.QueryFleetMapRequest]) (*connect.Response[paprikav1.QueryFleetMapResponse], error)
	ListPipelines(context.Context, *connect.Request[paprikav1.ListPipelinesRequest]) (*connect.Response[paprikav1.ListPipelinesResponse], error)
}

func assertRealFleetQueries(t *testing.T, client fixtureFleetQueryClient, expectedApplications int) {
	t.Helper()

	all := queryAllApplications(t, client, expectedApplications)
	first := all.GetApplications()[0]
	if first.GetIdentity().GetName() == "" || first.GetProject().GetName() == "" {
		t.Fatalf("projected application lacks identity or project: %+v", first)
	}
	assertFleetSearch(t, client, all.GetTotal())
	assertFleetProjectFilter(t, client, first, all.GetTotal())
	assertCompleteFleetMap(t, client, all.GetApplications())
	assertProjectLabelledPipelines(t, client, expectedApplications)
}

func queryAllApplications(
	t *testing.T,
	client fixtureFleetQueryClient,
	expectedApplications int,
) *paprikav1.QueryApplicationsResponse {
	t.Helper()

	all, err := client.QueryApplications(t.Context(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
		PageSize: 500,
	}))
	if err != nil {
		t.Fatalf("QueryApplications: %v", err)
	}
	expectedTotal := uint64(expectedApplications) // #nosec G115 -- parseConfig bounds fixture counts to 100,000.
	if all.Msg.GetTotal() != expectedTotal || len(all.Msg.GetApplications()) != expectedApplications {
		t.Fatalf("unfiltered response = total %d, records %d; want %d, %d",
			all.Msg.GetTotal(), len(all.Msg.GetApplications()), expectedApplications, expectedApplications)
	}
	if all.Msg.GetIndexGeneration() == 0 {
		t.Fatal("real projected query returned zero index generation")
	}
	return all.Msg
}

//nolint:gocyclo // Keep the complete cross-RPC fixture oracle visible in one assertion helper.
func assertCompleteFleetMap(
	t *testing.T,
	client fixtureFleetQueryClient,
	applications []*paprikav1.ApplicationSummary,
) {
	t.Helper()
	expectedApplications := len(applications)
	expectedTotal := uint64(expectedApplications) // #nosec G115 -- QueryApplications is capped at 500 records.

	response, err := client.QueryFleetMap(t.Context(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
		Group: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_NAMESPACE,
	}))
	if err != nil {
		t.Fatalf("QueryFleetMap: %v", err)
	}
	if response.Msg.GetTotal() != expectedTotal {
		t.Fatalf("QueryFleetMap total = %d, want %d", response.Msg.GetTotal(), expectedApplications)
	}
	if len(response.Msg.GetRoots()) != fixtureNamespaceCount {
		t.Fatalf("namespace-grouped QueryFleetMap roots = %d, want %d", len(response.Msg.GetRoots()), fixtureNamespaceCount)
	}
	repeated, err := client.QueryFleetMap(t.Context(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
		Group: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_NAMESPACE,
	}))
	if err != nil {
		t.Fatalf("repeat QueryFleetMap: %v", err)
	}
	if strings.Join(fixtureMapStableOrder(response.Msg.GetRoots()), "\n") !=
		strings.Join(fixtureMapStableOrder(repeated.Msg.GetRoots()), "\n") {
		t.Fatal("QueryFleetMap stable-ID order changed across identical reads")
	}

	leaves := flattenFixtureMapApplications(response.Msg.GetRoots())
	if len(leaves) != expectedApplications {
		t.Fatalf("QueryFleetMap application leaves = %d, want %d", len(leaves), expectedApplications)
	}
	stableIDs := make(map[string]struct{}, expectedApplications+fixtureNamespaceCount)
	for _, node := range flattenFixtureMapNodes(response.Msg.GetRoots()) {
		if node.GetStableId() == "" {
			t.Fatalf("QueryFleetMap returned a %s node without a stable ID", node.GetKind())
		}
		if _, duplicate := stableIDs[node.GetStableId()]; duplicate {
			t.Fatalf("QueryFleetMap returned duplicate stable ID %q", node.GetStableId())
		}
		stableIDs[node.GetStableId()] = struct{}{}
	}
	applicationIDs := make(map[string]struct{}, expectedApplications)
	expectedApplicationIDs := make(map[string]struct{}, expectedApplications)
	for _, application := range applications {
		identity := application.GetIdentity().GetNamespace() + "/" + application.GetIdentity().GetName()
		expectedApplicationIDs[identity] = struct{}{}
	}
	health := make(map[paprikav1.FleetHealth]struct{})
	for _, leaf := range leaves {
		identity := leaf.GetApplication().GetNamespace() + "/" + leaf.GetApplication().GetName()
		if identity == "/" {
			t.Fatalf("QueryFleetMap leaf %q lacks an Application identity", leaf.GetStableId())
		}
		if leaf.GetStableId() != "a:"+identity {
			t.Fatalf("QueryFleetMap Application %q stable ID = %q, want %q", identity,
				leaf.GetStableId(), "a:"+identity)
		}
		if _, duplicate := applicationIDs[identity]; duplicate {
			t.Fatalf("QueryFleetMap returned Application %q more than once", identity)
		}
		applicationIDs[identity] = struct{}{}
		if len(leaf.GetHealth()) != 1 || leaf.GetHealth()[0].GetCount() != 1 {
			t.Fatalf("QueryFleetMap leaf %q health = %+v, want one count-1 bucket", leaf.GetStableId(), leaf.GetHealth())
		}
		health[leaf.GetHealth()[0].GetHealth()] = struct{}{}
	}
	if len(applicationIDs) != len(expectedApplicationIDs) {
		t.Fatalf("QueryFleetMap identities = %d, QueryApplications identities = %d",
			len(applicationIDs), len(expectedApplicationIDs))
	}
	for identity := range expectedApplicationIDs {
		if _, ok := applicationIDs[identity]; !ok {
			t.Errorf("QueryFleetMap omitted projected Application %q", identity)
		}
	}
	for _, expected := range []paprikav1.FleetHealth{
		paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY,
		paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING,
		paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED,
		paprikav1.FleetHealth_FLEET_HEALTH_FAILED,
		paprikav1.FleetHealth_FLEET_HEALTH_UNKNOWN,
		paprikav1.FleetHealth_FLEET_HEALTH_MISSING,
	} {
		if _, ok := health[expected]; !ok {
			t.Errorf("QueryFleetMap is missing health state %s", expected)
		}
	}
}

func flattenFixtureMapApplications(nodes []*paprikav1.FleetMapNode) []*paprikav1.FleetMapNode {
	result := make([]*paprikav1.FleetMapNode, 0, len(nodes))
	for _, node := range nodes {
		if node.GetKind() == paprikav1.FleetMapNodeKind_FLEET_MAP_NODE_KIND_APPLICATION {
			result = append(result, node)
		}
		result = append(result, flattenFixtureMapApplications(node.GetChildren())...)
	}
	return result
}

func flattenFixtureMapNodes(nodes []*paprikav1.FleetMapNode) []*paprikav1.FleetMapNode {
	result := make([]*paprikav1.FleetMapNode, 0, len(nodes))
	for _, node := range nodes {
		result = append(result, node)
		result = append(result, flattenFixtureMapNodes(node.GetChildren())...)
	}
	return result
}

func fixtureMapStableOrder(nodes []*paprikav1.FleetMapNode) []string {
	all := flattenFixtureMapNodes(nodes)
	result := make([]string, 0, len(all))
	for _, node := range all {
		result = append(result, node.GetStableId())
	}
	return result
}

func assertProjectLabelledPipelines(
	t *testing.T,
	client fixtureFleetQueryClient,
	expectedApplications int,
) {
	t.Helper()

	first, err := client.ListPipelines(t.Context(), connect.NewRequest(&paprikav1.ListPipelinesRequest{}))
	if err != nil {
		t.Fatalf("ListPipelines: %v", err)
	}
	second, err := client.ListPipelines(t.Context(), connect.NewRequest(&paprikav1.ListPipelinesRequest{}))
	if err != nil {
		t.Fatalf("repeat ListPipelines: %v", err)
	}
	if len(first.Msg.GetPipelines()) != expectedApplications {
		t.Fatalf("ListPipelines returned %d records, want %d", len(first.Msg.GetPipelines()), expectedApplications)
	}
	if pipelineResponseOrder(first.Msg.GetPipelines()) == nil ||
		strings.Join(pipelineResponseOrder(first.Msg.GetPipelines()), "\n") !=
			strings.Join(pipelineResponseOrder(second.Msg.GetPipelines()), "\n") {
		t.Fatal("ListPipelines order is not deterministic across identical reads")
	}
	for _, pipeline := range first.Msg.GetPipelines() {
		if pipeline.GetProject() == "" {
			t.Fatalf("Pipeline %s/%s omitted app.paprika.io/project", pipeline.GetNamespace(), pipeline.GetName())
		}
	}

	selected := pipelineInMixedProjectNamespace(first.Msg.GetPipelines())
	if selected == nil {
		t.Fatal("fixture has no namespace containing at least two Pipeline projects")
	}
	namespace := selected.GetNamespace()
	project := selected.GetProject()
	if projects := pipelineProjectsInNamespace(first.Msg.GetPipelines(), namespace); len(projects) < 2 {
		t.Fatalf("Pipeline scope oracle chose namespace %q with only projects %v; it cannot prove project filtering", namespace, projects)
	}

	namespaceOnly, err := client.ListPipelines(t.Context(), connect.NewRequest(&paprikav1.ListPipelinesRequest{
		Namespace: &namespace,
	}))
	if err != nil {
		t.Fatalf("namespace-only ListPipelines: %v", err)
	}
	projectOnly, err := client.ListPipelines(t.Context(), connect.NewRequest(&paprikav1.ListPipelinesRequest{
		Project: project,
	}))
	if err != nil {
		t.Fatalf("project-only ListPipelines: %v", err)
	}
	intersection, err := client.ListPipelines(t.Context(), connect.NewRequest(&paprikav1.ListPipelinesRequest{
		Namespace: &namespace,
		Project:   project,
	}))
	if err != nil {
		t.Fatalf("intersection ListPipelines: %v", err)
	}

	assertPipelineResponseMatches(t, namespaceOnly.Msg.GetPipelines(), first.Msg.GetPipelines(), namespace, "")
	assertPipelineResponseMatches(t, projectOnly.Msg.GetPipelines(), first.Msg.GetPipelines(), "", project)
	assertPipelineResponseMatches(t, intersection.Msg.GetPipelines(), first.Msg.GetPipelines(), namespace, project)
	if len(namespaceOnly.Msg.GetPipelines()) >= expectedApplications || len(projectOnly.Msg.GetPipelines()) >= expectedApplications {
		t.Fatalf("single-dimension Pipeline scopes did not narrow all=%d namespace=%d project=%d",
			expectedApplications, len(namespaceOnly.Msg.GetPipelines()), len(projectOnly.Msg.GetPipelines()))
	}
	if len(intersection.Msg.GetPipelines()) == 0 ||
		len(intersection.Msg.GetPipelines()) >= len(namespaceOnly.Msg.GetPipelines()) ||
		len(intersection.Msg.GetPipelines()) >= len(projectOnly.Msg.GetPipelines()) {
		t.Fatalf("Pipeline intersection does not prove both dimensions: namespace=%d project=%d intersection=%d",
			len(namespaceOnly.Msg.GetPipelines()), len(projectOnly.Msg.GetPipelines()), len(intersection.Msg.GetPipelines()))
	}
}

func pipelineInMixedProjectNamespace(pipelines []*paprikav1.Pipeline) *paprikav1.Pipeline {
	projectsByNamespace := make(map[string]map[string]struct{})
	for _, pipeline := range pipelines {
		projects := projectsByNamespace[pipeline.GetNamespace()]
		if projects == nil {
			projects = make(map[string]struct{})
			projectsByNamespace[pipeline.GetNamespace()] = projects
		}
		projects[pipeline.GetProject()] = struct{}{}
	}
	for _, pipeline := range pipelines {
		if len(projectsByNamespace[pipeline.GetNamespace()]) >= 2 {
			return pipeline
		}
	}
	return nil
}

func pipelineProjectsInNamespace(pipelines []*paprikav1.Pipeline, namespace string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, pipeline := range pipelines {
		if pipeline.GetNamespace() == namespace {
			result[pipeline.GetProject()] = struct{}{}
		}
	}
	return result
}

func assertPipelineResponseMatches(
	t *testing.T,
	actual, all []*paprikav1.Pipeline,
	namespace, project string,
) {
	t.Helper()
	expected := make(map[string]struct{})
	for _, pipeline := range all {
		if namespace != "" && pipeline.GetNamespace() != namespace {
			continue
		}
		if project != "" && pipeline.GetProject() != project {
			continue
		}
		expected[pipeline.GetNamespace()+"/"+pipeline.GetName()] = struct{}{}
	}
	if len(actual) != len(expected) {
		t.Fatalf("ListPipelines scope namespace=%q project=%q returned %d, want %d", namespace, project, len(actual), len(expected))
	}
	for _, pipeline := range actual {
		identity := pipeline.GetNamespace() + "/" + pipeline.GetName()
		if _, ok := expected[identity]; !ok {
			t.Fatalf("ListPipelines scope namespace=%q project=%q returned unexpected %s", namespace, project, identity)
		}
	}
}

func pipelineResponseOrder(pipelines []*paprikav1.Pipeline) []string {
	result := make([]string, 0, len(pipelines))
	for _, pipeline := range pipelines {
		result = append(result, pipeline.GetNamespace()+"/"+pipeline.GetName()+":"+pipeline.GetProject())
	}
	return result
}

func assertFleetSearch(t *testing.T, client fixtureFleetQueryClient, allTotal uint64) {
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
	client fixtureFleetQueryClient,
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
