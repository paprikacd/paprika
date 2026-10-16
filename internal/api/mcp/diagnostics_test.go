package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type diagnosticService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	app              *v1.Application
	appErr           error
	releases         []*v1.Release
	releaseCount     int32
	releaseErr       error
	rollouts         map[string]*v1.Rollout
	rolloutErr       error
	drift            *v1.ListDriftDetailsResponse
	driftErr         error
	investigation    *v1.InvestigateResponse
	investigationErr error
	calls            []string
	releaseRequest   *v1.ListReleasesRequest
	driftRequest     *v1.ListDriftDetailsRequest
	rolloutRequests  []*v1.GetRolloutRequest
}

func (s *diagnosticService) GetApplication(_ context.Context, req *connect.Request[v1.GetApplicationRequest]) (*connect.Response[v1.GetApplicationResponse], error) {
	s.calls = append(s.calls, "GetApplication")
	if s.appErr != nil {
		return nil, s.appErr
	}
	return connect.NewResponse(&v1.GetApplicationResponse{Application: s.app}), nil
}

func (s *diagnosticService) ListReleases(_ context.Context, req *connect.Request[v1.ListReleasesRequest]) (*connect.Response[v1.ListReleasesResponse], error) {
	s.calls = append(s.calls, "ListReleases")
	s.releaseRequest = req.Msg
	if s.releaseErr != nil {
		return nil, s.releaseErr
	}
	return connect.NewResponse(&v1.ListReleasesResponse{Releases: s.releases, TotalCount: s.releaseCount}), nil
}

func (s *diagnosticService) GetRollout(_ context.Context, req *connect.Request[v1.GetRolloutRequest]) (*connect.Response[v1.GetRolloutResponse], error) {
	s.calls = append(s.calls, "GetRollout")
	s.rolloutRequests = append(s.rolloutRequests, req.Msg)
	if s.rolloutErr != nil {
		return nil, s.rolloutErr
	}
	return connect.NewResponse(&v1.GetRolloutResponse{Rollout: s.rollouts[req.Msg.Namespace+"/"+req.Msg.Name]}), nil
}

func (s *diagnosticService) ListDriftDetails(_ context.Context, req *connect.Request[v1.ListDriftDetailsRequest]) (*connect.Response[v1.ListDriftDetailsResponse], error) {
	s.calls = append(s.calls, "ListDriftDetails")
	s.driftRequest = req.Msg
	if s.driftErr != nil {
		return nil, s.driftErr
	}
	if s.drift == nil {
		return connect.NewResponse(&v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_NOT_CONFIGURED}), nil
	}
	return connect.NewResponse(s.drift), nil
}

func (s *diagnosticService) Investigate(_ context.Context, req *connect.Request[v1.InvestigateRequest]) (*connect.Response[v1.InvestigateResponse], error) {
	s.calls = append(s.calls, "Investigate")
	if s.investigationErr != nil {
		return nil, s.investigationErr
	}
	if s.investigation == nil {
		return connect.NewResponse(&v1.InvestigateResponse{}), nil
	}
	return connect.NewResponse(s.investigation), nil
}

func recordedDiagnosticApplication() *v1.Application {
	return &v1.Application{
		Name: "checkout", Namespace: "tenant", Project: "payments", Phase: "Healthy", Health: "Healthy",
		Synced: true, Resources: []*v1.ResourceSync{{Kind: "Deployment", Name: "checkout", Namespace: "tenant", Status: "Synced"}},
		ResourceHealth: []*v1.ResourceHealth{{Kind: "Deployment", Name: "checkout", Namespace: "tenant", Health: "Healthy"}},
	}
}

func invokeDiagnostic(t *testing.T, svc *diagnosticService, args string) map[string]any {
	t.Helper()
	result, err := readGetApplicationHealthTool().Invoke(context.Background(), newTestClient(t, svc), json.RawMessage(args))
	require.NoError(t, err)
	encoded, err := marshalToolResult(result)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	return decoded
}

func diagnosticMap(t *testing.T, value any) map[string]any {
	t.Helper()
	out, ok := value.(map[string]any)
	require.True(t, ok)
	return out
}

func diagnosticList(t *testing.T, value any) []any {
	t.Helper()
	out, ok := value.([]any)
	require.True(t, ok)
	return out
}

func TestApplicationHealthReportsEvidenceWithoutGuessingAwayRetryLatch(t *testing.T) {
	app := recordedDiagnosticApplication()
	app.OutOfSync = 2
	app.SourceRevision = "resolved-commit"
	app.Conditions = []*v1.Condition{{Type: "ReleaseRetriesExhausted", Status: "True", Message: "canary failed", LastTransitionTime: "2026-10-04T12:00:00Z"}}
	app.Resources = append(app.Resources, &v1.ResourceSync{Kind: "Service", Name: "candidate", Namespace: "tenant", Status: "OutOfSync"})
	app.ResourceHealth = append(app.ResourceHealth, &v1.ResourceHealth{Kind: "Service", Name: "candidate", Namespace: "tenant", Health: "Degraded", Message: "no endpoints"})
	app.HealthChecks = []*v1.HealthCheckResult{{Name: "public", Status: "Unhealthy", CheckedAt: protoInt64(1780000000), HttpBody: "sensitive-body", Reason: "status_mismatch", Slo: &v1.SLOSummary{State: "warming_up", CoveragePercentage: 35, Timeline: []*v1.SLOBucket{{Healthy: 1}}}}}
	svc := &diagnosticService{
		app: app, drift: &v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_OK},
		releases: []*v1.Release{{Name: "release-1", Namespace: "tenant", Phase: "Failed", RolloutRef: "candidate", RenderedManifestSnapshot: "secret-manifest", PromotionHistory: []*v1.Promotion{{ManifestSnapshot: "promotion-secret"}}}},
		rollouts: map[string]*v1.Rollout{"tenant/candidate": {Name: "candidate", Namespace: "tenant", Phase: "Paused", Paused: true, CurrentWeight: 10, AnalysisChecks: []*v1.RolloutAnalysisCheck{{HttpHeaders: map[string]string{"Authorization": "secret-header"}}}}},
	}
	out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant","resource_limit":1}`)
	status := diagnosticMap(t, out["status"])
	assert.Equal(t, "Healthy", status["health"], "reported health must remain separate from contradictory failure evidence")
	assert.Equal(t, true, status["retriesExhausted"])
	assert.Equal(t, float64(2), status["outOfSync"])
	assert.Equal(t, true, status["partial"], "resource cap must be visible in the overall status")
	observedAt, ok := out["observedAt"].(string)
	require.True(t, ok)
	_, err := time.Parse(time.RFC3339Nano, observedAt)
	require.NoError(t, err)
	resources := diagnosticMap(t, out["resources"])
	health := diagnosticMap(t, resources["health"])
	assert.Equal(t, "truncated", health["status"])
	assert.Equal(t, "candidate", diagnosticMap(t, diagnosticList(t, health["data"])[0])["name"])
	sync := diagnosticMap(t, resources["sync"])
	assert.Equal(t, "OutOfSync", diagnosticMap(t, diagnosticList(t, sync["data"])[0])["status"])
	check := diagnosticMap(t, diagnosticList(t, diagnosticMap(t, out["healthChecks"])["data"])[0])
	assert.Equal(t, "status_mismatch", check["reason"])
	assert.Equal(t, "1780000000", check["checkedAt"], "protobuf int64 and camelCase JSON must survive nested sections")
	assert.Equal(t, float64(35), diagnosticMap(t, check["slo"])["coveragePercentage"])
	encoded, err := json.Marshal(out)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "secret-manifest")
	assert.NotContains(t, string(encoded), "promotion-secret")
	assert.NotContains(t, string(encoded), "secret-header")
	assert.NotContains(t, string(encoded), "sensitive-body")
	assert.Equal(t, "not_requested", diagnosticMap(t, out["investigation"])["status"])
	assert.NotContains(t, svc.calls, "Investigate")
	require.NotNil(t, svc.releaseRequest.Namespace)
	assert.Equal(t, "tenant", *svc.releaseRequest.Namespace)
	assert.Equal(t, "checkout", svc.releaseRequest.ApplicationName)
	assert.EqualValues(t, defaultHealthReleaseLimit, svc.releaseRequest.PageSize)
	assert.Equal(t, "checkout", svc.driftRequest.Application)
	assert.True(t, svc.driftRequest.IncludeFields)
	assert.EqualValues(t, 1, svc.driftRequest.PageSize)
}

func protoInt64(value int64) *int64 { return &value }

func TestApplicationHealthAuthorizationFailureStopsAllSecondaryReads(t *testing.T) {
	for _, code := range []connect.Code{connect.CodePermissionDenied, connect.CodeNotFound, connect.CodeUnauthenticated} {
		t.Run(code.String(), func(t *testing.T) {
			svc := &diagnosticService{appErr: connect.NewError(code, errors.New("application unavailable"))}
			_, err := readGetApplicationHealthTool().Invoke(context.Background(), newTestClient(t, svc), json.RawMessage(`{"name":"checkout","namespace":"tenant"}`))
			require.Error(t, err)
			assert.Equal(t, code, connect.CodeOf(err))
			assert.Equal(t, []string{"GetApplication"}, svc.calls)
		})
	}
}

func TestApplicationHealthRejectsInvalidIdentityAndBoundsBeforeReading(t *testing.T) {
	for _, args := range []string{
		`{}`, `{"name":"checkout"}`, `{"name":"checkout","namespace":""}`,
		`{"name":"../checkout","namespace":"tenant"}`,
		`{"name":"checkout","namespace":"tenant","resource_limit":0}`,
		`{"name":"checkout","namespace":"tenant","resource_limit":1.5}`,
		`{"name":"checkout","namespace":"tenant","resource_limit":4294967346}`,
		`{"name":"checkout","namespace":"tenant","release_limit":21}`,
		`{"name":"checkout","namespace":"tenant","include_investigation":"true"}`,
		`{"name":"checkout","namespace":"tenant","extra":true}`,
	} {
		t.Run(args, func(t *testing.T) {
			svc := &diagnosticService{}
			_, err := readGetApplicationHealthTool().Invoke(context.Background(), newTestClient(t, svc), json.RawMessage(args))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			assert.Empty(t, svc.calls)
		})
	}
}

func TestApplicationHealthMissingApplicationCannotProduceSuccess(t *testing.T) {
	for _, app := range []*v1.Application{nil, {Name: "different", Namespace: "tenant"}} {
		svc := &diagnosticService{app: app}
		_, err := readGetApplicationHealthTool().Invoke(context.Background(), newTestClient(t, svc), json.RawMessage(`{"name":"checkout","namespace":"tenant"}`))
		require.Error(t, err)
		assert.Equal(t, []string{"GetApplication"}, svc.calls)
	}
}

func TestApplicationHealthSecondaryFailuresRetainReportedStateAndErrorCodes(t *testing.T) {
	svc := &diagnosticService{
		app: recordedDiagnosticApplication(), releaseErr: connect.NewError(connect.CodePermissionDenied, errors.New("release scope denied")),
		drift:            &v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_STALE, DriftedCount: 3, EvaluatedAtUnixMs: 1780000000000},
		investigationErr: connect.NewError(connect.CodeUnavailable, errors.New("investigator unavailable")),
	}
	out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant","include_investigation":true}`)
	status := diagnosticMap(t, out["status"])
	assert.Equal(t, true, status["partial"])
	assert.Equal(t, "Healthy", status["health"])
	assert.Nil(t, status["retriesExhausted"], "absence of a retry condition is unknown, not evidence of a cleared latch")
	releases := diagnosticMap(t, out["releases"])
	assert.Equal(t, "error", releases["status"])
	assert.Equal(t, "permission_denied", diagnosticMap(t, releases["error"])["code"])
	assert.Equal(t, "not_available", diagnosticMap(t, out["rollouts"])["status"])
	assert.Equal(t, "stale", diagnosticMap(t, out["drift"])["status"])
	assert.Equal(t, float64(3), diagnosticMap(t, diagnosticMap(t, out["drift"])["data"])["driftedCount"])
	assert.Equal(t, "unavailable", diagnosticMap(t, diagnosticMap(t, out["investigation"])["error"])["code"])
	assert.Contains(t, svc.calls, "Investigate")
}

func TestApplicationHealthMasksSecondaryBackendErrorDetails(t *testing.T) {
	for _, code := range []connect.Code{connect.CodePermissionDenied, connect.CodeInternal, connect.CodeUnavailable} {
		t.Run(code.String(), func(t *testing.T) {
			backendErr := connect.NewError(code, errors.New("cannot reach https://private-endpoint:8443 using bearer secret-marker in hidden-namespace"))
			svc := &diagnosticService{
				app: recordedDiagnosticApplication(), releases: []*v1.Release{{Name: "recent", Namespace: "tenant", RolloutRef: "candidate"}},
				rolloutErr: backendErr, driftErr: backendErr, investigationErr: backendErr,
			}
			out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant","include_investigation":true}`)
			encoded, err := json.Marshal(out)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), "private-endpoint")
			assert.NotContains(t, string(encoded), "secret-marker")
			assert.NotContains(t, string(encoded), "hidden-namespace")
			assert.Equal(t, code.String(), diagnosticMap(t, diagnosticMap(t, out["drift"])["error"])["code"])
			assert.Equal(t, true, diagnosticMap(t, out["status"])["partial"])
		})
	}
}

func TestApplicationHealthUnavailableDriftNeverReportsZeroEvidenceAsSynced(t *testing.T) {
	for _, state := range []v1.DataState{
		v1.DataState_DATA_STATE_UNSPECIFIED, v1.DataState_DATA_STATE_NOT_CONFIGURED,
		v1.DataState_DATA_STATE_NOT_AVAILABLE, v1.DataState_DATA_STATE_FORBIDDEN, v1.DataState_DATA_STATE_ERROR,
	} {
		t.Run(state.String(), func(t *testing.T) {
			svc := &diagnosticService{app: recordedDiagnosticApplication(), drift: &v1.ListDriftDetailsResponse{State: state}}
			out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant"}`)
			drift := diagnosticMap(t, out["drift"])
			assert.Equal(t, state.String(), drift["state"])
			assert.NotContains(t, drift, "data", "unavailable zero counts are not evidence")
			assert.NotEqual(t, "complete", drift["status"])
			assert.Equal(t, true, diagnosticMap(t, out["status"])["partial"])
		})
	}
}

func TestApplicationHealthResolvesOnlyExplicitBoundedRolloutLinks(t *testing.T) {
	svc := &diagnosticService{app: recordedDiagnosticApplication(), releaseCount: 21, rollouts: map[string]*v1.Rollout{}, drift: &v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_OK}}
	for i := 0; i < 21; i++ {
		name := fmt.Sprintf("rollout-%d", i)
		svc.releases = append(svc.releases, &v1.Release{Name: fmt.Sprintf("release-%d", i), Namespace: "tenant", RolloutRef: name})
		svc.rollouts["tenant/"+name] = &v1.Rollout{Name: name, Namespace: "tenant", Phase: "Healthy"}
	}
	// Deduplicate identical explicit references, without name heuristics or
	// broad namespace rollout discovery.
	svc.releases[1].RolloutRef = svc.releases[0].RolloutRef
	out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant","release_limit":20}`)
	releases := diagnosticMap(t, out["releases"])
	assert.Len(t, diagnosticList(t, releases["data"]), maxHealthReleaseLimit)
	assert.Equal(t, float64(20), releases["nextPageOffset"])
	rollouts := diagnosticMap(t, out["rollouts"])
	assert.Equal(t, "truncated", rollouts["status"])
	assert.Equal(t, float64(19), rollouts["totalLinkedCount"])
	assert.Len(t, diagnosticList(t, rollouts["data"]), maxHealthRollouts)
	assert.Len(t, svc.rolloutRequests, maxHealthRollouts)
	assert.Equal(t, "rollout-0", svc.rolloutRequests[0].Name)
	assert.Equal(t, "rollout-2", svc.rolloutRequests[1].Name)
	assert.NotContains(t, svc.calls, "ListRollouts")
	assert.Equal(t, true, diagnosticMap(t, out["status"])["partial"])
}

func TestApplicationHealthBoundsDriftFieldsAndInvestigationFindings(t *testing.T) {
	detail := &v1.ResourceDriftDetail{Name: "checkout", ChangedFieldCount: 21}
	for i := 0; i < 21; i++ {
		detail.Fields = append(detail.Fields, &v1.DriftedField{Path: fmt.Sprintf("/spec/field%d", i)})
	}
	svc := &diagnosticService{
		app:           recordedDiagnosticApplication(),
		drift:         &v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_OK, Resources: []*v1.ResourceDriftDetail{detail}, NextCursor: "continue"},
		investigation: &v1.InvestigateResponse{Summary: "advisory", Findings: []*v1.InvestigationFinding{{Title: "first"}, {Title: "second"}}},
	}
	out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant","resource_limit":1,"include_investigation":true}`)
	drift := diagnosticMap(t, out["drift"])
	assert.Equal(t, true, drift["fieldsTruncated"])
	assert.Equal(t, "continue", drift["nextCursor"])
	resources := diagnosticMap(t, diagnosticMap(t, drift["data"])["resources"])
	resource := diagnosticMap(t, diagnosticList(t, resources["data"])[0])
	assert.Len(t, diagnosticList(t, resource["fields"]), 20)
	assert.Equal(t, true, resource["fieldsTruncated"])
	assert.Equal(t, float64(21), resource["changedFieldCount"])
	assert.Len(t, detail.Fields, 21, "projection must not mutate the API's source data")
	investigation := diagnosticMap(t, out["investigation"])
	assert.Equal(t, "truncated", investigation["status"])
	assert.Equal(t, "advisory", investigation["summary"])
	assert.Len(t, diagnosticList(t, investigation["data"]), 1)
	assert.Equal(t, true, diagnosticMap(t, out["status"])["partial"])
}

func TestApplicationHealthUnknownStatusAndEmptyResourcesAreExplicit(t *testing.T) {
	svc := &diagnosticService{app: &v1.Application{Name: "checkout", Namespace: "tenant"}, drift: &v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_OK}}
	out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant"}`)
	status := diagnosticMap(t, out["status"])
	assert.Equal(t, "Unknown", status["health"])
	assert.Equal(t, "Unknown", status["phase"])
	assert.Equal(t, "not_available", diagnosticMap(t, out["resources"])["status"])
	assert.Equal(t, true, status["partial"])
}

func TestApplicationHealthCompleteEvidenceHasNoPartialFlag(t *testing.T) {
	svc := &diagnosticService{app: recordedDiagnosticApplication(), drift: &v1.ListDriftDetailsResponse{State: v1.DataState_DATA_STATE_OK}}
	out := invokeDiagnostic(t, svc, `{"name":"checkout","namespace":"tenant"}`)
	assert.Equal(t, false, diagnosticMap(t, out["status"])["partial"])
}
