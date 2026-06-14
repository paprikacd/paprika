// Package agent provides a lightweight agent that runs inside remote clusters.
// It exposes a small gRPC/HTTP API for the controller manager to apply manifests,
// query resource health, and stream events without requiring direct API server access.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"connectrpc.com/connect"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	managedByLabelKey       = "app.paprika.io/managed-by"
	managedByLabelValue     = "paprika"
	applicationNameLabelKey = "app.paprika.io/name"
)

// Server implements the agent-side PaprikaService handler.
type Server struct {
	clusterID string
	dynClient dynamic.Interface
	mapper    apimeta.RESTMapper
	discovery discovery.DiscoveryInterface
}

// NewServer creates an agent server with the given cluster ID and REST config.
func NewServer(clusterID string, cfg *rest.Config) (*Server, error) {
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating dynamic client: %w", err)
	}
	cli, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating kubernetes client: %w", err)
	}
	gr, err := restmapper.GetAPIGroupResources(cli.Discovery())
	if err != nil {
		return nil, fmt.Errorf("discovering API group resources: %w", err)
	}
	return &Server{
		clusterID: clusterID,
		dynClient: dynClient,
		mapper:    restmapper.NewDiscoveryRESTMapper(gr),
		discovery: cli.Discovery(),
	}, nil
}

// ApplyRequest describes a set of manifests to apply.
type ApplyRequest struct {
	Namespace string `json:"namespace"`
	AppName   string `json:"appName"`
	Manifests []byte `json:"manifests"`
}

// ApplyResponse describes the result of an apply.
type ApplyResponse struct {
	Applied int      `json:"applied"`
	Errors  []string `json:"errors,omitempty"`
}

// Apply applies a set of manifests to the local cluster.
func (s *Server) Apply(ctx context.Context, req *ApplyRequest) (*ApplyResponse, error) {
	log.FromContext(ctx).Info("Applying manifests", "cluster", s.clusterID, "namespace", req.Namespace, "app", req.AppName)

	docs := splitYAMLDocuments(req.Manifests)
	resp := &ApplyResponse{}
	for _, doc := range docs {
		if err := s.applyDocument(ctx, doc, req.Namespace, req.AppName); err != nil {
			resp.Errors = append(resp.Errors, err.Error())
			continue
		}
		resp.Applied++
	}
	return resp, nil
}

func (s *Server) applyDocument(ctx context.Context, doc []byte, namespace, appName string) error {
	var obj map[string]interface{}
	if err := yaml.Unmarshal(doc, &obj); err != nil {
		return fmt.Errorf("unmarshal manifest: %w", err)
	}
	if obj == nil {
		return nil
	}

	u := &unstructured.Unstructured{Object: obj}
	gvk := u.GroupVersionKind()
	if gvk.Kind == "" {
		return errors.New("manifest missing kind")
	}

	s.setLabels(u, appName)
	targetNS := s.targetNamespace(u, namespace)

	mapping, err := s.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return fmt.Errorf("mapping %s: %w", gvk, err)
	}

	name := u.GetName()
	if name == "" {
		return errors.New("manifest missing metadata.name")
	}

	var ri dynamic.ResourceInterface
	if mapping.Scope.Name() == apimeta.RESTScopeNameNamespace {
		if targetNS == "" {
			return errors.New("namespace required for namespaced resource")
		}
		ri = s.dynClient.Resource(mapping.Resource).Namespace(targetNS)
	} else {
		ri = s.dynClient.Resource(mapping.Resource)
	}

	if _, err := ri.Apply(ctx, name, u, metav1.ApplyOptions{FieldManager: "paprika", Force: true}); err != nil {
		return fmt.Errorf("apply %s %s: %w", gvk.Kind, name, err)
	}
	return nil
}

func (s *Server) setLabels(u *unstructured.Unstructured, appName string) {
	labels := u.GetLabels()
	if labels == nil {
		labels = make(map[string]string)
	}
	labels[managedByLabelKey] = managedByLabelValue
	if appName != "" {
		labels[applicationNameLabelKey] = appName
	}
	u.SetLabels(labels)
}

func (s *Server) targetNamespace(u *unstructured.Unstructured, fallback string) string {
	if ns := u.GetNamespace(); ns != "" {
		return ns
	}
	return fallback
}

// HealthResponse reports cluster health.
type HealthResponse struct {
	Healthy bool `json:"healthy"`
}

// Health returns the agent health status.
func (s *Server) Health(ctx context.Context) (*HealthResponse, error) {
	if _, err := s.discovery.ServerVersion(); err != nil {
		return &HealthResponse{Healthy: false}, nil
	}
	return &HealthResponse{Healthy: true}, nil
}

// Handler returns the HTTP handler for the agent.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	_, handler := v1connect.NewPaprikaServiceHandler(s)
	mux.Handle("/paprika.v1.PaprikaService/", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/apply", s.handleApply)
	return mux
}

func (s *Server) handleApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ApplyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}

	resp, err := s.Apply(r.Context(), &req)
	if err != nil {
		http.Error(w, fmt.Sprintf("apply failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// Run starts the agent server on the given address.
func (s *Server) Run(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.FromContext(ctx).Info("Starting agent server", "addr", addr, "cluster", s.clusterID)
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("agent server error: %w", err)
	}
	return nil
}

func splitYAMLDocuments(data []byte) [][]byte {
	var docs [][]byte
	decoder := yaml.NewYAMLOrJSONDecoder(bytes.NewReader(data), 4096)
	for {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			break
		}
		if len(raw) == 0 {
			continue
		}
		docs = append(docs, raw)
	}
	return docs
}

// ListPipelines is not implemented by the agent.
func (s *Server) ListPipelines(ctx context.Context, req *connect.Request[paprikav1.ListPipelinesRequest]) (*connect.Response[paprikav1.ListPipelinesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListPipelines"))
}

// ListReleases is not implemented by the agent.
func (s *Server) ListReleases(ctx context.Context, req *connect.Request[paprikav1.ListReleasesRequest]) (*connect.Response[paprikav1.ListReleasesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListReleases"))
}

// ListStages is not implemented by the agent.
func (s *Server) ListStages(ctx context.Context, req *connect.Request[paprikav1.ListStagesRequest]) (*connect.Response[paprikav1.ListStagesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListStages"))
}

// ListApplications is not implemented by the agent.
func (s *Server) ListApplications(ctx context.Context, req *connect.Request[paprikav1.ListApplicationsRequest]) (*connect.Response[paprikav1.ListApplicationsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListApplications"))
}

// GetApplication is not implemented by the agent.
func (s *Server) GetApplication(ctx context.Context, req *connect.Request[paprikav1.GetApplicationRequest]) (*connect.Response[paprikav1.GetApplicationResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement GetApplication"))
}

// SyncApplication is not implemented by the agent.
func (s *Server) SyncApplication(ctx context.Context, req *connect.Request[paprikav1.SyncApplicationRequest]) (*connect.Response[paprikav1.SyncApplicationResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement SyncApplication"))
}

// ApproveGate is not implemented by the agent.
func (s *Server) ApproveGate(ctx context.Context, req *connect.Request[paprikav1.ApproveGateRequest]) (*connect.Response[paprikav1.ApproveGateResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ApproveGate"))
}

// ResolveSource is not implemented by the agent.
func (s *Server) ResolveSource(ctx context.Context, req *connect.Request[paprikav1.ResolveSourceRequest]) (*connect.Response[paprikav1.ResolveSourceResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ResolveSource"))
}

// Render is not implemented by the agent.
func (s *Server) Render(ctx context.Context, req *connect.Request[paprikav1.RenderRequest]) (*connect.Response[paprikav1.RenderResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement Render"))
}

// ApplyBundle is not implemented by the agent.
func (s *Server) ApplyBundle(ctx context.Context, req *connect.Request[paprikav1.ApplyBundleRequest]) (*connect.Response[paprikav1.ApplyBundleResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ApplyBundle"))
}

var _ v1connect.PaprikaServiceHandler = (*Server)(nil)
