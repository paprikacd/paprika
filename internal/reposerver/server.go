// Package reposerver provides a dedicated source resolution and rendering service.
package reposerver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/cache"
)

// Server provides cached source resolution and manifest rendering.
type Server struct {
	renderer    engine.TemplateRenderer
	workDir     string
	cache       cache.Cache
	invalidator *cache.Invalidator
}

// NewServer creates a repo server with the given working directory and cache.
func NewServer(workDir string, c cache.Cache) *Server {
	base := engine.NewHelmSDKRenderer(workDir)
	s := &Server{
		renderer: engine.NewCachedTemplateRenderer(base, c, workDir, 0),
		workDir:  workDir,
		cache:    c,
	}
	if c != nil {
		s.invalidator = cache.NewInvalidator(c)
	}
	return s
}

// ResolveSource resolves a template source.
func (s *Server) ResolveSource(ctx context.Context, req *connect.Request[paprikav1.ResolveSourceRequest]) (*connect.Response[paprikav1.ResolveSourceResponse], error) {
	log.FromContext(ctx).Info("Resolving source", "namespace", req.Msg.Namespace, "name", req.Msg.Name)

	tmpl, err := decodeTemplate(req.Msg.Type, req.Msg.SpecJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode template: %w", err))
	}

	result, err := s.renderer.ResolveSource(ctx, tmpl)
	if err != nil {
		return nil, fmt.Errorf("resolve source: %w", err)
	}
	if result == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("source type %q produced no result", req.Msg.Type))
	}

	return connect.NewResponse(&paprikav1.ResolveSourceResponse{
		LocalPath: result.LocalPath,
		Hash:      result.Hash,
		Revision:  result.Revision,
	}), nil
}

// Render renders a template into manifests.
func (s *Server) Render(ctx context.Context, req *connect.Request[paprikav1.RenderRequest]) (*connect.Response[paprikav1.RenderResponse], error) {
	log.FromContext(ctx).Info("Rendering template", "namespace", req.Msg.Namespace, "name", req.Msg.Name)

	tmpl, err := decodeTemplate(req.Msg.Type, req.Msg.SpecJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode template: %w", err))
	}

	values, err := decodeValues(req.Msg.ValuesJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("decode values: %w", err))
	}

	manifests, err := s.renderer.Render(ctx, tmpl, values)
	if err != nil {
		return nil, fmt.Errorf("render template: %w", err)
	}

	return connect.NewResponse(&paprikav1.RenderResponse{Manifests: manifests}), nil
}

// Handler returns an HTTP handler for the repo server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	_, handler := v1connect.NewPaprikaServiceHandler(s)
	mux.Handle("/paprika.v1.PaprikaService/", handler)
	mux.HandleFunc("/invalidate", s.handleInvalidate)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

type invalidateRequest struct {
	SourceType string `json:"sourceType"`
	SourceURL  string `json:"sourceUrl"`
	Revision   string `json:"revision"`
}

func (s *Server) handleInvalidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.invalidator == nil {
		http.Error(w, "cache invalidation not available", http.StatusServiceUnavailable)
		return
	}
	var req invalidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.invalidator.Invalidate(r.Context(), req.SourceType, req.SourceURL, req.Revision); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// Run starts the repo server on the given address.
func (s *Server) Run(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.FromContext(ctx).Info("Starting repo server", "addr", addr)
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("repo server error: %w", err)
	}
	return nil
}

func (s *Server) ListPipelines(ctx context.Context, req *connect.Request[paprikav1.ListPipelinesRequest]) (*connect.Response[paprikav1.ListPipelinesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement ListPipelines"))
}

func (s *Server) ListReleases(ctx context.Context, req *connect.Request[paprikav1.ListReleasesRequest]) (*connect.Response[paprikav1.ListReleasesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement ListReleases"))
}

func (s *Server) ListStages(ctx context.Context, req *connect.Request[paprikav1.ListStagesRequest]) (*connect.Response[paprikav1.ListStagesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement ListStages"))
}

func (s *Server) ListApplications(ctx context.Context, req *connect.Request[paprikav1.ListApplicationsRequest]) (*connect.Response[paprikav1.ListApplicationsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement ListApplications"))
}

func (s *Server) GetApplication(ctx context.Context, req *connect.Request[paprikav1.GetApplicationRequest]) (*connect.Response[paprikav1.GetApplicationResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement GetApplication"))
}

func (s *Server) SyncApplication(ctx context.Context, req *connect.Request[paprikav1.SyncApplicationRequest]) (*connect.Response[paprikav1.SyncApplicationResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement SyncApplication"))
}

func (s *Server) ApproveGate(ctx context.Context, req *connect.Request[paprikav1.ApproveGateRequest]) (*connect.Response[paprikav1.ApproveGateResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("repo server does not implement ApproveGate"))
}

func decodeTemplate(sourceType string, data []byte) (*paprika.Template, error) {
	if len(data) == 0 {
		return nil, errors.New("empty spec json")
	}
	var spec paprika.TemplateSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("unmarshal spec: %w", err)
	}
	spec.Type = sourceType
	return &paprika.Template{Spec: spec}, nil
}

func decodeValues(data []byte) (map[string]string, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var values map[string]string
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("unmarshal values: %w", err)
	}
	return values, nil
}

var _ v1connect.PaprikaServiceHandler = (*Server)(nil)
