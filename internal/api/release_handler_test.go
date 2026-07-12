package apiserver

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/fleet"
	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

func TestConvertRelease_ExposesRolloutHooksConditionsAndCanaryState(t *testing.T) {
	started := metav1.NewTime(time.Unix(1700000010, 0))
	completed := metav1.NewTime(time.Unix(1700000020, 0))
	stepStarted := metav1.NewTime(time.Unix(1700000030, 0))
	promoted := metav1.NewTime(time.Unix(1700000040, 0))

	rel := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-release", Namespace: "apps", Labels: map[string]string{"app.kubernetes.io/name": "demo-app"}},
		Spec:       pipelinesv1alpha1.ReleaseSpec{Pipeline: "demo-pipeline", Target: "prod"},
		Status: pipelinesv1alpha1.ReleaseStatus{
			ObservedGeneration:       7,
			Phase:                    pipelinesv1alpha1.ReleaseCanarying,
			CurrentStage:             "prod",
			RenderedManifestSnapshot: "demo-release-snapshot",
			CanaryWeight:             50,
			CanaryStepIndex:          2,
			CanaryStepStartedAt:      &stepStarted,
			RolloutRef:               "demo-rollout",
			Conditions: []metav1.Condition{
				{Type: "PolicyReady", Status: metav1.ConditionTrue, Reason: "Passed", Message: "policies passed"},
			},
			PromotionHistory: []pipelinesv1alpha1.PromotionEntry{
				{Stage: "prod", Result: "Promoted", ManifestSnapshot: "prod-snapshot", Timestamp: promoted},
			},
			HookStatuses: []pipelinesv1alpha1.HookStatus{
				{
					Kind:        "Job",
					Name:        "pre-sync",
					Namespace:   "apps",
					Phase:       "PreSync",
					Status:      "Succeeded",
					StartedAt:   &started,
					CompletedAt: &completed,
					Message:     "completed",
				},
			},
		},
	}

	got := convertRelease(rel)
	require.EqualValues(t, 7, got.ObservedGeneration)
	require.Equal(t, "demo-release-snapshot", got.RenderedManifestSnapshot)
	require.EqualValues(t, 50, got.CanaryWeight)
	require.EqualValues(t, 2, got.CanaryStepIndex)
	require.EqualValues(t, 1700000030, got.CanaryStepStartedAt)
	require.Equal(t, "demo-rollout", got.RolloutRef)
	require.Len(t, got.Conditions, 1)
	require.Equal(t, "PolicyReady", got.Conditions[0].Type)
	require.Len(t, got.PromotionHistory, 1)
	require.Equal(t, "prod-snapshot", got.PromotionHistory[0].ManifestSnapshot)
	require.Len(t, got.HookStatuses, 1)
	require.Equal(t, "PreSync", got.HookStatuses[0].Phase)
	require.Equal(t, "Succeeded", got.HookStatuses[0].Status)
	require.EqualValues(t, 1700000010, got.HookStatuses[0].StartedAt)
	require.EqualValues(t, 1700000020, got.HookStatuses[0].CompletedAt)
}

func TestListReleases_FiltersByApplicationAndPaginatesNewestFirst(t *testing.T) {
	release := func(name, app string, created int64) *pipelinesv1alpha1.Release {
		return &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{
				Name:              name,
				Namespace:         "apps",
				CreationTimestamp: metav1.NewTime(time.Unix(created, 0)),
				Labels: map[string]string{
					projectLabelKey:                "default",
					engine.ApplicationNameLabelKey: app,
				},
			},
			Spec: pipelinesv1alpha1.ReleaseSpec{Pipeline: "deploy", Target: "prod"},
		}
	}
	cl := newPipelineTestClient(
		release("checkout-1", "checkout", 100),
		release("checkout-2", "checkout", 300),
		release("checkout-3", "checkout", 200),
		release("billing-1", "billing", 400),
	)
	srv := NewPaprikaServer(cl, nil)
	namespace := "apps"

	resp, err := srv.ListReleases(context.Background(), connect.NewRequest(&paprikav1.ListReleasesRequest{
		Namespace:       &namespace,
		ApplicationName: "checkout",
		PageSize:        2,
		PageOffset:      1,
	}))

	require.NoError(t, err)
	require.EqualValues(t, 3, resp.Msg.TotalCount)
	require.Len(t, resp.Msg.Releases, 2)
	require.Equal(t, "checkout-3", resp.Msg.Releases[0].Name)
	require.Equal(t, "checkout-1", resp.Msg.Releases[1].Name)
}

func TestQueryReleasesRejectsMissingRequest(t *testing.T) {
	t.Parallel()

	server := &PaprikaServer{}
	for _, request := range []*connect.Request[paprikav1.QueryReleasesRequest]{
		nil,
		connect.NewRequest((*paprikav1.QueryReleasesRequest)(nil)),
	} {
		response, err := server.QueryReleases(context.Background(), request)

		require.Nil(t, response)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
}

func TestQueryReleasesRejectsOversizedSearch(t *testing.T) {
	t.Parallel()

	response, err := (&PaprikaServer{}).QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{
			Search: strings.Repeat("界", 129),
		}),
	)

	require.Nil(t, response)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestQueryReleasesRejectsInvalidPagination(t *testing.T) {
	t.Parallel()

	tests := []*paprikav1.QueryReleasesRequest{
		{PageSize: 101},
		{PageOffset: 1_000_001},
	}
	for _, request := range tests {
		response, err := (&PaprikaServer{}).QueryReleases(context.Background(), connect.NewRequest(request))

		require.Nil(t, response)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
}

func TestQueryReleasesRejectsInvalidFleetFilter(t *testing.T) {
	t.Parallel()

	response, err := (&PaprikaServer{}).QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{
			Filter: &paprikav1.FleetFilter{
				Health: []paprikav1.FleetHealth{
					paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED,
				},
			},
		}),
	)

	require.Nil(t, response)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestListReleasesZeroPageSizeRemainsUnbounded(t *testing.T) {
	objects := make([]client.Object, 0, 30)
	for i := range 30 {
		objects = append(objects, queryRelease("apps", fmt.Sprintf("release-%02d", i), "checkout", "default", int64(i)))
	}
	server := NewPaprikaServer(newPipelineTestClient(objects...), nil)

	response, err := server.ListReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.ListReleasesRequest{}),
	)

	require.NoError(t, err)
	require.EqualValues(t, 30, response.Msg.TotalCount)
	require.Len(t, response.Msg.Releases, 30)
}

func TestQueryReleasesDefaultsToBoundedPageWithoutRequiringEmptyFilterIndex(t *testing.T) {
	objects := make([]client.Object, 0, 30)
	for i := range 30 {
		objects = append(objects, queryRelease("apps", fmt.Sprintf("match-release-%02d", i), "checkout", "default", int64(i)))
	}
	server := NewPaprikaServer(newPipelineTestClient(objects...), nil)

	for _, filter := range []*paprikav1.FleetFilter{nil, {}} {
		for _, search := range []string{"", "match"} {
			response, err := server.QueryReleases(
				context.Background(),
				connect.NewRequest(&paprikav1.QueryReleasesRequest{Filter: filter, Search: search}),
			)

			require.NoError(t, err)
			require.Equal(t, uint64(30), response.Msg.TotalCount)
			require.Len(t, response.Msg.Releases, defaultReleaseQueryPageSize)
		}
	}
}

func TestQueryReleasesRanksNormalizedNameBeforeNewerMetadataMatches(t *testing.T) {
	exact := queryRelease("apps", "foo-bar", "checkout", "default", 100)
	prefix := queryRelease("apps", "foo-bar-api", "checkout", "default", 500)
	substring := queryRelease("apps", "my-foo-bar-api", "checkout", "default", 600)
	metadataNew := queryRelease("apps", "metadata-new", "checkout", "default", 800)
	metadataNew.Spec.Pipeline = "foo-bar"
	metadataOld := queryRelease("apps", "metadata-old", "checkout", "default", 700)
	metadataOld.Spec.Target = "foo_bar"
	server := NewPaprikaServer(newPipelineTestClient(
		exact, prefix, substring, metadataNew, metadataOld,
		queryRelease("apps", "unrelated", "checkout", "default", 900),
	), nil)

	response, err := server.QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{Search: "ＦＯＯ＿ＢＡＲ", PageSize: 10}),
	)

	require.NoError(t, err)
	require.Equal(t, uint64(5), response.Msg.TotalCount)
	require.Equal(t, []string{
		"foo-bar", "foo-bar-api", "my-foo-bar-api", "metadata-new", "metadata-old",
	}, releaseNames(response.Msg.Releases))
}

func TestQueryReleasesRequiresEveryTermAcrossAllSearchableFields(t *testing.T) {
	matching := queryRelease("team-ns", "needle-release", "checkout-app", "default", 100)
	matching.Spec.Pipeline = "deploy-pipe"
	matching.Spec.Target = "prod-target"
	matching.Status.Phase = pipelinesv1alpha1.ReleaseComplete
	matching.Status.CurrentStage = "stable-stage"
	missingStage := matching.DeepCopy()
	missingStage.Name = "needle-incomplete"
	missingStage.Status.CurrentStage = "canary-stage"
	server := NewPaprikaServer(newPipelineTestClient(matching, missingStage), nil)

	response, err := server.QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{
			Search:   "needle team checkout deploy prod complete stable",
			PageSize: 10,
		}),
	)

	require.NoError(t, err)
	require.Equal(t, uint64(1), response.Msg.TotalCount)
	require.Equal(t, []string{"needle-release"}, releaseNames(response.Msg.Releases))
}

func TestQueryReleasesSortsEqualMatchesDeterministicallyBeforeOffset(t *testing.T) {
	server := NewPaprikaServer(newPipelineTestClient(
		queryRelease("b", "alpha", "app", "default", 100),
		queryRelease("a", "zeta", "app", "default", 100),
		queryRelease("a", "alpha", "app", "default", 100),
	), nil)

	response, err := server.QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{PageSize: 2, PageOffset: 1}),
	)

	require.NoError(t, err)
	require.Equal(t, uint64(3), response.Msg.TotalCount)
	require.Equal(t, []string{"a/zeta", "b/alpha"}, releaseIdentities(response.Msg.Releases))
}

func TestQueryReleasesAuthorizesBeforeRankingCountingAndPagination(t *testing.T) {
	unauthorizedExact := queryRelease("private", "needle", "secret-app", "secret", 900)
	authorizedNew := queryRelease("public", "allowed-new", "checkout", "payments", 300)
	authorizedNew.Spec.Pipeline = "needle"
	authorizedOld := queryRelease("public", "allowed-old", "checkout", "payments", 200)
	authorizedOld.Spec.Target = "needle"
	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects: []string{"alice"}, Actions: []string{string(auth.ActionRead)},
		Resources:  []string{string(auth.ResourceReleases)},
		Namespaces: []string{"public"}, Projects: []string{"payments"},
	}})
	server := NewPaprikaServer(
		newPipelineTestClient(unauthorizedExact, authorizedNew, authorizedOld), nil,
		WithAuthorizer(authorizer),
	)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	response, err := server.QueryReleases(
		ctx,
		connect.NewRequest(&paprikav1.QueryReleasesRequest{Search: "needle", PageSize: 1}),
	)

	require.NoError(t, err)
	require.Equal(t, uint64(2), response.Msg.TotalCount)
	require.Equal(t, []string{"allowed-new"}, releaseNames(response.Msg.Releases))
}

func TestQueryReleasesAuthorizationErrors(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	counter, err := provider.Meter("paprika/query-releases-test").Int64Counter("paprika.api.list.errors")
	require.NoError(t, err)
	previousCounter := paprikametrics.APIListErrors
	paprikametrics.APIListErrors = counter
	t.Cleanup(func() {
		paprikametrics.APIListErrors = previousCounter
		require.NoError(t, provider.Shutdown(context.Background()))
	})

	t.Run("unauthorized releases are skipped", func(t *testing.T) {
		authorizer := &fleetScopeAuthorizer{authorize: func(call fleetPermissionCall) error {
			if call.project.Namespace == "private" {
				return auth.ErrUnauthorized
			}
			return nil
		}}
		server := NewPaprikaServer(
			newPipelineTestClient(
				queryRelease("private", "secret", "secret-app", "secret", 200),
				queryRelease("public", "allowed", "checkout", "payments", 100),
			),
			nil,
			WithAuthorizer(authorizer),
		)
		ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

		response, queryErr := server.QueryReleases(
			ctx,
			connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
		)

		require.NoError(t, queryErr)
		require.Equal(t, uint64(1), response.Msg.TotalCount)
		require.Equal(t, []string{"allowed"}, releaseNames(response.Msg.Releases))
	})

	t.Run("operational authorization errors fail the request", func(t *testing.T) {
		backendErr := errors.New("authorization backend unavailable")
		authorizer := &fleetScopeAuthorizer{authorize: func(fleetPermissionCall) error {
			return backendErr
		}}
		server := NewPaprikaServer(
			newPipelineTestClient(queryRelease("public", "allowed", "checkout", "payments", 100)),
			nil,
			WithAuthorizer(authorizer),
		)
		ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

		response, queryErr := server.QueryReleases(
			ctx,
			connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
		)

		require.Nil(t, response)
		require.Equal(t, connect.CodeInternal, connect.CodeOf(queryErr))
	})

	requireAPIListErrorMetric(t, reader, "releases", 1)
}

func TestQueryReleasesAppliesAuthorizedFleetScopeBeforeSearchCountAndOffset(t *testing.T) {
	inScopeProject := fleet.ProjectKey{Namespace: "tenant-a", Name: "payments"}
	secretProject := fleet.ProjectKey{Namespace: "tenant-b", Name: "secret"}
	production := fleet.ClusterKey{Namespace: "tenant-a", Name: "production"}
	staging := fleet.ClusterKey{Namespace: "tenant-a", Name: "staging"}
	index := fleet.NewIndex()
	installFleetAuthorizationSnapshot(t, index, []fleet.ApplicationSummary{
		{
			Identity: types.NamespacedName{Namespace: "tenant-a", Name: "checkout"}, Project: inScopeProject,
			Targets: []fleet.StageTargetSummary{{Stage: "production", Cluster: production}},
		},
		{
			Identity: types.NamespacedName{Namespace: "tenant-a", Name: "billing"}, Project: inScopeProject,
			Targets: []fleet.StageTargetSummary{{Stage: "staging", Cluster: staging}},
		},
		{
			Identity: types.NamespacedName{Namespace: "tenant-b", Name: "secret-app"}, Project: secretProject,
			Targets: []fleet.StageTargetSummary{{Stage: "production", Cluster: production}},
		},
	})
	allowed := queryRelease("tenant-a", "allowed-metadata", "checkout", "payments", 100)
	allowed.Spec.Pipeline = "needle"
	allowedOlder := queryRelease("tenant-a", "allowed-older", "checkout", "payments", 50)
	allowedOlder.Spec.Target = "needle"
	outOfScopeExact := queryRelease("tenant-a", "needle", "billing", "payments", 900)
	unauthorizedPrefix := queryRelease("tenant-b", "needle-secret", "secret-app", "secret", 800)
	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects: []string{"alice"}, Actions: []string{string(auth.ActionRead)},
		Resources:  []string{string(auth.ResourceApplications), string(auth.ResourceReleases)},
		Namespaces: []string{"tenant-a"}, Projects: []string{"payments"},
	}})
	server := NewPaprikaServer(
		newPipelineTestClient(allowed, allowedOlder, outOfScopeExact, unauthorizedPrefix), nil,
		WithAuthorizer(authorizer), WithFleetIndex(index),
	)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	response, err := server.QueryReleases(
		ctx,
		connect.NewRequest(&paprikav1.QueryReleasesRequest{
			Filter: &paprikav1.FleetFilter{
				Clusters: []*paprikav1.FleetObjectKey{{Namespace: production.Namespace, Name: production.Name}},
				Stages:   []string{"production"},
			},
			Search: "needle", PageSize: 1, PageOffset: 1,
		}),
	)

	require.NoError(t, err)
	require.Equal(t, uint64(2), response.Msg.TotalCount)
	require.Equal(t, []string{"allowed-older"}, releaseNames(response.Msg.Releases))
}

func TestQueryReleasesFilteredReadDoesNotRequireWriteCapabilities(t *testing.T) {
	project := fleet.ProjectKey{Namespace: "tenant-a", Name: "payments"}
	cluster := fleet.ClusterKey{Namespace: "tenant-a", Name: "production"}
	index := fleet.NewIndex()
	installFleetAuthorizationSnapshot(t, index, []fleet.ApplicationSummary{{
		Identity: types.NamespacedName{Namespace: "tenant-a", Name: "checkout"},
		Project:  project,
		Targets:  []fleet.StageTargetSummary{{Stage: "production", Cluster: cluster}},
	}})
	backendErr := errors.New("write authorization backend unavailable")
	authorizer := &fleetScopeAuthorizer{
		authorized: []auth.ProjectRef{{Namespace: project.Namespace, Name: project.Name}},
		authorize: func(call fleetPermissionCall) error {
			if call.action == auth.ActionWrite {
				return backendErr
			}
			return nil
		},
	}
	server := NewPaprikaServer(
		newPipelineTestClient(queryRelease("tenant-a", "checkout-release", "checkout", "payments", 100)),
		nil,
		WithAuthorizer(authorizer),
		WithFleetIndex(index),
	)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	response, err := server.QueryReleases(
		ctx,
		connect.NewRequest(&paprikav1.QueryReleasesRequest{
			Filter: &paprikav1.FleetFilter{Stages: []string{"production"}},
		}),
	)

	require.NoError(t, err)
	require.Equal(t, uint64(1), response.Msg.TotalCount)
	require.Equal(t, []string{"checkout-release"}, releaseNames(response.Msg.Releases))
	writeCalls := 0
	for _, call := range authorizer.authorizeCalls {
		if call.action == auth.ActionWrite {
			writeCalls++
		}
	}
	require.Zero(t, writeCalls, "release reads must not evaluate write capabilities")
}

func TestQueryReleasesRequiresFleetIndexOnlyForActiveFilter(t *testing.T) {
	server := NewPaprikaServer(newPipelineTestClient(queryRelease("apps", "one", "app", "default", 1)), nil)

	response, err := server.QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{
			Filter: &paprikav1.FleetFilter{Stages: []string{"production"}},
		}),
	)

	require.Nil(t, response)
	require.Equal(t, connect.CodeUnavailable, connect.CodeOf(err))
}

func TestQueryReleasesReturnsCanceledWithoutPartialResults(t *testing.T) {
	base := newPipelineTestClient(queryRelease("apps", "one", "app", "default", 1))
	ctx, cancel := context.WithCancel(context.Background())
	server := NewPaprikaServer(&cancelAfterListClient{Client: base, cancel: cancel}, nil)

	response, err := server.QueryReleases(
		ctx,
		connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
	)

	require.Nil(t, response)
	require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
}

func TestQueryReleasesRequestsUnsafeDisableDeepCopyForReadOnlyList(t *testing.T) {
	client := &recordingListOptionsClient{
		Client: newPipelineTestClient(queryRelease("apps", "one", "app", "default", 1)),
	}
	server := NewPaprikaServer(client, nil)

	response, err := server.QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
	)

	require.NoError(t, err)
	require.Len(t, response.Msg.Releases, 1)
	require.True(t, client.unsafeDisableDeepCopy, "cache-backed clients should avoid copying immutable release records")
}

func TestImmutableReleaseListClientModelsCacheCopySemantics(t *testing.T) {
	source := queryRelease("apps", "one", "app", "default", 1)
	source.Annotations = map[string]string{"owner": "platform"}
	listClient := &immutableReleaseListClient{items: []pipelinesv1alpha1.Release{*source}}

	var first, second, safe pipelinesv1alpha1.ReleaseList
	require.NoError(t, listClient.List(context.Background(), &first, client.UnsafeDisableDeepCopy))
	require.NoError(t, listClient.List(context.Background(), &second, client.UnsafeDisableDeepCopy))
	require.NoError(t, listClient.List(context.Background(), &safe))

	require.NotSame(t, &listClient.items[0], &first.Items[0], "cache lists shallow-copy the typed object")
	require.NotSame(t, &first.Items[0], &second.Items[0], "each cache List materializes a fresh typed backing array")
	require.Equal(
		t,
		reflect.ValueOf(listClient.items[0].Labels).Pointer(),
		reflect.ValueOf(first.Items[0].Labels).Pointer(),
		"unsafe cache lists share nested metadata",
	)
	require.NotEqual(
		t,
		reflect.ValueOf(listClient.items[0].Labels).Pointer(),
		reflect.ValueOf(safe.Items[0].Labels).Pointer(),
		"safe cache lists deep-copy nested metadata",
	)

	before := listClient.items[0].DeepCopy()
	server := NewPaprikaServer(listClient, nil)
	response, err := server.QueryReleases(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
	)
	require.NoError(t, err)
	require.Equal(t, []string{"one"}, releaseNames(response.Msg.Releases))
	require.Equal(t, before, &listClient.items[0], "QueryReleases must not mutate cache-owned data")
}

func TestQueryReleasesReturnsCanceledWhenListCancelsWithNoItems(t *testing.T) {
	base := newPipelineTestClient()
	ctx, cancel := context.WithCancel(context.Background())
	server := NewPaprikaServer(&cancelAfterListClient{Client: base, cancel: cancel}, nil)

	response, err := server.QueryReleases(
		ctx,
		connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
	)

	require.Nil(t, response)
	require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
}

func TestQueryReleasesReturnsCanceledAfterFinalAuthorization(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	server := NewPaprikaServer(
		newPipelineTestClient(queryRelease("apps", "one", "app", "default", 1)), nil,
		WithAuthorizer(&cancelingReleaseAuthorizer{cancel: cancel}),
	)
	ctx = auth.WithPrincipal(ctx, &auth.Principal{Subject: "alice"})

	response, err := server.QueryReleases(
		ctx,
		connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
	)

	require.Nil(t, response)
	require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
}

func TestQueryReleasesMapsListErrorsToConnectCodes(t *testing.T) {
	tests := []struct {
		err  error
		code connect.Code
	}{
		{err: context.Canceled, code: connect.CodeCanceled},
		{err: context.DeadlineExceeded, code: connect.CodeDeadlineExceeded},
		{err: errors.New("cache unavailable"), code: connect.CodeInternal},
	}
	for _, test := range tests {
		server := NewPaprikaServer(&listErrorClient{err: test.err}, nil)

		response, err := server.QueryReleases(
			context.Background(),
			connect.NewRequest(&paprikav1.QueryReleasesRequest{}),
		)

		require.Nil(t, response)
		require.Equal(t, test.code, connect.CodeOf(err))
	}
}

func BenchmarkQueryReleasesSearch10k(b *testing.B) {
	releases := make([]pipelinesv1alpha1.Release, 0, 10_000)
	for i := range 10_000 {
		releases = append(releases, *queryRelease(
			"apps",
			fmt.Sprintf("release-%05d", i),
			"checkout",
			"default",
			int64(i),
		))
	}
	listClient := &immutableReleaseListClient{items: releases}
	server := NewPaprikaServer(
		listClient, nil,
		WithAuthorizer(&auth.AllowAllAuthorizer{}),
	)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "benchmark"})
	request := connect.NewRequest(&paprikav1.QueryReleasesRequest{
		Search: "release-05000", PageSize: 8,
	})

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		response, err := server.QueryReleases(ctx, request)
		if err != nil {
			b.Fatal(err)
		}
		if response.Msg.TotalCount != 1 {
			b.Fatalf("total_count = %d; want 1", response.Msg.TotalCount)
		}
		if got := releaseIdentities(response.Msg.Releases); len(got) != 1 || got[0] != "apps/release-05000" {
			b.Fatalf("release identities = %v; want [apps/release-05000]", got)
		}
	}
	if listClient.unsafeListCalls != b.N {
		b.Fatalf("unsafe list calls = %d; want %d", listClient.unsafeListCalls, b.N)
	}
}

type cancelAfterListClient struct {
	client.Client
	cancel context.CancelFunc
}

type recordingListOptionsClient struct {
	client.Client
	unsafeDisableDeepCopy bool
}

// immutableReleaseListClient models the informer-cache fast path: every List
// materializes a fresh typed slice, while UnsafeDisableDeepCopy shallow-copies
// objects so their nested data remains cache-owned and shared.
type immutableReleaseListClient struct {
	client.Client
	items           []pipelinesv1alpha1.Release
	unsafeListCalls int
}

func (c *immutableReleaseListClient) List(
	ctx context.Context,
	list client.ObjectList,
	opts ...client.ListOption,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, ok := list.(*pipelinesv1alpha1.ReleaseList)
	if !ok {
		return fmt.Errorf("unsupported immutable list type %T", list)
	}
	options := &client.ListOptions{}
	for _, option := range opts {
		option.ApplyToList(options)
	}
	unsafe := options.UnsafeDisableDeepCopy != nil && *options.UnsafeDisableDeepCopy
	if unsafe {
		c.unsafeListCalls++
	}
	objects := make([]runtime.Object, 0, len(c.items))
	for i := range c.items {
		var object runtime.Object = &c.items[i]
		if !unsafe {
			object = object.DeepCopyObject()
		}
		objects = append(objects, object)
	}
	return apimeta.SetList(list, objects)
}

func (c *recordingListOptionsClient) List(
	ctx context.Context,
	list client.ObjectList,
	opts ...client.ListOption,
) error {
	options := &client.ListOptions{}
	for _, option := range opts {
		option.ApplyToList(options)
	}
	c.unsafeDisableDeepCopy = options.UnsafeDisableDeepCopy != nil && *options.UnsafeDisableDeepCopy
	return c.Client.List(ctx, list, opts...)
}

func (c *cancelAfterListClient) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	err := c.Client.List(ctx, list, opts...)
	c.cancel()
	return err
}

type cancelingReleaseAuthorizer struct {
	cancel context.CancelFunc
}

func (a *cancelingReleaseAuthorizer) Authorize(
	context.Context,
	*auth.Principal,
	auth.Action,
	auth.Resource,
	string,
	string,
) error {
	a.cancel()
	return nil
}

func (*cancelingReleaseAuthorizer) AuthorizedProjects(
	context.Context,
	*auth.Principal,
	auth.Action,
	auth.Resource,
	[]auth.ProjectRef,
) ([]auth.ProjectRef, error) {
	return nil, nil
}

type listErrorClient struct {
	client.Client
	err error
}

func (c *listErrorClient) List(context.Context, client.ObjectList, ...client.ListOption) error {
	return c.err
}

func queryRelease(namespace, name, application, project string, created int64) *pipelinesv1alpha1.Release {
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace,
			Name:      name,
			Labels: map[string]string{
				engine.ApplicationNameLabelKey: application,
				projectLabelKey:                project,
			},
			CreationTimestamp: metav1.NewTime(time.Unix(created, 0)),
		},
	}
}

func releaseNames(releases []*paprikav1.Release) []string {
	names := make([]string, 0, len(releases))
	for _, release := range releases {
		names = append(names, release.Name)
	}
	return names
}

func releaseIdentities(releases []*paprikav1.Release) []string {
	identities := make([]string, 0, len(releases))
	for _, release := range releases {
		identities = append(identities, release.Namespace+"/"+release.Name)
	}
	return identities
}

func requireAPIListErrorMetric(t *testing.T, reader *sdkmetric.ManualReader, resource string, want int64) {
	t.Helper()
	var collected metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(context.Background(), &collected))
	for _, scopeMetrics := range collected.ScopeMetrics {
		for _, measured := range scopeMetrics.Metrics {
			if measured.Name != "paprika.api.list.errors" {
				continue
			}
			sum, ok := measured.Data.(metricdata.Sum[int64])
			require.True(t, ok)
			for _, point := range sum.DataPoints {
				value, found := point.Attributes.Value(attribute.Key("resource"))
				if found && value.AsString() == resource {
					require.Equal(t, want, point.Value)
					return
				}
			}
		}
	}
	t.Fatalf("missing paprika.api.list.errors data point for resource %q", resource)
}
