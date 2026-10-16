package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/log"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	defaultHealthReleaseLimit = 5
	maxHealthReleaseLimit     = 20
	maxHealthRollouts         = 5
)

func readGetApplicationHealthTool() Tool {
	return Tool{
		Name:        "get_application_health",
		Title:       "Application health",
		Description: "Read one application's reported health, sync, retry conditions, checks, managed resources, recent releases and linked rollouts. Includes explicit missing, stale, truncated and failed evidence sections. Set include_investigation=true for an additional automated investigation; logs are not fetched by default.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"name":{"type":"string","minLength":1},
				"namespace":{"type":"string","minLength":1},
				"resource_limit":{"type":"integer","minimum":1,"maximum":200,"default":50},
				"release_limit":{"type":"integer","minimum":1,"maximum":20,"default":5},
				"include_investigation":{"type":"boolean","default":false}
			},
			"required":["name","namespace"],
			"additionalProperties":false
		}`),
		Invoke: readGetApplicationHealthInvoke,
	}
}

func readGetApplicationHealthInvoke(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	in, resourceLimit, releaseLimit, err := applicationHealthArguments(args)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	name, namespace := in.string("name"), in.string("namespace")
	// Application authorization is the prerequisite for every secondary read.
	// A denied or absent application must never produce a partial success.
	resp, err := c.GetApplication(ctx, connect.NewRequest(&v1.GetApplicationRequest{Name: name, Namespace: namespace}))
	if err != nil {
		return nil, fmt.Errorf("get_application_health: %w", err)
	}
	if resp == nil || resp.Msg == nil || resp.Msg.Application == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("get_application_health: application status is unavailable"))
	}
	app := resp.Msg.Application
	if app.Name != name || app.Namespace != namespace {
		return nil, connect.NewError(connect.CodeInternal, errors.New("get_application_health: application identity does not match the request"))
	}
	status := applicationHealthStatus(app)
	out := map[string]any{
		"identity": map[string]any{"name": name, "namespace": namespace, "project": app.Project},
		"status":   status,
		"observationNote": "observedAt is the time this read completed, not a controller reconciliation timestamp. " +
			"Reported health can lag; inspect condition/check timestamps and drift state. Missing evidence does not establish health.",
		"conditions":    diagnosticItems(app.Conditions, resourceLimit),
		"healthChecks":  diagnosticHealthChecks(app.HealthChecks, resourceLimit),
		"resources":     diagnosticResources(app, resourceLimit),
		"gates":         diagnosticItems(app.Gates, resourceLimit),
		"analysis":      diagnosticItems(app.AnalysisResults, resourceLimit),
		"investigation": map[string]any{"status": "not_requested", "note": "Use include_investigation=true or investigate for additional evidence. Investigation does not guarantee all live sources were available."},
	}
	releases, section := diagnosticReleases(ctx, c, app, releaseLimit, resourceLimit)
	out["releases"] = section
	out["rollouts"] = diagnosticRollouts(ctx, c, releases, section, resourceLimit)
	out["drift"] = diagnosticDrift(ctx, c, namespace, name, resourceLimit)
	if in.bool("include_investigation") {
		out["investigation"] = diagnosticInvestigation(ctx, c, namespace, name, resourceLimit)
	}
	status["partial"] = diagnosticPartial(out)
	out["observedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	return out, nil
}

func applicationHealthArguments(args json.RawMessage) (in toolArgs, resourceLimit, releaseLimit int, err error) {
	in, err = decodeArgs(args)
	if err != nil {
		return nil, 0, 0, err
	}
	for key := range in {
		switch key {
		case "name", "namespace", "resource_limit", "release_limit", "include_investigation":
		default:
			return nil, 0, 0, fmt.Errorf("get_application_health: unknown argument %q", key)
		}
	}
	if len(validation.IsDNS1123Subdomain(in.string("name"))) != 0 {
		return nil, 0, 0, errors.New("get_application_health: name must be a valid Kubernetes object name")
	}
	if len(validation.IsDNS1123Label(in.string("namespace"))) != 0 {
		return nil, 0, 0, errors.New("get_application_health: namespace must be a valid Kubernetes namespace")
	}
	if value, present := in["include_investigation"]; present {
		if _, ok := value.(bool); !ok {
			return nil, 0, 0, errors.New("get_application_health: include_investigation must be a boolean")
		}
	}
	resourceLimit, err = diagnosticLimit(in, "resource_limit", defaultPageSize, maxPageSize)
	if err != nil {
		return nil, 0, 0, err
	}
	releaseLimit, err = diagnosticLimit(in, "release_limit", defaultHealthReleaseLimit, maxHealthReleaseLimit)
	return in, resourceLimit, releaseLimit, err
}

func diagnosticLimit(in toolArgs, key string, fallback, maximum int) (int, error) {
	value, present := in[key]
	if !present {
		return fallback, nil
	}
	number, ok := value.(float64)
	if !ok || number < 1 || number > float64(maximum) || math.Trunc(number) != number {
		return 0, fmt.Errorf("get_application_health: %s must be an integer between 1 and %d", key, maximum)
	}
	return int(number), nil
}

func applicationHealthStatus(app *v1.Application) map[string]any {
	var retriesExhausted any
	for _, condition := range app.Conditions {
		if condition.GetType() == "ReleaseRetriesExhausted" {
			switch condition.GetStatus() {
			case "True":
				retriesExhausted = true
			case "False":
				retriesExhausted = false
			}
		}
	}
	phase, health := app.Phase, app.Health
	if phase == "" {
		phase = "Unknown"
	}
	if health == "" {
		health = "Unknown"
	}
	return map[string]any{
		"phase": phase, "health": health, "healthSource": "controllerReported",
		"synced": app.Synced, "outOfSync": app.OutOfSync, "prunedResources": app.PrunedResources,
		"currentStage": app.CurrentStage, "releaseRef": app.ReleaseRef,
		"sourceRevision": app.SourceRevision, "revision": app.Revision,
		"retriesExhausted": retriesExhausted,
	}
}

// diagnosticItems serializes each protobuf separately so nested diagnostic
// sections retain the same camelCase wire names as ordinary MCP RPC results.
func diagnosticItems[T proto.Message](items []T, limit int) map[string]any {
	data := make([]json.RawMessage, 0, min(len(items), limit))
	for _, item := range items[:min(len(items), limit)] {
		encoded, err := marshalToolResult(item)
		if err != nil {
			return diagnosticError(err)
		}
		data = append(data, encoded)
	}
	section := map[string]any{"status": "complete", "data": data, "totalCount": len(items), "truncated": len(items) > limit}
	if len(items) > limit {
		section["status"] = "truncated"
	}
	return section
}

func diagnosticResources(app *v1.Application, limit int) map[string]any {
	// Present sync and health independently: the current API lacks apiVersion
	// on both records, so joining by kind/name could collapse different groups.
	syncItems := append([]*v1.ResourceSync(nil), app.Resources...)
	healthItems := append([]*v1.ResourceHealth(nil), app.ResourceHealth...)
	sort.SliceStable(syncItems, func(i, j int) bool {
		return syncItems[i].GetStatus() != "Synced" && syncItems[j].GetStatus() == "Synced"
	})
	sort.SliceStable(healthItems, func(i, j int) bool {
		return healthItems[i].GetHealth() != "Healthy" && healthItems[j].GetHealth() == "Healthy"
	})
	syncSection, healthSection := diagnosticItems(syncItems, limit), diagnosticItems(healthItems, limit)
	section := map[string]any{
		"status": "complete", "sync": syncSection, "health": healthSection,
		"note": "Managed resource status from the Application controller; unhealthy and out-of-sync entries appear first. Empty lists mean no recorded resource evidence.",
	}
	if len(app.Resources) == 0 && len(app.ResourceHealth) == 0 {
		section["status"] = "not_available"
	}
	return section
}

func diagnosticHealthChecks(checks []*v1.HealthCheckResult, limit int) map[string]any {
	bounded := make([]*v1.HealthCheckResult, 0, min(len(checks), limit))
	for _, check := range checks[:min(len(checks), limit)] {
		if check == nil {
			continue
		}
		cloned := proto.Clone(check).(*v1.HealthCheckResult) //nolint:errcheck,forcetypeassert // proto.Clone preserves the concrete type
		cloned.HttpBody = ""
		// The read summary retains SLO coverage and failures without response
		// bodies or timelines. get_application exposes the complete check data.
		cloned.RecentFailures = nil
		if cloned.Slo != nil {
			cloned.Slo.Timeline = nil
		}
		bounded = append(bounded, cloned)
	}
	section := diagnosticItems(bounded, limit)
	section["totalCount"] = len(checks)
	section["truncated"] = len(checks) > limit
	if len(checks) > limit {
		section["status"] = "truncated"
	}
	section["note"] = "HTTP bodies, failure history and SLO timelines are omitted from this summary; get_application exposes full check detail."
	return section
}

func diagnosticReleases(ctx context.Context, c v1connect.PaprikaServiceClient, app *v1.Application, limit, detailLimit int) (releases []*v1.Release, section map[string]any) {
	resp, err := c.ListReleases(ctx, connect.NewRequest(&v1.ListReleasesRequest{
		Namespace: optionalString(app.Namespace), ApplicationName: app.Name,
		PageSize: int32(limit), //nolint:gosec // applicationHealthArguments validates the release limit in [1,20]
	}))
	if err != nil {
		return nil, diagnosticRPCError(ctx, "releases", err)
	}
	if resp == nil || resp.Msg == nil {
		return nil, diagnosticRPCError(ctx, "releases", errors.New("release evidence is unavailable"))
	}
	releases = resp.Msg.Releases[:min(len(resp.Msg.Releases), limit)]
	data := make([]map[string]any, 0, len(releases))
	for _, release := range releases {
		if release == nil {
			continue
		}
		data = append(data, map[string]any{
			"name": release.Name, "namespace": release.Namespace, "phase": release.Phase,
			"createdAt": release.CreatedAt, "currentStage": release.CurrentStage, "target": release.Target,
			"rolledBackTo": release.RolledBackTo, "canaryWeight": release.CanaryWeight,
			"canaryStepIndex": release.CanaryStepIndex, "canaryStepStartedAt": release.CanaryStepStartedAt,
			"rolloutRef": release.RolloutRef, "observedGeneration": release.ObservedGeneration,
			"conditions": diagnosticItems(release.Conditions, detailLimit), "hooks": diagnosticItems(release.HookStatuses, detailLimit),
			"policies": diagnosticItems(release.PolicyResults, detailLimit),
		})
	}
	total := max(int(resp.Msg.TotalCount), len(resp.Msg.Releases))
	section = map[string]any{"status": "complete", "data": data, "totalCount": total, "truncated": total > len(releases)}
	if total > len(releases) {
		section["status"], section["nextPageOffset"] = "truncated", len(releases)
	}
	return releases, section
}

func diagnosticRollouts(ctx context.Context, c v1connect.PaprikaServiceClient, releases []*v1.Release, releaseSection map[string]any, limit int) map[string]any {
	if releaseSection["status"] == "error" {
		return map[string]any{"status": "not_available", "note": "Release evidence is unavailable, so linked rollout references cannot be resolved."}
	}
	refs := diagnosticRolloutRefs(releases)
	data, failures := make([]map[string]any, 0, min(len(refs), maxHealthRollouts)), make([]map[string]any, 0)
	for _, ref := range refs[:min(len(refs), maxHealthRollouts)] {
		rollout, err := diagnosticReadRollout(ctx, c, ref)
		if err != nil {
			failures = append(failures, map[string]any{"name": ref.Name, "namespace": ref.Namespace, "error": diagnosticRPCError(ctx, "rollouts", err)["error"]})
			continue
		}
		data = append(data, diagnosticRollout(rollout, limit))
	}
	section := map[string]any{"status": "complete", "data": data, "errors": failures, "totalLinkedCount": len(refs), "truncated": len(refs) > maxHealthRollouts}
	section["note"] = "Only rolloutRef links from the returned release page are resolved. A release can manage canary promotion directly without a Rollout object."
	if len(refs) > maxHealthRollouts {
		section["status"] = "truncated"
	}
	if len(failures) > 0 {
		section["status"] = "partial"
	}
	return section
}

func diagnosticRolloutRefs(releases []*v1.Release) []*v1.GetRolloutRequest {
	refs, seen := make([]*v1.GetRolloutRequest, 0, maxHealthRollouts), map[string]bool{}
	for _, release := range releases {
		if release == nil || release.RolloutRef == "" {
			continue
		}
		key := release.Namespace + "/" + release.RolloutRef
		if !seen[key] {
			seen[key] = true
			refs = append(refs, &v1.GetRolloutRequest{Namespace: release.Namespace, Name: release.RolloutRef})
		}
	}
	return refs
}

func diagnosticReadRollout(ctx context.Context, c v1connect.PaprikaServiceClient, ref *v1.GetRolloutRequest) (*v1.Rollout, error) {
	resp, err := c.GetRollout(ctx, connect.NewRequest(ref))
	if err != nil {
		return nil, fmt.Errorf("get linked rollout: %w", err)
	}
	if resp == nil || resp.Msg == nil || resp.Msg.Rollout == nil {
		return nil, errors.New("rollout evidence is unavailable")
	}
	return resp.Msg.Rollout, nil
}

func diagnosticRollout(rollout *v1.Rollout, limit int) map[string]any {
	return map[string]any{
		"name": rollout.Name, "namespace": rollout.Namespace, "phase": rollout.Phase,
		"strategyType": rollout.StrategyType, "currentStep": rollout.CurrentStep,
		"currentWeight": rollout.CurrentWeight, "paused": rollout.Paused, "abort": rollout.Abort,
		"message": rollout.Message, "targetKind": rollout.TargetKind, "targetName": rollout.TargetName,
		"replicas": rollout.Replicas, "stableReadyReplicas": rollout.StableReadyReplicas,
		"canaryReadyReplicas": rollout.CanaryReadyReplicas, "currentStepStartedAt": rollout.CurrentStepStartedAt,
		"promotedAt": rollout.PromotedAt, "previewHealthyAt": rollout.PreviewHealthyAt,
		"stableRs": rollout.StableRs, "canaryRs": rollout.CanaryRs, "currentPodHash": rollout.CurrentPodHash,
		"activeService": rollout.ActiveService, "previewService": rollout.PreviewService, "previousActiveRs": rollout.PreviousActiveRs,
		"observedGeneration": rollout.ObservedGeneration, "conditions": diagnosticItems(rollout.Conditions, limit),
	}
}

func diagnosticDrift(ctx context.Context, c v1connect.PaprikaServiceClient, namespace, name string, limit int) map[string]any {
	resp, err := c.ListDriftDetails(ctx, connect.NewRequest(&v1.ListDriftDetailsRequest{
		Namespace: namespace, Application: name, IncludeFields: true,
		PageSize: uint32(limit), //nolint:gosec // applicationHealthArguments validates the resource limit in [1,200]
	}))
	if err != nil {
		return diagnosticRPCError(ctx, "drift", err)
	}
	if resp == nil || resp.Msg == nil {
		return diagnosticRPCError(ctx, "drift", errors.New("drift evidence is unavailable"))
	}
	msg := resp.Msg
	section := map[string]any{"status": "not_available", "state": msg.State.String()}
	if msg.State != v1.DataState_DATA_STATE_OK && msg.State != v1.DataState_DATA_STATE_STALE {
		section["status"] = diagnosticDataState(msg.State)
		section["note"] = "Drift details are unavailable; zero counts from this data source do not establish that the application is synced. Use status.outOfSync and resource sync evidence."
		return section
	}
	section["status"] = "complete"
	resources, fieldsTruncated := diagnosticDriftResources(msg.Resources, limit)
	section["data"] = map[string]any{
		"resources": resources, "driftedCount": msg.DriftedCount,
		"missingCount": msg.MissingCount, "prunedCount": msg.PrunedCount, "evaluatedAtUnixMs": msg.EvaluatedAtUnixMs,
	}
	section["truncated"] = msg.NextCursor != "" || len(msg.Resources) > limit
	section["fieldsTruncated"] = fieldsTruncated
	if section["truncated"] == true {
		section["status"], section["nextCursor"] = "truncated", msg.NextCursor
	}
	if msg.State == v1.DataState_DATA_STATE_STALE {
		section["status"] = "stale"
	}
	return section
}

func diagnosticDriftResources(items []*v1.ResourceDriftDetail, limit int) (map[string]any, bool) {
	bounded := make([]*v1.ResourceDriftDetail, 0, min(len(items), limit))
	fieldsTruncated := false
	for _, item := range items[:min(len(items), limit)] {
		if item == nil {
			continue
		}
		cloned := proto.Clone(item).(*v1.ResourceDriftDetail) //nolint:errcheck,forcetypeassert // proto.Clone preserves the concrete type
		if len(cloned.Fields) > 20 {
			cloned.Fields = cloned.Fields[:20]
			cloned.FieldsTruncated = true
		}
		fieldsTruncated = fieldsTruncated || cloned.FieldsTruncated
		bounded = append(bounded, cloned)
	}
	section := diagnosticItems(bounded, limit)
	section["totalCount"] = len(items)
	section["truncated"] = len(items) > limit
	if len(items) > limit {
		section["status"] = "truncated"
	}
	return section, fieldsTruncated
}

func diagnosticDataState(state v1.DataState) string {
	switch state {
	case v1.DataState_DATA_STATE_OK:
		return "complete"
	case v1.DataState_DATA_STATE_STALE:
		return "stale"
	case v1.DataState_DATA_STATE_UNSPECIFIED, v1.DataState_DATA_STATE_NOT_AVAILABLE:
		return "not_available"
	case v1.DataState_DATA_STATE_NOT_CONFIGURED:
		return "not_configured"
	case v1.DataState_DATA_STATE_ERROR:
		return "error"
	case v1.DataState_DATA_STATE_FORBIDDEN:
		return "forbidden"
	default:
		return "not_available"
	}
}

func diagnosticInvestigation(ctx context.Context, c v1connect.PaprikaServiceClient, namespace, name string, limit int) map[string]any {
	resp, err := c.Investigate(ctx, connect.NewRequest(&v1.InvestigateRequest{ApplicationNamespace: namespace, ApplicationName: name}))
	if err != nil {
		return diagnosticRPCError(ctx, "investigation", err)
	}
	if resp == nil || resp.Msg == nil {
		return diagnosticRPCError(ctx, "investigation", errors.New("investigation evidence is unavailable"))
	}
	findings, evidenceTruncated := diagnosticFindings(resp.Msg.Findings, limit)
	section := diagnosticItems(findings, limit)
	section["totalCount"] = len(resp.Msg.Findings)
	section["truncated"] = evidenceTruncated || len(resp.Msg.Findings) > limit
	if section["truncated"] == true {
		section["status"] = "truncated"
	}
	section["summary"], section["narrator"], section["generatedAtMs"] = resp.Msg.Summary, resp.Msg.Narrator, resp.Msg.GeneratedAtMs
	section["note"] = "Application-level automated findings are advisory. The investigator API does not report per-source collection failures; empty findings do not establish health. Use investigate with an exact resource for targeted live evidence."
	return section
}

func diagnosticFindings(items []*v1.InvestigationFinding, limit int) ([]*v1.InvestigationFinding, bool) {
	bounded := make([]*v1.InvestigationFinding, 0, min(len(items), limit))
	evidenceTruncated := false
	for _, item := range items[:min(len(items), limit)] {
		if item == nil {
			continue
		}
		cloned := proto.Clone(item).(*v1.InvestigationFinding) //nolint:errcheck,forcetypeassert // proto.Clone preserves the concrete type
		if len(cloned.Evidence) > limit || len(cloned.Playbook) > limit {
			evidenceTruncated = true
			cloned.Evidence = cloned.Evidence[:min(len(cloned.Evidence), limit)]
			cloned.Playbook = cloned.Playbook[:min(len(cloned.Playbook), limit)]
		}
		bounded = append(bounded, cloned)
	}
	return bounded, evidenceTruncated
}

func diagnosticError(err error) map[string]any {
	// Secondary failures are successful partial tool results, so they bypass
	// Server.mapInvokeError. Preserve its privacy boundary here too: backend
	// errors can name inaccessible resources, credentials or internal endpoints.
	return map[string]any{"status": "error", "error": map[string]any{"code": connect.CodeOf(err).String(), "message": "Evidence is unavailable. Check permissions and server diagnostics."}}
}

func diagnosticRPCError(ctx context.Context, section string, err error) map[string]any {
	log.FromContext(ctx).Error(err, "mcp: application health evidence failed", "section", section)
	return diagnosticError(err)
}

// diagnosticPartial includes nested truncation/errors, missing data classes
// and stale evidence. An explicitly unrequested investigation is not missing
// evidence because it is outside the requested read.
func diagnosticPartial(value any) bool {
	switch section := value.(type) {
	case map[string]any:
		return diagnosticPartialMap(section)
	case []map[string]any:
		for _, nested := range section {
			if diagnosticPartial(nested) {
				return true
			}
		}
	}
	return false
}

func diagnosticPartialMap(section map[string]any) bool {
	if section["truncated"] == true || section["fieldsTruncated"] == true {
		return true
	}
	if status, ok := section["status"].(string); ok && status != "complete" && status != "not_requested" {
		return true
	}
	for _, nested := range section {
		if diagnosticPartial(nested) {
			return true
		}
	}
	return false
}
