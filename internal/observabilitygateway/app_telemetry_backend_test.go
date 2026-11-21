package observabilitygateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestAppTelemetryQueriesPrometheusAndLokiThroughTheGateway(t *testing.T) {
	t.Parallel()
	const labelSelector = `tenant="tenant-one",app="tenant-one-storefront"`
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		params := r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/query":
			if !strings.Contains(params.Get("query"), labelSelector) || params.Get("limit") != "3" {
				t.Error("Prometheus did not receive the bounded app query")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"tenant":"tenant-one","app":"tenant-one-storefront","metric":"requests_24h"},"value":[1,"99"]}]}}`)
		case "/loki/api/v1/query_range":
			if params.Get("query") != "{"+labelSelector+"}" || params.Get("limit") != "50" || params.Get("direction") != "backward" {
				t.Error("Loki did not receive the bounded app query")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			result := map[string]any{
				"status": "success",
				"data": map[string]any{
					"resultType": "streams",
					"result": []map[string]any{{
						"stream": map[string]string{"tenant": "tenant-one", "app": "tenant-one-storefront"},
						"values": [][]string{{params.Get("end"), "scoped test log"}},
					}},
				},
			}
			if err := json.NewEncoder(w).Encode(result); err != nil {
				t.Error(err)
			}
		default:
			t.Errorf("unexpected backend operation: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer source.Close()
	setEndpoint := func(provider *observabilityv1alpha1.ObservabilityProvider) {
		provider.Spec.Config.Raw, _ = json.Marshal(map[string]string{"endpoint": source.URL})
	}
	prometheus := providerCR("obs", "traffic", connector.ProviderPrometheus, setEndpoint)
	loki := providerCR("obs", "runtime", connector.ProviderLoki, setEndpoint)
	client := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(prometheus, loki).Build()
	config, key := telemetryTestConfig(t)
	handler := config.Handler(client, DefaultBudgetConfig())
	for _, tc := range []struct{ signal, expected string }{
		{"metrics", `"requests_24h":99`},
		{"logs", `"line":"scoped test log"`},
	} {
		out := serveAppTelemetry(t, handler, telemetryTestToken(t, telemetryTestGrant(config.audience, tc.signal, time.Now()), key, "key-one"), "")
		require.Equal(t, http.StatusOK, out.Code)
		require.Contains(t, out.Body.String(), tc.expected)
	}
	config.logsProvider = "obs/traffic"
	wrongType := serveAppTelemetry(t, handler, telemetryTestToken(t, telemetryTestGrant(config.audience, "logs", time.Now()), key, "key-one"), "")
	require.JSONEq(t, `{"state":"unavailable"}`, wrongType.Body.String())
}
