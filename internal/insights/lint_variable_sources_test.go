package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// variableSourceDocument declares the given variables on an otherwise empty dashboard.
func variableSourceDocument(variables ...string) Dashboard {
	return json.RawMessage(fmt.Sprintf(`{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":30,"variables":[%s],"widgets":[]}`, joinJSON(variables)))
}

func joinJSON(items []string) string {
	return strings.Join(items, ",")
}

const cluster = `{"name":"cluster","defaultValue":"omega"}`

func TestLintSourceProviderKindNeedsPrometheusForASelector(t *testing.T) {
	selector := `{"name":"service","defaultValue":"api","source":{"type":"labelValues","providerId":"traces","label":"service","selector":"up{cluster={{cluster}}}"}}`
	document := variableSourceDocument(cluster, selector)
	finding := requireOneHit(t, findingsWithProviders(document, map[string]string{"traces": "tempo"}), "variables.source-provider-kind", "/variables/1/source/selector")
	if finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
		t.Fatalf("severity = %v, want warning", finding.GetSeverity())
	}
	requireNoHits(t, findingsWithProviders(document, map[string]string{"traces": "prometheus"}), "variables.source-provider-kind")
	// An unresolved provider is unknown, so the rule stays quiet rather than guessing its type.
	requireNoHits(t, findingsWithProviders(document, nil), "variables.source-provider-kind")
}

func TestLintSourceProviderKindIgnoresASelectorlessSource(t *testing.T) {
	plain := `{"name":"service","defaultValue":"api","source":{"type":"labelValues","providerId":"traces","label":"service"}}`
	requireNoHits(t, findingsWithProviders(variableSourceDocument(cluster, plain), map[string]string{"traces": "tempo"}), "variables.source-provider-kind")
}

func TestLintSourceUndeclaredDependencyPointsAtTheReference(t *testing.T) {
	selector := `{"name":"service","defaultValue":"api","source":{"type":"labelValues","providerId":"m","label":"service","selector":"up{cluster={{ghost}}}"}}`
	requireOneHit(t, lintFor(t, variableSourceDocument(cluster, selector)), "variables.source-undeclared-dependency", "/variables/1/source/selector")
	declared := `{"name":"service","defaultValue":"api","source":{"type":"labelValues","providerId":"m","label":"service","selector":"up{cluster={{cluster}}}"}}`
	requireNoHits(t, lintFor(t, variableSourceDocument(cluster, declared)), "variables.source-undeclared-dependency")
}

func TestLintSourceUndeclaredDependencyCoversSavedQueryBindings(t *testing.T) {
	bound := `{"name":"service","defaultValue":"api","source":{"type":"savedQuery","field":"name","queryRef":{"id":"q","bindings":[{"parameter":"p","source":"variable","variable":"ghost"}]}}}`
	requireOneHit(t, lintFor(t, variableSourceDocument(cluster, bound)), "variables.source-undeclared-dependency", "/variables/1/source/queryRef/bindings/0/variable")
}

func TestLintSourceNoDefaultIsInfo(t *testing.T) {
	noDefault := `{"name":"service","source":{"type":"labelValues","providerId":"m","label":"service"}}`
	finding := requireOneHit(t, lintFor(t, variableSourceDocument(noDefault)), "variables.source-no-default", "/variables/0")
	if finding.GetSeverity() != insightsv1.Severity_SEVERITY_INFO {
		t.Fatalf("severity = %v, want info", finding.GetSeverity())
	}
	requireNoHits(t, lintFor(t, variableSourceDocument(`{"name":"service","defaultValue":"","source":{"type":"labelValues","providerId":"m","label":"service"}}`)), "variables.source-no-default")
	requireNoHits(t, lintFor(t, variableSourceDocument(`{"name":"plain"}`)), "variables.source-no-default")
}

// A save resolves the provider of each label-values source, so the provider-kind rule sees its type.
func TestLintResolvesLabelValuesSourceProviders(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "traces", Name: "Traces", Type: "tempo", URL: "http://127.0.0.1:9"})
	selector := `{"name":"service","defaultValue":"api","source":{"type":"labelValues","providerId":"traces","label":"service","selector":"up{cluster={{cluster}}}"}}`
	document := variableSourceDocument(cluster, selector)
	types := s.providerTypesOf(httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil), document)
	if types["traces"] != "tempo" {
		t.Fatalf("provider types = %v, want traces resolved to tempo", types)
	}
	findings := findingsWithProviders(document, types)
	requireOneHit(t, findings, "variables.source-provider-kind", "/variables/1/source/selector")
}

// A document with no source and no slo-summary widget resolves nothing.
func TestLintResolvesNoProvidersWithoutSources(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "traces", Name: "Traces", Type: "tempo", URL: "http://127.0.0.1:9"})
	types := s.providerTypesOf(httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil), variableSourceDocument(cluster))
	if types != nil {
		t.Fatalf("provider types = %v, want none", types)
	}
}

// Label values come only from Prometheus or Tempo, so a plain source on another provider type is flagged too.
func TestLintSourceProviderKindRefusesOtherProviderTypes(t *testing.T) {
	plain := `{"name":"service","defaultValue":"api","source":{"type":"labelValues","providerId":"logs","label":"service"}}`
	document := variableSourceDocument(cluster, plain)
	requireOneHit(t, findingsWithProviders(document, map[string]string{"logs": "loki"}), "variables.source-provider-kind", "/variables/1/source/providerId")
	requireNoHits(t, findingsWithProviders(document, map[string]string{"logs": "tempo"}), "variables.source-provider-kind")
	requireNoHits(t, findingsWithProviders(document, map[string]string{"logs": "prometheus"}), "variables.source-provider-kind")
	requireNoHits(t, findingsWithProviders(document, nil), "variables.source-provider-kind")
}

// A savedQuery source that reads a traces query is refused by lint, because a traces result has no column or
// label to supply values. A metrics or records query is not refused, and an unresolved query stays quiet.
func TestLintRefusesATracesSavedQueryAsASource(t *testing.T) {
	source := `{"name":"service","defaultValue":"api","source":{"type":"savedQuery","field":"service","queryRef":{"id":"spans"}}}`
	document := variableSourceDocument(cluster, source)
	finding := requireOneHit(t, findingsWithProviders(document, map[string]string{savedQueryKindKey("spans"): "traces"}), "variables.source-query-kind", "/variables/1/source/queryRef")
	if finding.GetSeverity() != insightsv1.Severity_SEVERITY_ERROR {
		t.Fatalf("severity = %v, want error", finding.GetSeverity())
	}
	requireNoHits(t, findingsWithProviders(document, map[string]string{savedQueryKindKey("spans"): "records"}), "variables.source-query-kind")
	requireNoHits(t, findingsWithProviders(document, nil), "variables.source-query-kind")
}

// A save resolves the kind of each saved query a source reads, so the query-kind rule sees it.
func TestLintResolvesSavedQueryKindsForSources(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:9"})
	trace := []byte(`{"schemaVersion":1,"id":"spans","name":"Spans","providerId":"metrics","kind":"traces","query":"{}"}`)
	if _, err := s.savedQueries.put("spans", trace, "", "*"); err != nil {
		t.Fatalf("store traces query: %v", err)
	}
	source := `{"name":"service","defaultValue":"api","source":{"type":"savedQuery","field":"service","queryRef":{"id":"spans"}}}`
	document := variableSourceDocument(cluster, source)
	types := s.providerTypesOf(httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil), document)
	if types[savedQueryKindKey("spans")] != "traces" {
		t.Fatalf("saved query kinds = %v, want spans resolved to traces", types)
	}
	requireOneHit(t, findingsWithProviders(document, types), "variables.source-query-kind", "/variables/1/source/queryRef")
}
