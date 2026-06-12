package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/client-go/rest"

	agentclient "github.com/benebsworth/paprika/internal/agent/client"
	agentsrv "github.com/benebsworth/paprika/internal/agent/server"
)

func fakeK8sServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api":
			_, _ = fmt.Fprint(w, `{"versions":["v1"]}`)
		case "/api/v1":
			_, _ = fmt.Fprint(w, `{"groupVersion":"v1","resources":[]}`)
		case "/apis":
			_, _ = fmt.Fprint(w, `{"groups":[]}`)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
}

func TestServerHealth(t *testing.T) {
	k8s := fakeK8sServer()
	defer k8s.Close()

	srv, err := agentsrv.NewServer("cluster-1", &rest.Config{Host: k8s.URL})
	require.NoError(t, err)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/healthz", http.NoBody)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	assert.Equal(t, http.StatusOK, rr.Code)
	assert.Equal(t, "ok", rr.Body.String())
}

func TestControllerClient_Health(t *testing.T) {
	k8s := fakeK8sServer()
	defer k8s.Close()

	srv, err := agentsrv.NewServer("cluster-1", &rest.Config{Host: k8s.URL})
	require.NoError(t, err)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	c := agentclient.NewControllerClient(ts.URL)
	require.NoError(t, c.Health(context.Background()))
	assert.True(t, c.Enabled())
}
