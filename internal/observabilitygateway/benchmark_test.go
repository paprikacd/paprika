package observabilitygateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// BenchmarkSyntheticGatewayQuery uses only a fake Kubernetes client and a
// loopback httptest Prometheus server. It measures provider lookup, connector
// HTTP/decode, the query tool's preview rendering and final JSON encoding.
// It excludes real Kubernetes/cloud latency, MCP transport/auth/compression,
// and provider query execution. Do not present it as production capacity.
func BenchmarkSyntheticGatewayQuery(b *testing.B) {
	for _, series := range []int{1, 100, 1000} {
		b.Run(fmt.Sprintf("series_%d", series), func(b *testing.B) {
			payload := syntheticPrometheusPayload(series)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/query_range" {
					http.Error(w, "unexpected synthetic query path", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(payload)
			}))
			b.Cleanup(srv.Close)
			scheme := runtime.NewScheme()
			if err := observabilityv1alpha1.AddToScheme(scheme); err != nil {
				b.Fatal(err)
			}
			config, err := json.Marshal(map[string]string{"endpoint": srv.URL})
			if err != nil {
				b.Fatal(err)
			}
			cr := &observabilityv1alpha1.ObservabilityProvider{
				ObjectMeta: metav1.ObjectMeta{Namespace: "synthetic", Name: "prometheus"},
				Spec: observabilityv1alpha1.ObservabilityProviderSpec{
					Type:   connector.ProviderPrometheus,
					Config: runtime.RawExtension{Raw: config},
				},
			}
			backend := NewBackend(fake.NewClientBuilder().WithScheme(scheme).WithObjects(cr).Build())
			registry := mcp.NewRegistry()
			if err := RegisterTools(registry, backend, nil); err != nil {
				b.Fatal(err)
			}
			tool, ok := registry.Lookup("query_metrics")
			if !ok {
				b.Fatal("query_metrics missing")
			}
			// Fixed synthetic timestamps and bounded windows keep input stable
			// without inspecting any real telemetry or environment credentials.
			args := json.RawMessage(`{"provider":"synthetic/prometheus","query":"synthetic_up","start":"2026-01-01T00:00:00Z","end":"2026-01-01T00:05:00Z","limit":1000}`)
			invoke := func() error {
				out, err := tool.Invoke(context.Background(), nil, args)
				if err != nil {
					return err
				}
				encoded, err := json.Marshal(out)
				if err != nil {
					return err
				}
				// Never benchmark successful timing around an error payload.
				var response struct {
					StructuredContent struct {
						State string `json:"state"`
					} `json:"structuredContent"`
				}
				if err := json.Unmarshal(encoded, &response); err != nil {
					return err
				}
				if response.StructuredContent.State != string(connector.StateOK) {
					return fmt.Errorf("synthetic query state %q", response.StructuredContent.State)
				}
				return nil
			}
			if err := invoke(); err != nil {
				b.Fatal(err)
			}
			for _, concurrency := range []int{1, 4} {
				b.Run(fmt.Sprintf("concurrency_%d", concurrency), func(b *testing.B) {
					b.ReportAllocs()
					b.SetBytes(int64(len(payload)))
					if concurrency > 1 {
						benchmarkConcurrentQueries(b, concurrency, invoke)
					} else {
						for b.Loop() {
							if err := invoke(); err != nil {
								b.Fatal(err)
							}
						}
					}
				})
			}
		})
	}
}

// Use an exact worker count independent of GOMAXPROCS: Go's RunParallel
// scales workers with CPU count and could accidentally exceed the gateway's
// in-flight query budget on a large development machine.
func benchmarkConcurrentQueries(b *testing.B, concurrency int, invoke func() error) {
	var next atomic.Int64
	var workers sync.WaitGroup
	for range concurrency {
		workers.Go(func() {
			for next.Add(1) <= int64(b.N) {
				if err := invoke(); err != nil {
					b.Error(err)
					return
				}
			}
		})
	}
	workers.Wait()
}

// BenchmarkSyntheticGatewayOverload measures only the fail-fast admission
// path, with all query slots deliberately occupied. It never calls a cloud
// provider or a Kubernetes API server and is not end-to-end MCP latency.
func BenchmarkSyntheticGatewayOverload(b *testing.B) {
	configured := NewBackend(fake.NewClientBuilder().WithScheme(runtime.NewScheme()).Build())
	backend, ok := configured.(*k8sBackend)
	if !ok {
		b.Fatalf("overload benchmark requires Kubernetes backend, got %T", configured)
	}
	budget := backend.executionBudget()
	for range cap(budget.active) {
		_, finish, err := budget.begin(context.Background())
		if err != nil {
			b.Fatal(err)
		}
		b.Cleanup(finish)
	}
	b.ReportAllocs()
	for b.Loop() {
		_, err := backend.Query(context.Background(), "synthetic/prometheus", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "synthetic_up"})
		if connect.CodeOf(err) != connect.CodeResourceExhausted {
			b.Fatalf("overload must fail before provider I/O; got %v", err)
		}
	}
}

func syntheticPrometheusPayload(series int) []byte {
	var result strings.Builder
	result.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	for i := range series {
		if i > 0 {
			result.WriteByte(',')
		}
		fmt.Fprintf(&result, `{"metric":{"__name__":"synthetic_up","instance":"fixture-%d"},"values":[[%d,"1"],[%d,"1"]]}`, i, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Unix(), time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC).Unix())
	}
	result.WriteString(`]}}`)
	return []byte(result.String())
}
