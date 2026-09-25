package apiserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"gopkg.in/yaml.v3"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// Phase 0 of the console redesign lands the wire contract ahead of every
// collector behind it. These handlers therefore answer honestly rather than
// plausibly: each state-carrying field reports DATA_STATE_NOT_CONFIGURED, every
// numeric beside it stays zero, and no mutation reports success it did not
// perform. See docs/superpowers/specs/console-redesign/01-backend-design.md §4.

// detailDataSource pairs a DataClass with the canonical sentence the console
// shows while nothing is collecting for that class. The sentences live in
// console_stub.go, not here, because the RPC that serves each class reports the
// same string in its own unavailable_reason — GetDataSources is the probe that
// decides whether a board is drawn at all, so it must not describe an absence
// differently from the board it gates.
type detailDataSource struct {
	class  paprikav1.DataClass
	reason string
}

// detailDataSources is the fixed table GetDataSources answers from: exactly one
// entry per DataClass member, in enum order, always. This mirrors the fixed
// seven-health / four-sync bucket convention in system_status_handler.go, which
// likewise emits the UNSPECIFIED member so the response length is an invariant
// the console and its tests can rely on.
var detailDataSources = [...]detailDataSource{
	{paprikav1.DataClass_DATA_CLASS_UNSPECIFIED, dataClassUnspecifiedReason},
	{paprikav1.DataClass_DATA_CLASS_CLUSTER_INVENTORY, clusterInventoryUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY, clusterCapacityUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_APPLICATION_SIGNALS, applicationSignalsUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_COST, costUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_SOURCE_EVENTS, sourceEventsUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_ROLLOUT_HISTORY, rolloutHistoryUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_PIPELINE_RUNS, pipelineRunsUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_COMMIT_METADATA, commitMetadataUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_OWNERSHIP, ownershipUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_DRIFT_DETAIL, driftDetailUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_LIFECYCLE, lifecycleUnavailableReason},
}

// detailLifecyclePhases is the fixed six-phase vector every lifecycle response
// carries, in LifecyclePhase order 1..6. The vector is positional on the wire,
// so it is declared once here rather than rebuilt per call site.
var detailLifecyclePhases = [...]paprikav1.LifecyclePhase{
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_SOURCE,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_BUILD,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_TEST,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_RENDER,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_DEPLOY,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_VERIFY,
}

// GetDataSources reports one status per DataClass so the console can decide at
// boot which boards exist at all, instead of probing every RPC and inferring
// capability from empty results.
func (s *PaprikaServer) GetDataSources(
	ctx context.Context,
	req *connect.Request[paprikav1.GetDataSourcesRequest],
) (*connect.Response[paprikav1.GetDataSourcesResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	// The probe is authorized like any other tenant-scoped read: which sources an
	// install has configured is itself information a caller must be allowed to see.
	generation, err := s.authorizeOptionalNamespaceScope(ctx, req.Msg.Namespace)
	if err != nil {
		return nil, err
	}

	response := &paprikav1.GetDataSourcesResponse{
		Sources:         make([]*paprikav1.DataSourceStatus, 0, len(detailDataSources)),
		IndexGeneration: generation,
	}
	for _, source := range detailDataSources {
		if source.class == paprikav1.DataClass_DATA_CLASS_OWNERSHIP {
			response.Sources = append(response.Sources, s.operationsDataSource(ctx, req.Msg.Namespace))
			continue
		}
		// Capacity is the one class with a collector behind it, so it reports
		// what a real read produced rather than the stub's fixed answer. For
		// every other class, provider, observation time, staleness budget and
		// retention stay zero: nothing is collecting, so each would be a claim.
		if source.class == paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY {
			response.Sources = append(response.Sources, s.capacityDataSourceStatus(ctx, req.Msg.Namespace, source.reason))
			continue
		}
		response.Sources = append(response.Sources, &paprikav1.DataSourceStatus{
			DataClass:         source.class,
			State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			UnavailableReason: source.reason,
		})
	}
	return connect.NewResponse(response), nil
}

// GetRevisionInfo answers with an explicitly unconfigured commit rather than a
// fabricated or partially guessed one. No revision collector exists yet, so
// every identity field stays empty and run_number stays zero.
func (s *PaprikaServer) GetRevisionInfo(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRevisionInfoRequest],
) (*connect.Response[paprikav1.GetRevisionInfoResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Application, "application"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetRevisionInfoResponse{
		Commit:         &paprikav1.CommitInfo{State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED},
		RunNumberState: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
	}), nil
}

// GetApplicationOwnership reads the application's authorized operational links.
func (s *PaprikaServer) GetApplicationOwnership(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationOwnershipRequest],
) (*connect.Response[paprikav1.GetApplicationOwnershipResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	ownership, err := s.applicationOperations(ctx, req.Msg.Namespace, req.Msg.Name)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetApplicationOwnershipResponse{Ownership: ownership}), nil
}

// ListDriftDetails returns an empty page rather than an error: an unconfigured
// data class is a normal state the console renders, not a failure. The zero
// counts are safe to read only alongside state, which is why state leads the
// message.
func (s *PaprikaServer) ListDriftDetails(
	ctx context.Context,
	req *connect.Request[paprikav1.ListDriftDetailsRequest],
) (*connect.Response[paprikav1.ListDriftDetailsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	// Enforce the page bound from day one so the console learns the real limit
	// against the stub instead of discovering it when collection lands.
	if req.Msg.PageSize > maxFleetPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Application, "application"); err != nil {
		return nil, err
	}
	// An empty next_cursor is the completeness marker for "no further pages", and
	// evaluated_at stays zero because no evaluation happened.
	return connect.NewResponse(&paprikav1.ListDriftDetailsResponse{
		State:     paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Resources: []*paprikav1.ResourceDriftDetail{},
	}), nil
}

// GetApplicationLifecycle returns the full six-phase vector with every phase
// UNKNOWN. UNKNOWN, not NOT_APPLICABLE: the control plane does not yet know
// which stages an application has, and claiming a stage is absent would be as
// wrong as claiming it failed.
func (s *PaprikaServer) GetApplicationLifecycle(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationLifecycleRequest],
) (*connect.Response[paprikav1.GetApplicationLifecycleResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetApplicationLifecycleResponse{
		Lifecycle: detailUnknownLifecycle(req.Msg.Namespace, req.Msg.Name),
	}), nil
}

// GetRolloutHold reports the absence of a hold. That is literally true while
// holds are unimplemented, and the console still gates the Hold and Resume
// affordances on FLEET_CAPABILITY_ROLLOUT_HOLD rather than on this response.
func (s *PaprikaServer) GetRolloutHold(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRolloutHoldRequest],
) (*connect.Response[paprikav1.GetRolloutHoldResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetRolloutHoldResponse{
		Hold: &paprikav1.RolloutHold{},
	}), nil
}

// HoldRollout refuses instead of reporting a hold it did not place.
func (s *PaprikaServer) HoldRollout(
	_ context.Context,
	_ *connect.Request[paprikav1.HoldRolloutRequest],
) (*connect.Response[paprikav1.HoldRolloutResponse], error) {
	return nil, detailNotImplemented("HoldRollout")
}

// ResumeRollout refuses instead of reporting a resume it did not perform.
func (s *PaprikaServer) ResumeRollout(
	_ context.Context,
	_ *connect.Request[paprikav1.ResumeRolloutRequest],
) (*connect.Response[paprikav1.ResumeRolloutResponse], error) {
	return nil, detailNotImplemented("ResumeRollout")
}

// IgnoreDriftedField adds or removes scoped ignoreDifferences rules on the
// Application (Argo CD's ignore-differences management). Rules match on
// group/kind/name/resource_namespace and carry the operator's reason and
// identity for audit.
func (s *PaprikaServer) IgnoreDriftedField(
	ctx context.Context,
	req *connect.Request[paprikav1.IgnoreDriftedFieldRequest],
) (*connect.Response[paprikav1.IgnoreDriftedFieldResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	if len(req.Msg.JsonPointers) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("json_pointers must not be empty"))
	}

	app.Spec.IgnoreDifferences = mergeIgnoreDiffRule(app.Spec.IgnoreDifferences, &ignoreDiffRuleInput{
		group:        req.Msg.Group,
		kind:         req.Msg.Kind,
		name:         req.Msg.ResourceName,
		namespace:    req.Msg.ResourceNamespace,
		jsonPointers: req.Msg.JsonPointers,
		reason:       req.Msg.Reason,
		remove:       req.Msg.Remove,
		createdBy:    principalSubject(ctx),
		createdAt:    metav1.NewTime(s.now()),
	})
	if err := s.client.Update(ctx, &app); err != nil {
		return nil, fmt.Errorf("updating ignoreDifferences: %w", err)
	}

	return connect.NewResponse(&paprikav1.IgnoreDriftedFieldResponse{
		Rules: ignoreDiffRulesToProto(app.Spec.IgnoreDifferences),
	}), nil
}

type ignoreDiffRuleInput struct {
	group, kind, name, namespace string
	jsonPointers                 []string
	reason, createdBy            string
	createdAt                    metav1.Time
	remove                       bool
}

// mergeIgnoreDiffRule merges the rule into the existing ignoreDifferences set:
// same scope merges pointer lists (deduped); remove=true deletes the listed
// pointers (or the whole rule when none remain).
func mergeIgnoreDiffRule(rules []pipelinesv1alpha1.IgnoreDiff, in *ignoreDiffRuleInput) []pipelinesv1alpha1.IgnoreDiff {
	out := make([]pipelinesv1alpha1.IgnoreDiff, 0, len(rules)+1)
	merged := false
	for i := range rules {
		r := rules[i]
		if r.Group == in.group && r.Kind == in.kind && r.Name == in.name && r.Namespace == in.namespace {
			merged = true
			if in.remove {
				r.JSONPointers = removeStrings(r.JSONPointers, in.jsonPointers)
			} else {
				r.JSONPointers = appendUnique(r.JSONPointers, in.jsonPointers...)
				r.Reason = in.reason
				r.CreatedBy = in.createdBy
				r.CreatedAt = &in.createdAt
			}
		}
		if len(r.JSONPointers) > 0 {
			out = append(out, r)
		}
	}
	if !merged && !in.remove {
		out = append(out, pipelinesv1alpha1.IgnoreDiff{
			Group: in.group, Kind: in.kind, Name: in.name, Namespace: in.namespace,
			JSONPointers: in.jsonPointers, Reason: in.reason, CreatedBy: in.createdBy, CreatedAt: &in.createdAt,
		})
	}
	return out
}

func appendUnique(dst []string, vals ...string) []string {
	seen := map[string]bool{}
	for _, v := range dst {
		seen[v] = true
	}
	for _, v := range vals {
		if !seen[v] {
			dst = append(dst, v)
			seen[v] = true
		}
	}
	return dst
}

func removeStrings(dst, vals []string) []string {
	drop := map[string]bool{}
	for _, v := range vals {
		drop[v] = true
	}
	out := dst[:0]
	for _, v := range dst {
		if !drop[v] {
			out = append(out, v)
		}
	}
	return out
}

func principalSubject(ctx context.Context) string {
	if p := auth.PrincipalFromContext(ctx); p != nil {
		return p.Subject
	}
	return ""
}

func ignoreDiffRulesToProto(rules []pipelinesv1alpha1.IgnoreDiff) []*paprikav1.IgnoredFieldRule {
	out := make([]*paprikav1.IgnoredFieldRule, 0, len(rules))
	for i := range rules {
		r := rules[i]
		rule := &paprikav1.IgnoredFieldRule{
			Group: r.Group, Kind: r.Kind, Name: r.Name, Namespace: r.Namespace,
			JsonPointers: r.JSONPointers, Reason: r.Reason, CreatedBy: r.CreatedBy,
		}
		if r.CreatedAt != nil {
			rule.CreatedAtUnixMs = r.CreatedAt.UnixMilli()
		}
		out = append(out, rule)
	}
	return out
}

// ApplyResourcePatch patches a single live resource owned by an application —
// the curated equivalent of `kubectl patch` (and the basis for Argo-style
// resource actions like restart). Every call first runs the patch server-side
// with DryRun:All so admission webhooks see it; the real patch only runs when
// confirm=true. The response always carries the would-be/current manifest and
// a unified diff so callers can review before confirming.
func (s *PaprikaServer) ApplyResourcePatch(
	ctx context.Context,
	req *connect.Request[paprikav1.ApplyResourcePatchRequest],
) (*connect.Response[paprikav1.ApplyResourcePatchResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	ri, patchType, err := s.resolvePatchTarget(req.Msg)
	if err != nil {
		return nil, err
	}

	live, err := getManagedLiveObject(ctx, ri, req.Msg)
	if err != nil {
		return nil, err
	}

	// Dry-run first: the response previews exactly what the real patch would
	// produce, admission checks included.
	dryRun, err := ri.Patch(ctx, req.Msg.ResourceName, patchType, []byte(req.Msg.Patch),
		metav1.PatchOptions{DryRun: []string{metav1.DryRunAll}})
	if err != nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("patch rejected: %w", err))
	}
	resp, err := patchPreviewResponse(live, dryRun)
	if err != nil {
		return nil, err
	}
	if !req.Msg.Confirm {
		return connect.NewResponse(resp), nil
	}

	patched, err := ri.Patch(ctx, req.Msg.ResourceName, patchType, []byte(req.Msg.Patch), metav1.PatchOptions{})
	if err != nil {
		return nil, fmt.Errorf("apply patch to %s/%s: %w", req.Msg.Kind, req.Msg.ResourceName, err)
	}
	final, err := patchPreviewResponse(live, patched)
	if err != nil {
		return nil, err
	}
	final.Applied = true
	final.DryRun = false
	final.AppliedAtUnixMs = s.now().UnixMilli()
	return connect.NewResponse(final), nil
}

// getManagedLiveObject fetches the target resource and refuses when it is
// not managed by the named application — the guard that scopes patches to
// app-owned resources.
func getManagedLiveObject(ctx context.Context, ri dynamic.ResourceInterface, req *paprikav1.ApplyResourcePatchRequest) (*unstructured.Unstructured, error) {
	live, err := ri.Get(ctx, req.ResourceName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get %s/%s: %w", req.Kind, req.ResourceName, err)
	}
	if !isAppManagedResource(live, req.Name) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"%s/%s is not managed by application %s — refusing to patch unmanaged resources",
			req.Kind, req.ResourceName, req.Name))
	}
	return live, nil
}

// resolvePatchTarget validates the request and resolves the live resource
// interface for it.
func (s *PaprikaServer) resolvePatchTarget(req *paprikav1.ApplyResourcePatchRequest) (dynamic.ResourceInterface, types.PatchType, error) {
	if s.dynamicClient == nil || s.restMapper == nil {
		return nil, "", connect.NewError(connect.CodeUnavailable, errors.New("live resource access unavailable"))
	}
	if strings.TrimSpace(req.Patch) == "" {
		return nil, "", connect.NewError(connect.CodeInvalidArgument, errors.New("patch must not be empty"))
	}
	patchType, err := resourcePatchType(req.PatchType)
	if err != nil {
		return nil, "", connect.NewError(connect.CodeInvalidArgument, err)
	}
	mapping, err := s.restMapper.RESTMapping(
		schema.GroupKind{Group: req.Group, Kind: req.Kind}, req.Version)
	if err != nil {
		return nil, "", connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("resolve %s/%s %s: %w", req.Group, req.Version, req.Kind, err))
	}
	if mapping.Scope.Name() == meta.RESTScopeNameRoot {
		return s.dynamicClient.Resource(mapping.Resource), patchType, nil
	}
	ns := req.ResourceNamespace
	if ns == "" {
		ns = req.Namespace
	}
	return s.dynamicClient.Resource(mapping.Resource).Namespace(ns), patchType, nil
}

// patchPreviewResponse builds the diff-bearing response from the live object
// and a patch result (dry-run or applied).
func patchPreviewResponse(live, result *unstructured.Unstructured) (*paprikav1.ApplyResourcePatchResponse, error) {
	liveYAML, err := yaml.Marshal(live.Object)
	if err != nil {
		return nil, fmt.Errorf("marshal live manifest: %w", err)
	}
	resultYAML, err := yaml.Marshal(result.Object)
	if err != nil {
		return nil, fmt.Errorf("marshal result manifest: %w", err)
	}
	return &paprikav1.ApplyResourcePatchResponse{
		DryRun:         true,
		ResultManifest: string(resultYAML),
		Diff:           unifiedDiff(string(liveYAML), string(resultYAML)),
		Warning:        "this change is outside Git and will be reverted on next sync",
	}, nil
}

func resourcePatchType(pt paprikav1.PatchType) (types.PatchType, error) {
	switch pt {
	case paprikav1.PatchType_PATCH_TYPE_JSON_PATCH:
		return types.JSONPatchType, nil
	case paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH:
		return types.MergePatchType, nil
	case paprikav1.PatchType_PATCH_TYPE_STRATEGIC_MERGE:
		return types.StrategicMergePatchType, nil
	case paprikav1.PatchType_PATCH_TYPE_UNSPECIFIED:
		return "", errors.New("patch_type is required (JSON_PATCH, MERGE_PATCH, or STRATEGIC_MERGE)")
	default:
		return "", fmt.Errorf("unknown patch_type %d", int(pt))
	}
}

// isAppManagedResource reports whether the live object carries the app's
// management label — the guard that keeps patches scoped to app resources.
func isAppManagedResource(u *unstructured.Unstructured, appName string) bool {
	return u.GetLabels()["app.paprika.io/name"] == appName &&
		u.GetLabels()["app.paprika.io/managed-by"] == "paprika"
}

// SyncResources requests a partial sync: the app's current release is
// re-applied filtered to the selected resources (Argo CD's selective sync).
// confirm=false previews — it validates selectors against the app's known
// resources and reports what would be synced without touching anything.
func (s *PaprikaServer) SyncResources(
	ctx context.Context,
	req *connect.Request[paprikav1.SyncResourcesRequest],
) (*connect.Response[paprikav1.SyncResourcesResponse], error) {
	var app pipelinesv1alpha1.Application
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
		return nil, fmt.Errorf("getting application: %w", err)
	}
	if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}

	resp := &paprikav1.SyncResourcesResponse{Accepted: true, DryRun: true}
	if len(req.Msg.Resources) == 0 {
		// Empty selector = whole app, identical to SyncApplication.
		n := len(app.Status.Resources)
		if n > math.MaxUint32 {
			n = math.MaxUint32
		}
		resp.SelectedCount = uint32(n)
	} else {
		resp.SelectedCount, resp.Unmatched = matchResourceSelectors(req.Msg.Resources, app.Status.Resources)
		if len(resp.Unmatched) > 0 {
			resp.Accepted = false
			return connect.NewResponse(resp), nil
		}
	}
	if !req.Msg.Confirm {
		return connect.NewResponse(resp), nil
	}
	if app.Status.ReleaseRef == "" {
		resp.Accepted = false
		return connect.NewResponse(resp), nil
	}

	token := strconv.FormatInt(s.now().UnixNano(), 10)
	if err := s.requestSelectiveReleaseResync(ctx, &app, req.Msg.Resources, req.Msg.Prune, req.Msg.Reason, token); err != nil {
		return nil, fmt.Errorf("requesting selective resync: %w", err)
	}
	resp.DryRun = false
	resp.SyncToken = token
	return connect.NewResponse(resp), nil
}

// requestSelectiveReleaseResync stamps the app's active release with the
// resync trigger plus the resource selector payload the release controller
// consumes and clears on a successful filtered apply.
func (s *PaprikaServer) requestSelectiveReleaseResync(
	ctx context.Context, app *pipelinesv1alpha1.Application,
	selectors []*paprikav1.ResourceSelector, prune bool, reason, token string,
) error {
	payload, err := json.Marshal(map[string]any{
		"resources": selectors,
		"prune":     prune,
		"reason":    reason,
	})
	if err != nil {
		return fmt.Errorf("encode selectors: %w", err)
	}
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var release pipelinesv1alpha1.Release
		if getErr := s.client.Get(ctx, client.ObjectKey{
			Namespace: app.Namespace, Name: app.Status.ReleaseRef,
		}, &release); getErr != nil {
			return fmt.Errorf("get release %s: %w", app.Status.ReleaseRef, getErr)
		}
		if release.Annotations == nil {
			release.Annotations = map[string]string{}
		}
		release.Annotations["paprika.io/resync"] = token
		release.Annotations["paprika.io/sync-resources"] = string(payload)
		if updErr := s.client.Update(ctx, &release); updErr != nil {
			return fmt.Errorf("update release: %w", updErr)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("annotate release for selective resync: %w", err)
	}
	return nil
}

// matchResourceSelectors checks each requested selector against the app's
// recorded resources. Returns the match count and the selectors that named
// nothing — an unmatched selector fails the request rather than silently
// narrowing the sync.
func matchResourceSelectors(selectors []*paprikav1.ResourceSelector, resources []pipelinesv1alpha1.ResourceSync) (uint32, []*paprikav1.ResourceSelector) {
	var unmatched []*paprikav1.ResourceSelector
	matched := uint32(0)
	for _, sel := range selectors {
		found := false
		for i := range resources {
			if selectorMatchesResource(sel, &resources[i]) {
				found = true
				break
			}
		}
		if found {
			matched++
		} else {
			unmatched = append(unmatched, sel)
		}
	}
	return matched, unmatched
}

// selectorMatchesResource matches on the fields status.resources records:
// kind, name, and namespace. Selector group/version fields are not verifiable
// here — the apply-time filter re-checks them against the manifest.
func selectorMatchesResource(sel *paprikav1.ResourceSelector, r *pipelinesv1alpha1.ResourceSync) bool {
	return sel.Kind == r.Kind && sel.Name == r.Name &&
		(sel.Namespace == "" || sel.Namespace == r.Namespace)
}

// detailUnknownLifecycle builds the six-entry lifecycle vector with every phase
// UNKNOWN and every timestamp zero. The entry count and order are contractual,
// so callers can index by LifecyclePhase without a lookup.
func detailUnknownLifecycle(namespace, name string) *paprikav1.ApplicationLifecycle {
	phases := make([]*paprikav1.LifecyclePhaseStatus, 0, len(detailLifecyclePhases))
	for _, phase := range detailLifecyclePhases {
		phases = append(phases, &paprikav1.LifecyclePhaseStatus{
			Phase: phase,
			State: paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_UNKNOWN,
		})
	}
	return &paprikav1.ApplicationLifecycle{
		Application: &paprikav1.FleetObjectKey{Namespace: namespace, Name: name},
		Phases:      phases,
	}
}

// detailNotImplemented refuses a mutation this control plane cannot perform yet.
// CodeUnimplemented plus an explicit "no change was made" is the contract: a
// stub must never be mistakable for a completed action.
func detailNotImplemented(rpc string) error {
	return connect.NewError(connect.CodeUnimplemented, fmt.Errorf(
		"%s is not implemented on this control plane; no change was made", rpc,
	))
}
