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
	"strings"
	"time"

	"connectrpc.com/connect"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
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

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/engine/hooks"
)

const (
	managedByLabelKey       = "app.paprika.io/managed-by"
	managedByLabelValue     = "paprika"
	applicationNameLabelKey = "app.paprika.io/name"
)

// Hook execution lifecycle states stamped onto ApplyResponse.HookStatuses.
// These mirror the controller's ReleaseReconciler hook status constants.
const (
	hookStatusRunning    = "Running"
	hookStatusSucceeded  = "Succeeded"
	hookStatusFailed     = "Failed"
	hookStatusTerminated = "Terminated"

	defaultHookTimeout     = 5 * time.Minute
	hookDeletePolicyBefore = "BeforeHookCreation"
	hookPollInterval       = 2 * time.Second
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
	// SyncOptions carries apply/hook tuning. When nil the agent uses its
	// defaults (HookTimeoutSeconds defaults to 5 minutes).
	// +optional
	SyncOptions *pipelinesv1alpha1.SyncOptions `json:"syncOptions,omitempty"`
}

// ApplyResponse describes the result of an apply.
type ApplyResponse struct {
	Applied int      `json:"applied"`
	Errors  []string `json:"errors,omitempty"`
	// HookStatuses is populated when the request bundle contains hook
	// resources. Empty when no hooks were present (or when running against
	// an old agent that doesn't populate it — controller falls back to its
	// own classification).
	HookStatuses []pipelinesv1alpha1.HookStatus `json:"hookStatuses,omitempty"`
}

// Apply applies a set of manifests to the local cluster.
func (s *Server) Apply(ctx context.Context, req *ApplyRequest) (*ApplyResponse, error) {
	log.FromContext(ctx).Info("Applying manifests", "cluster", s.clusterID, "namespace", req.Namespace, "app", req.AppName)
	resp := &ApplyResponse{}

	// Hook-aware path: when the bundle may contain hook annotations, run the
	// PreSync → Sync → PostSync phase sequence. The substring check is a
	// cheap fast-path so hook-free bundles keep the original apply loop and
	// behavior unchanged.
	if bytes.Contains(req.Manifests, []byte(pipelinesv1alpha1.HookAnnotation)) {
		if err := s.executeHooks(ctx, resp, req, s.dynClient); err != nil {
			resp.Errors = append(resp.Errors, err.Error())
		}
		return resp, nil
	}

	docs := splitYAMLDocuments(req.Manifests)
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

// executeHooks runs the PreSync → Sync → PostSync hook phase sequence for a
// manifest bundle that contains hook annotations. Because the agent's Apply is
// a single-shot RPC (not a reconcile loop), there is no re-entrancy: each hook
// is applied and then polled synchronously at hookPollInterval until it reaches
// a terminal state or the per-hook timeout elapses. Sync-phase docs are applied
// via the existing applyDocument path between PreSync and PostSync. On any phase
// failure, SyncFail hooks run best-effort before the error is returned.
//
// When the bundle classifies to no hooks (a false-positive substring match),
// every document lands in the Sync bucket and is applied normally — so this
// method is a safe superset of the plain apply path.
func (s *Server) executeHooks(ctx context.Context, resp *ApplyResponse, req *ApplyRequest, dynClient dynamic.Interface) error {
	objs, err := parseManifestObjects(req.Manifests)
	if err != nil {
		return fmt.Errorf("parse hook manifests: %w", err)
	}
	paired, err := hooks.PairWithBytes(objs, req.Manifests)
	if err != nil {
		return fmt.Errorf("pair hook manifests: %w", err)
	}
	bucket, err := hooks.ClassifyPaired(paired)
	if err != nil {
		return fmt.Errorf("classify hook manifests: %w", err)
	}

	timeout := hookTimeout(req)

	if err := s.runHookPhase(ctx, resp, dynClient, bucket.PreSync, hooks.PhasePreSync, req.Namespace, req.AppName, timeout); err != nil {
		s.runSyncFailHooks(ctx, resp, dynClient, bucket, req, timeout)
		return fmt.Errorf("pre-sync hooks: %w", err)
	}

	// Apply the Sync-phase (non-hook) docs via the existing path so labeling
	// and namespace handling stay identical for hook-free and hook bundles.
	for _, r := range bucket.Sync {
		if err := s.applyDocument(ctx, r.Raw, req.Namespace, req.AppName); err != nil {
			s.runSyncFailHooks(ctx, resp, dynClient, bucket, req, timeout)
			return fmt.Errorf("apply sync manifest %s/%s: %w", r.Obj.GetKind(), r.Obj.GetName(), err)
		}
		resp.Applied++
	}

	if err := s.runHookPhase(ctx, resp, dynClient, bucket.PostSync, hooks.PhasePostSync, req.Namespace, req.AppName, timeout); err != nil {
		s.runSyncFailHooks(ctx, resp, dynClient, bucket, req, timeout)
		return fmt.Errorf("post-sync hooks: %w", err)
	}
	return nil
}

// runHookPhase executes a single phase's hooks in YAML declaration order. Each
// hook is deleted (BeforeHookCreation policy), applied via server-side apply,
// and then — when a completion checker is registered and the timeout is
// non-zero — polled until terminal. When no checker is registered or the
// timeout is zero, the hook is treated as fire-and-forget (Succeeded on apply).
// Each transition is stamped onto resp.HookStatuses.
func (s *Server) runHookPhase(
	ctx context.Context,
	resp *ApplyResponse,
	dynClient dynamic.Interface,
	resources []hooks.Resource,
	phase hooks.Phase,
	namespace, appName string,
	timeout time.Duration,
) error {
	for _, res := range resources {
		if err := s.runOneHook(ctx, resp, dynClient, res, phase, namespace, appName, timeout); err != nil {
			return err
		}
	}
	return nil
}

// runOneHook prepares, applies, and (when applicable) awaits a single hook.
func (s *Server) runOneHook(
	ctx context.Context,
	resp *ApplyResponse,
	dynClient dynamic.Interface,
	res hooks.Resource,
	phase hooks.Phase,
	namespace, appName string,
	timeout time.Duration,
) error {
	obj := res.Obj

	// Normalize namespace early so delete + apply target the same object.
	if obj.GetNamespace() == "" && namespace != "" {
		obj.SetNamespace(namespace)
	}

	if err := s.prepareAndApplyHook(ctx, resp, dynClient, obj, res.DeletePolicy, phase, appName); err != nil {
		return err
	}

	checker := hooks.CompletionFor(obj.GroupVersionKind().String())
	if timeout == 0 || checker == nil {
		stampHook(resp, obj, phase, hookStatusSucceeded, "applied (fire-and-forget)")
		log.FromContext(ctx).Info("Hook applied (fire-and-forget)", "kind", obj.GetKind(), "name", obj.GetName(), "phase", phase)
		return nil
	}
	return s.awaitHookCompletion(ctx, resp, dynClient, obj, phase, checker, timeout)
}

// prepareAndApplyHook performs the BeforeHookCreation delete (when the policy
// warrants it) and the server-side apply, stamping Failed on either error.
func (s *Server) prepareAndApplyHook(
	ctx context.Context,
	resp *ApplyResponse,
	dynClient dynamic.Interface,
	obj *unstructured.Unstructured,
	deletePolicy string,
	phase hooks.Phase,
	appName string,
) error {
	if deletePolicy == "" || deletePolicy == hookDeletePolicyBefore {
		if err := s.deleteHook(ctx, dynClient, obj); err != nil {
			stampHook(resp, obj, phase, hookStatusFailed, fmt.Sprintf("before-hook-creation delete: %v", err))
			return fmt.Errorf("before-hook-creation delete %s/%s: %w", obj.GetKind(), obj.GetName(), err)
		}
	}
	s.setLabels(obj, appName)
	if err := s.applyHookObject(ctx, dynClient, obj); err != nil {
		stampHook(resp, obj, phase, hookStatusFailed, fmt.Sprintf("apply: %v", err))
		return fmt.Errorf("apply hook %s/%s: %w", obj.GetKind(), obj.GetName(), err)
	}
	return nil
}

// awaitHookCompletion polls an applied hook until it reaches a terminal state
// or times out, stamping the outcome onto resp.
func (s *Server) awaitHookCompletion(
	ctx context.Context,
	resp *ApplyResponse,
	dynClient dynamic.Interface,
	obj *unstructured.Unstructured,
	phase hooks.Phase,
	checker hooks.CompletionFunc,
	timeout time.Duration,
) error {
	stampHook(resp, obj, phase, hookStatusRunning, "")
	done, succeeded, msg, err := pollHookCompletion(ctx, dynClient, obj, checker, timeout)
	if err != nil {
		stampHook(resp, obj, phase, hookStatusFailed, err.Error())
		return fmt.Errorf("poll hook %s/%s: %w", obj.GetKind(), obj.GetName(), err)
	}
	if !done {
		stampHook(resp, obj, phase, hookStatusTerminated, "hook timed out")
		return fmt.Errorf("hook %s/%s timed out after %s", obj.GetKind(), obj.GetName(), timeout)
	}
	if !succeeded {
		stampHook(resp, obj, phase, hookStatusFailed, msg)
		return fmt.Errorf("hook %s/%s failed: %s", obj.GetKind(), obj.GetName(), msg)
	}
	stampHook(resp, obj, phase, hookStatusSucceeded, msg)
	log.FromContext(ctx).Info("Hook completed", "kind", obj.GetKind(), "name", obj.GetName(), "phase", phase)
	return nil
}

// runSyncFailHooks invokes SyncFail-phase hooks best-effort. Errors are logged
// but never propagated: SyncFail is itself the error-handling phase, so a
// failure here must not mask the original cause.
func (s *Server) runSyncFailHooks(ctx context.Context, resp *ApplyResponse, dynClient dynamic.Interface, bucket *hooks.Bucket, req *ApplyRequest, timeout time.Duration) {
	if len(bucket.SyncFail) == 0 {
		return
	}
	if err := s.runHookPhase(ctx, resp, dynClient, bucket.SyncFail, hooks.PhaseSyncFail, req.Namespace, req.AppName, timeout); err != nil {
		log.FromContext(ctx).Error(err, "SyncFail hooks failed")
	}
}

// pollHookCompletion polls the hook resource at hookPollInterval until the
// checker reports done, the timeout elapses, or the context is cancelled. The
// first check runs immediately (no initial sleep).
func pollHookCompletion(ctx context.Context, dynClient dynamic.Interface, obj *unstructured.Unstructured, checker hooks.CompletionFunc, timeout time.Duration) (done, succeeded bool, msg string, err error) {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(hookPollInterval)
	defer ticker.Stop()
	for {
		d, ok, m, perr := checker(ctx, dynClient, obj.GetNamespace(), obj.GetName())
		if perr != nil {
			return false, false, "", perr
		}
		if d {
			return true, ok, m, nil
		}
		if time.Now().After(deadline) {
			return false, false, "", nil
		}
		select {
		case <-ctx.Done():
			return false, false, "", fmt.Errorf("await hook: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

// applyHookObject applies a hook resource via server-side apply so it is
// tracked for cleanup. The object is expected to already carry paprika labels
// and a resolved namespace.
func (s *Server) applyHookObject(ctx context.Context, dynClient dynamic.Interface, obj *unstructured.Unstructured) error {
	ri, err := s.resourceInterface(dynClient, obj)
	if err != nil {
		return err
	}
	if _, err := ri.Apply(ctx, obj.GetName(), obj, metav1.ApplyOptions{FieldManager: "paprika", Force: true}); err != nil {
		return fmt.Errorf("server-side apply: %w", err)
	}
	return nil
}

// deleteHook best-effort deletes an existing hook resource so the subsequent
// apply creates it fresh. IsNotFound is OK.
func (s *Server) deleteHook(ctx context.Context, dynClient dynamic.Interface, obj *unstructured.Unstructured) error {
	ri, err := s.resourceInterface(dynClient, obj)
	if err != nil {
		return err
	}
	policy := metav1.DeletePropagationBackground
	if err := ri.Delete(ctx, obj.GetName(), metav1.DeleteOptions{PropagationPolicy: &policy}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete: %w", err)
	}
	return nil
}

// resourceInterface resolves a dynamic ResourceInterface for obj using the
// server's RESTMapper. Namespaced resources require a namespace on obj.
func (s *Server) resourceInterface(dynClient dynamic.Interface, u *unstructured.Unstructured) (dynamic.ResourceInterface, error) {
	gvk := u.GroupVersionKind()
	if gvk.Kind == "" {
		return nil, errors.New("manifest missing kind")
	}
	mapping, err := s.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return nil, fmt.Errorf("mapping %s: %w", gvk, err)
	}
	if mapping.Scope.Name() == apimeta.RESTScopeNameNamespace {
		if u.GetNamespace() == "" {
			return nil, errors.New("namespace required for namespaced resource")
		}
		return dynClient.Resource(mapping.Resource).Namespace(u.GetNamespace()), nil
	}
	return dynClient.Resource(mapping.Resource), nil
}

// hookTimeout resolves the per-hook poll timeout from the request's
// SyncOptions, mirroring the controller's hookTimeout semantics: an explicit 0
// means fire-and-forget; absent SyncOptions defaults to defaultHookTimeout.
func hookTimeout(req *ApplyRequest) time.Duration {
	if req.SyncOptions != nil {
		if req.SyncOptions.HookTimeoutSeconds == 0 {
			return 0
		}
		return time.Duration(req.SyncOptions.HookTimeoutSeconds) * time.Second
	}
	return defaultHookTimeout
}

// stampHook upserts a HookStatus for obj+phase on resp. On first sighting the
// entry is appended (with StartedAt); subsequent updates preserve StartedAt.
// CompletedAt is stamped only for terminal statuses.
func stampHook(resp *ApplyResponse, obj *unstructured.Unstructured, phase hooks.Phase, status, msg string) {
	now := metav1.Now()
	for i := range resp.HookStatuses {
		hs := &resp.HookStatuses[i]
		if hs.Kind == obj.GetKind() && hs.Name == obj.GetName() && hs.Namespace == obj.GetNamespace() && hs.Phase == string(phase) {
			hs.Status = status
			hs.Message = msg
			if isTerminalHookStatus(status) {
				hs.CompletedAt = &now
			}
			return
		}
	}
	hs := pipelinesv1alpha1.HookStatus{
		Kind:      obj.GetKind(),
		Name:      obj.GetName(),
		Namespace: obj.GetNamespace(),
		Phase:     string(phase),
		Status:    status,
		StartedAt: &now,
		Message:   msg,
	}
	if isTerminalHookStatus(status) {
		hs.CompletedAt = &now
	}
	resp.HookStatuses = append(resp.HookStatuses, hs)
}

func isTerminalHookStatus(status string) bool {
	return status == hookStatusSucceeded || status == hookStatusFailed || status == hookStatusTerminated
}

// parseManifestObjects parses a manifest bundle into unstructured objects. It
// splits on "\n---\n" (matching hooks.PairWithBytes' internal splitter) so the
// returned objects align one-to-one with PairWithBytes' raw-doc segmentation.
func parseManifestObjects(bundle []byte) ([]*unstructured.Unstructured, error) {
	var out []*unstructured.Unstructured
	for _, doc := range splitSeparatorDocuments(bundle) {
		obj := &unstructured.Unstructured{}
		if err := yaml.Unmarshal(doc, &obj.Object); err != nil {
			return nil, fmt.Errorf("unmarshal manifest: %w", err)
		}
		if obj.Object != nil {
			out = append(out, obj)
		}
	}
	return out, nil
}

// splitSeparatorDocuments splits a manifest bundle on "\n---\n" separators,
// matching engine.SplitYAMLDocuments and hooks.splitDocs so parsed objects
// align with hooks.PairWithBytes.
func splitSeparatorDocuments(raw []byte) [][]byte {
	if len(raw) == 0 {
		return nil
	}
	var out [][]byte
	for _, p := range strings.Split(string(raw), "\n---\n") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, []byte(p))
	}
	return out
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
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("ok")); err != nil {
			log.FromContext(r.Context()).Error(err, "Failed to write healthz response")
		}
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
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.FromContext(r.Context()).Error(err, "Failed to encode apply response")
	}
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
		if err := srv.Close(); err != nil {
			log.FromContext(ctx).Error(err, "Failed to close agent server")
		}
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

// ListPolicies is not implemented by the agent.
func (s *Server) ListPolicies(ctx context.Context, req *connect.Request[paprikav1.ListPoliciesRequest]) (*connect.Response[paprikav1.ListPoliciesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListPolicies"))
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

// ListGateStatus is not implemented by the agent.
func (s *Server) ListGateStatus(ctx context.Context, req *connect.Request[paprikav1.ListGateStatusRequest]) (*connect.Response[paprikav1.ListGateStatusResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListGateStatus"))
}

// RejectGate is not implemented by the agent.
func (s *Server) RejectGate(ctx context.Context, req *connect.Request[paprikav1.RejectGateRequest]) (*connect.Response[paprikav1.RejectGateResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement RejectGate"))
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

// RollbackRelease is not implemented by the agent.
func (s *Server) RollbackRelease(ctx context.Context, req *connect.Request[paprikav1.RollbackReleaseRequest]) (*connect.Response[paprikav1.RollbackReleaseResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement RollbackRelease"))
}

// ListApplicationSets is not implemented by the agent.
func (s *Server) ListApplicationSets(ctx context.Context, req *connect.Request[paprikav1.ListApplicationSetsRequest]) (*connect.Response[paprikav1.ListApplicationSetsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListApplicationSets"))
}

// GetApplicationSet is not implemented by the agent.
func (s *Server) GetApplicationSet(ctx context.Context, req *connect.Request[paprikav1.GetApplicationSetRequest]) (*connect.Response[paprikav1.GetApplicationSetResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement GetApplicationSet"))
}

// ListNotificationConfigs is not implemented by the agent.
func (s *Server) ListNotificationConfigs(ctx context.Context, req *connect.Request[paprikav1.ListNotificationConfigsRequest]) (*connect.Response[paprikav1.ListNotificationConfigsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("agent does not implement ListNotificationConfigs"))
}

var _ v1connect.PaprikaServiceHandler = (*Server)(nil)

func (s *Server) ListRollouts(ctx context.Context, _ *connect.Request[paprikav1.ListRolloutsRequest]) (*connect.Response[paprikav1.ListRolloutsResponse], error) {
	log.FromContext(ctx).Info("ListRollouts not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("listRollouts is not implemented on the agent"))
}

func (s *Server) GetRollout(ctx context.Context, _ *connect.Request[paprikav1.GetRolloutRequest]) (*connect.Response[paprikav1.GetRolloutResponse], error) {
	log.FromContext(ctx).Info("GetRollout not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("getRollout is not implemented on the agent"))
}

func (s *Server) PromoteRollout(ctx context.Context, _ *connect.Request[paprikav1.PromoteRolloutRequest]) (*connect.Response[paprikav1.PromoteRolloutResponse], error) {
	log.FromContext(ctx).Info("PromoteRollout not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("promoteRollout is not implemented on the agent"))
}

func (s *Server) AbortRollout(ctx context.Context, _ *connect.Request[paprikav1.AbortRolloutRequest]) (*connect.Response[paprikav1.AbortRolloutResponse], error) {
	log.FromContext(ctx).Info("AbortRollout not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("abortRollout is not implemented on the agent"))
}

// GetPipeline is not implemented by the agent.
func (s *Server) GetPipeline(ctx context.Context, _ *connect.Request[paprikav1.GetPipelineRequest]) (*connect.Response[paprikav1.GetPipelineResponse], error) {
	log.FromContext(ctx).Info("GetPipeline not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("getPipeline is not implemented on the agent"))
}

// RetryStep is not implemented by the agent.
func (s *Server) RetryStep(ctx context.Context, _ *connect.Request[paprikav1.RetryStepRequest]) (*connect.Response[paprikav1.RetryStepResponse], error) {
	log.FromContext(ctx).Info("RetryStep not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("retryStep is not implemented on the agent"))
}

// SkipStep is not implemented by the agent.
func (s *Server) SkipStep(ctx context.Context, _ *connect.Request[paprikav1.SkipStepRequest]) (*connect.Response[paprikav1.SkipStepResponse], error) {
	log.FromContext(ctx).Info("SkipStep not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("skipStep is not implemented on the agent"))
}

// CancelPipeline is not implemented by the agent.
func (s *Server) CancelPipeline(ctx context.Context, _ *connect.Request[paprikav1.CancelPipelineRequest]) (*connect.Response[paprikav1.CancelPipelineResponse], error) {
	log.FromContext(ctx).Info("CancelPipeline not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("cancelPipeline is not implemented on the agent"))
}

// GetStepLogs is not implemented by the agent.
func (s *Server) GetStepLogs(ctx context.Context, _ *connect.Request[paprikav1.GetStepLogsRequest]) (*connect.Response[paprikav1.GetStepLogsResponse], error) {
	log.FromContext(ctx).Info("GetStepLogs not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("getStepLogs is not implemented on the agent"))
}

// GetArtifact is not implemented by the agent.
func (s *Server) GetArtifact(ctx context.Context, _ *connect.Request[paprikav1.GetArtifactRequest]) (*connect.Response[paprikav1.GetArtifactResponse], error) {
	log.FromContext(ctx).Info("GetArtifact not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("getArtifact is not implemented on the agent"))
}

// ListArtifacts is not implemented by the agent.
func (s *Server) ListArtifacts(ctx context.Context, _ *connect.Request[paprikav1.ListArtifactsRequest]) (*connect.Response[paprikav1.ListArtifactsResponse], error) {
	log.FromContext(ctx).Info("ListArtifacts not implemented on agent")
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("listArtifacts is not implemented on the agent"))
}
