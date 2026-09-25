package analysis

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func promServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/query" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func vectorBody(values ...string) string {
	var b strings.Builder
	b.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i, v := range values {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"metric":{"job":"api"},"value":[1700000000,"` + v + `"]}`)
	}
	b.WriteString(`]}}`)
	return b.String()
}

func TestRunPrometheusCheck(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		body  string
		check pipelinesv1alpha1.AnalysisCheck
		pass  bool
	}{
		{
			name: "success condition met",
			body: vectorBody("0.003"),
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "error_rate",
				SuccessCondition: "result[0].value < 0.01",
			},
			pass: true,
		},
		{
			name: "success condition not met",
			body: vectorBody("0.05"),
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "error_rate",
				SuccessCondition: "result[0].value < 0.01",
			},
			pass: false,
		},
		{
			name: "failure condition fires first",
			body: vectorBody("0.003"),
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "error_rate",
				SuccessCondition: "result[0].value < 0.01",
				FailureCondition: "result[0].value > 0.001",
			},
			pass: false,
		},
		{
			name: "no conditions: non-empty result passes",
			body: vectorBody("0.5"),
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "up",
			},
			pass: true,
		},
		{
			name: "no conditions: empty result fails",
			body: `{"status":"success","data":{"resultType":"vector","result":[]}}`,
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "up",
			},
			pass: false,
		},
		{
			name: "metric label accessible in condition",
			body: `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"code":"500"},"value":[1700000000,"7"]}]}}`,
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "errors",
				FailureCondition: `result.exists(r, r.metric["code"] == "500" && r.value > 5)`,
			},
			pass: false,
		},
		{
			name: "invalid CEL fails closed",
			body: vectorBody("1"),
			check: pipelinesv1alpha1.AnalysisCheck{
				Type: "prometheus", Query: "q",
				SuccessCondition: "this is not cel",
			},
			pass: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := promServer(t, tc.body, http.StatusOK)
			tc.check.Address = srv.URL
			a := NewCELAnalyzer(nil, "default", nil, srv.Client())
			got := a.runPrometheusCheck(context.Background(), &tc.check)
			if got.Passed != tc.pass {
				t.Fatalf("passed=%v want %v (message=%s)", got.Passed, tc.pass, got.Message)
			}
		})
	}
}

func TestRunPrometheusCheckErrors(t *testing.T) {
	t.Parallel()

	t.Run("missing address", func(t *testing.T) {
		a := NewCELAnalyzer(nil, "default", nil, nil)
		got := a.runPrometheusCheck(context.Background(), &pipelinesv1alpha1.AnalysisCheck{
			Type: "prometheus", Query: "up",
		})
		if got.Passed {
			t.Fatal("missing address must fail")
		}
	})

	t.Run("missing query", func(t *testing.T) {
		a := NewCELAnalyzer(nil, "default", nil, nil)
		got := a.runPrometheusCheck(context.Background(), &pipelinesv1alpha1.AnalysisCheck{
			Type: "prometheus", Address: "http://x:9090",
		})
		if got.Passed {
			t.Fatal("missing query must fail")
		}
	})

	t.Run("prometheus error status fails closed", func(t *testing.T) {
		srv := promServer(t, `{"status":"error","error":"parse error"}`, http.StatusOK)
		a := NewCELAnalyzer(nil, "default", nil, srv.Client())
		got := a.runPrometheusCheck(context.Background(), &pipelinesv1alpha1.AnalysisCheck{
			Type: "prometheus", Address: srv.URL, Query: "bad{",
		})
		if got.Passed {
			t.Fatal("prometheus error must fail the check")
		}
	})

	t.Run("matrix result type rejected", func(t *testing.T) {
		srv := promServer(t, `{"status":"success","data":{"resultType":"matrix","result":[]}}`, http.StatusOK)
		a := NewCELAnalyzer(nil, "default", nil, srv.Client())
		got := a.runPrometheusCheck(context.Background(), &pipelinesv1alpha1.AnalysisCheck{
			Type: "prometheus", Address: srv.URL, Query: "range_q",
		})
		if got.Passed {
			t.Fatal("non-vector resultType must fail")
		}
	})

	t.Run("http error fails closed", func(t *testing.T) {
		srv := promServer(t, "boom", http.StatusBadGateway)
		a := NewCELAnalyzer(nil, "default", nil, srv.Client())
		got := a.runPrometheusCheck(context.Background(), &pipelinesv1alpha1.AnalysisCheck{
			Type: "prometheus", Address: srv.URL, Query: "up",
		})
		if got.Passed {
			t.Fatal("HTTP error must fail the check")
		}
	})
}
