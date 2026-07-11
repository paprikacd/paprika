package apiserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestFleetValidation(t *testing.T) {
	tests := []struct {
		name     string
		wantCode connect.Code
		call     func(*testing.T, *PaprikaServer) error
	}{
		{
			name:     "applications defaults page size zero to 100 and accepts empty cursor",
			wantCode: connect.CodeUnavailable,
			call: func(t *testing.T, server *PaprikaServer) error {
				msg := &paprikav1.QueryApplicationsRequest{}
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(msg))
				require.Equal(t, uint32(100), msg.PageSize)
				return err
			},
		},
		{
			name:     "applications accepts non-empty opaque cursor",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					PageSize: 25,
					Cursor:   "opaque:not-decoded-in-task-one",
				}))
				return err
			},
		},
		{
			name:     "applications accepts page size 500",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{PageSize: 500}))
				return err
			},
		},
		{
			name:     "applications rejects page size 501",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{PageSize: 501}))
				return err
			},
		},
		{
			name:     "applications accepts 128 Unicode runes",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Search: strings.Repeat("界", 128),
				}))
				return err
			},
		},
		{
			name:     "applications rejects 129 Unicode runes",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Search: strings.Repeat("界", 129),
				}))
				return err
			},
		},
		{
			name:     "applications accepts concrete sort and direction",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Sort:      paprikav1.FleetSortField_FLEET_SORT_FIELD_RELEVANCE,
					Direction: paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_DESC,
				}))
				return err
			},
		},
		{
			name:     "applications rejects unknown sort",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Sort: paprikav1.FleetSortField(99),
				}))
				return err
			},
		},
		{
			name:     "applications rejects unknown direction",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Direction: paprikav1.FleetSortDirection(99),
				}))
				return err
			},
		},
		{
			name:     "map accepts unspecified defaults",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{}))
				return err
			},
		},
		{
			name:     "map accepts concrete group and size metric",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
					Group:      paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_HEALTH,
					SizeMetric: paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_REQUEST_RATE,
				}))
				return err
			},
		},
		{
			name:     "map rejects unknown group",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
					Group: paprikav1.FleetGroupDimension(99),
				}))
				return err
			},
		},
		{
			name:     "map rejects unknown size metric",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
					SizeMetric: paprikav1.FleetSizeMetric(99),
				}))
				return err
			},
		},
		{
			name:     "map rejects 129 Unicode runes",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
					Search: strings.Repeat("界", 129),
				}))
				return err
			},
		},
		{
			name:     "matrix accepts distinct concrete axes and unspecified size",
			wantCode: connect.CodeUnavailable,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
					ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
				}))
				return err
			},
		},
		{
			name:     "matrix rejects equal axes",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_STAGE,
					ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_STAGE,
				}))
				return err
			},
		},
		{
			name:     "matrix rejects unspecified row axis",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
				}))
				return err
			},
		},
		{
			name:     "matrix rejects unspecified column axis",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					RowGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
				}))
				return err
			},
		},
		{
			name:     "matrix rejects unknown row axis",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					RowGroup:    paprikav1.FleetGroupDimension(99),
					ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
				}))
				return err
			},
		},
		{
			name:     "matrix rejects unknown column axis",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
					ColumnGroup: paprikav1.FleetGroupDimension(99),
				}))
				return err
			},
		},
		{
			name:     "matrix rejects unknown size metric",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
					ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
					SizeMetric:  paprikav1.FleetSizeMetric(99),
				}))
				return err
			},
		},
		{
			name:     "matrix rejects 129 Unicode runes",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
					Search:      strings.Repeat("界", 129),
					RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
					ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
				}))
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.call(t, &PaprikaServer{})
			require.Error(t, err)
			require.Equal(t, test.wantCode, connect.CodeOf(err))
		})
	}
}

func TestFleetFilterValidation(t *testing.T) {
	type filterDimension struct {
		name       string
		descriptor protoreflect.EnumDescriptor
		filter     func(protoreflect.EnumNumber) *paprikav1.FleetFilter
	}

	dimensions := []filterDimension{
		{
			name:       "health",
			descriptor: paprikav1.FleetHealth(0).Descriptor(),
			filter: func(number protoreflect.EnumNumber) *paprikav1.FleetFilter {
				return &paprikav1.FleetFilter{Health: []paprikav1.FleetHealth{paprikav1.FleetHealth(number)}}
			},
		},
		{
			name:       "sync",
			descriptor: paprikav1.FleetSyncState(0).Descriptor(),
			filter: func(number protoreflect.EnumNumber) *paprikav1.FleetFilter {
				return &paprikav1.FleetFilter{Sync: []paprikav1.FleetSyncState{paprikav1.FleetSyncState(number)}}
			},
		},
		{
			name:       "release_state",
			descriptor: paprikav1.FleetReleaseState(0).Descriptor(),
			filter: func(number protoreflect.EnumNumber) *paprikav1.FleetFilter {
				return &paprikav1.FleetFilter{ReleaseStates: []paprikav1.FleetReleaseState{paprikav1.FleetReleaseState(number)}}
			},
		},
		{
			name:       "rollout_state",
			descriptor: paprikav1.FleetRolloutState(0).Descriptor(),
			filter: func(number protoreflect.EnumNumber) *paprikav1.FleetFilter {
				return &paprikav1.FleetFilter{RolloutStates: []paprikav1.FleetRolloutState{paprikav1.FleetRolloutState(number)}}
			},
		},
		{
			name:       "source_type",
			descriptor: paprikav1.FleetSourceType(0).Descriptor(),
			filter: func(number protoreflect.EnumNumber) *paprikav1.FleetFilter {
				return &paprikav1.FleetFilter{SourceTypes: []paprikav1.FleetSourceType{paprikav1.FleetSourceType(number)}}
			},
		},
	}

	server := &PaprikaServer{}
	assertFilterCode := func(t *testing.T, filter *paprikav1.FleetFilter, wantCode connect.Code) {
		t.Helper()
		_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{Filter: filter}))
		require.Error(t, err)
		require.Equal(t, wantCode, connect.CodeOf(err))
	}

	for _, dimension := range dimensions {
		t.Run(dimension.name, func(t *testing.T) {
			values := dimension.descriptor.Values()
			maxNumber := protoreflect.EnumNumber(0)
			concreteCount := 0
			for i := 0; i < values.Len(); i++ {
				value := values.Get(i)
				if value.Number() > maxNumber {
					maxNumber = value.Number()
				}
				if value.Number() == 0 {
					continue
				}
				concreteCount++
				t.Run("accepts_"+string(value.Name()), func(t *testing.T) {
					assertFilterCode(t, dimension.filter(value.Number()), connect.CodeUnavailable)
				})
			}
			require.Positive(t, concreteCount, "enum %s must define concrete filter values", dimension.descriptor.FullName())

			t.Run("rejects_unspecified", func(t *testing.T) {
				assertFilterCode(t, dimension.filter(0), connect.CodeInvalidArgument)
			})

			unknown := maxNumber + 1
			require.Nil(t, values.ByNumber(unknown), "probe value must be outside the enum descriptor range")
			t.Run(fmt.Sprintf("rejects_unknown_%d", unknown), func(t *testing.T) {
				assertFilterCode(t, dimension.filter(unknown), connect.CodeInvalidArgument)
			})
		})
	}
}

func TestQueryApplicationsServesConvertedFleetPage(t *testing.T) {
	t.Parallel()

	project := types.NamespacedName{Namespace: "apps", Name: "retail"}
	cluster := types.NamespacedName{Namespace: "apps", Name: "prod"}
	application := types.NamespacedName{Namespace: "apps", Name: "checkout"}
	repository := types.NamespacedName{Namespace: "apps", Name: "source"}
	observability := types.NamespacedName{Namespace: "apps", Name: "prometheus"}
	reader := &recordingFleetReader{
		projects: []fleet.ProjectKey{project},
		applicationPage: fleet.ApplicationPage{
			Applications: []fleet.ApplicationQueryResult{{
				Summary: fleet.ApplicationSummary{
					Identity: application,
					Project:  project,
					Targets: []fleet.StageTargetSummary{{
						StableID: "target-1", Stage: "production", Ring: 2,
						Cluster: cluster, ClusterLabel: "Production", Health: fleet.HealthHealthy,
						ClusterConnection: fleet.ConnectionStateHealthy,
					}},
					CurrentStage: "production", CurrentCluster: cluster, CurrentClusterLabel: "Production",
					SourceType: fleet.SourceTypeGit, SourceRevision: "abc123", Health: fleet.HealthHealthy,
					Sync: fleet.SyncStateOutOfSync, DriftCount: 3, MissingResourceCount: 1,
					ReleaseState: fleet.ReleaseStateVerifying, RolloutState: fleet.RolloutStateProgressing,
					ResourceCount: 12, Repository: repository, RepositoryConnection: fleet.ConnectionStateHealthy,
					EffectiveObservabilitySource: observability,
					ObservabilityConnection:      fleet.ConnectionStateUnhealthy,
					BlockedGateCount:             2,
					LastTransitionUnixMS:         123456,
				},
				Capabilities: []fleet.Capability{
					fleet.CapabilityApplicationSync,
					fleet.CapabilityReleaseRollback,
					fleet.CapabilityGateApprove,
					fleet.CapabilityPipelineRetry,
				},
			}},
			Total: 1, NextCursor: "next", Generation: 42,
			Facets: []fleet.FacetBucket{
				{Dimension: fleet.FacetDimensionProject, Object: project, Label: "retail", Count: 1},
				{Dimension: fleet.FacetDimensionHealth, Value: "healthy", Label: "healthy", Count: 1},
			},
		},
	}
	server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))

	response, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
		Filter: &paprikav1.FleetFilter{
			Projects:      []*paprikav1.FleetObjectKey{{Namespace: project.Namespace, Name: project.Name}},
			Namespaces:    []string{"apps"},
			Clusters:      []*paprikav1.FleetObjectKey{{Namespace: cluster.Namespace, Name: cluster.Name}},
			Stages:        []string{"production"},
			Health:        []paprikav1.FleetHealth{paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY},
			Sync:          []paprikav1.FleetSyncState{paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC},
			ReleaseStates: []paprikav1.FleetReleaseState{paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_VERIFYING},
			RolloutStates: []paprikav1.FleetRolloutState{paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PROGRESSING},
			SourceTypes:   []paprikav1.FleetSourceType{paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT},
		},
		Search: "checkout", Sort: paprikav1.FleetSortField_FLEET_SORT_FIELD_IMPACT,
		Direction: paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_DESC,
		PageSize:  25, Cursor: "cursor",
	}))
	require.NoError(t, err)
	require.Equal(t, fleet.ApplicationQuery{
		Filter: fleet.ApplicationFilter{
			Projects: []fleet.ProjectKey{project}, Namespaces: []string{"apps"},
			Clusters: []fleet.ClusterKey{cluster}, Stages: []string{"production"},
			Health: []fleet.Health{fleet.HealthHealthy}, Sync: []fleet.SyncState{fleet.SyncStateOutOfSync},
			ReleaseStates: []fleet.ReleaseState{fleet.ReleaseStateVerifying},
			RolloutStates: []fleet.RolloutState{fleet.RolloutStateProgressing},
			SourceTypes:   []fleet.SourceType{fleet.SourceTypeGit},
		},
		Search: "checkout", Sort: fleet.SortFieldImpact, Direction: fleet.SortDirectionDesc, PageSize: 25,
	}, reader.applicationQuery)
	require.Equal(t, "cursor", reader.cursor)
	require.Equal(t, uint64(42), response.Msg.IndexGeneration)
	require.Equal(t, uint64(1), response.Msg.Total)
	require.Equal(t, "next", response.Msg.NextCursor)
	require.Len(t, response.Msg.Applications, 1)
	converted := response.Msg.Applications[0]
	require.Equal(t, &paprikav1.FleetObjectKey{Namespace: "apps", Name: "checkout"}, converted.Identity)
	require.Equal(t, paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY, converted.Health)
	require.Equal(t, paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC, converted.Sync)
	require.Equal(t, paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_VERIFYING, converted.ReleaseState)
	require.Equal(t, paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PROGRESSING, converted.RolloutState)
	require.Equal(t, paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_UNHEALTHY, converted.ObservabilityConnection)
	require.Len(t, converted.Targets, 1)
	require.Equal(t, paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_HEALTHY, converted.Targets[0].ClusterConnection)
	require.Equal(t, []paprikav1.FleetCapability{
		paprikav1.FleetCapability_FLEET_CAPABILITY_APPLICATION_SYNC,
		paprikav1.FleetCapability_FLEET_CAPABILITY_RELEASE_ROLLBACK,
		paprikav1.FleetCapability_FLEET_CAPABILITY_GATE_APPROVE,
		paprikav1.FleetCapability_FLEET_CAPABILITY_PIPELINE_RETRY,
	}, converted.Capabilities)
	require.Len(t, response.Msg.Facets, 2)
	require.Equal(t, project.Name, response.Msg.Facets[0].GetObject().Name)
	require.Equal(t, "healthy", response.Msg.Facets[1].GetValue())
	require.Zero(t, reader.checkReadyCalls)
}

func TestQueryFleetMapServesConvertedAggregationWithDefaults(t *testing.T) {
	t.Parallel()

	project := types.NamespacedName{Namespace: "apps", Name: "retail"}
	application := types.NamespacedName{Namespace: "apps", Name: "checkout"}
	reader := &recordingFleetReader{
		projects: []fleet.ProjectKey{project},
		mapResult: fleet.FleetMap{
			Roots: []fleet.FleetMapNode{{
				StableID: "project/apps/retail", Kind: fleet.FleetMapNodeKindGroup,
				Label: "retail", GroupObject: project, ApplicationCount: 1, TargetCount: 2,
				Health:         []fleet.HealthBucket{{Health: fleet.HealthDegraded, Count: 1}},
				ResourceWeight: 12, RequestRateWeight: 4.5, EffectiveWeight: 12,
				UsedResourceFallback: true,
				Children: []fleet.FleetMapNode{{
					StableID: "application/apps/checkout", Kind: fleet.FleetMapNodeKindApplication,
					Label: "checkout", Application: application, GroupValue: "degraded",
					ApplicationCount: 1, TargetCount: 2, ResourceWeight: 12,
					RequestRateWeight: 4.5, EffectiveWeight: 12, UsedResourceFallback: true,
				}},
			}},
			Total: 1, Generation: 73,
		},
	}
	server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))

	response, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{
		Filter: &paprikav1.FleetFilter{Namespaces: []string{"apps"}}, Search: "checkout",
	}))
	require.NoError(t, err)
	require.Equal(t, []string{"apps"}, reader.mapQuery.Filter.Namespaces)
	require.Equal(t, "checkout", reader.mapQuery.Search)
	require.Equal(t, fleet.GroupDimensionProject, reader.mapQuery.Group)
	require.Equal(t, fleet.SizeMetricResourceCount, reader.mapQuery.SizeMetric)
	require.Equal(t, uint64(73), response.Msg.IndexGeneration)
	require.Equal(t, uint64(1), response.Msg.Total)
	require.Len(t, response.Msg.Roots, 1)
	root := response.Msg.Roots[0]
	require.Equal(t, paprikav1.FleetMapNodeKind_FLEET_MAP_NODE_KIND_GROUP, root.Kind)
	require.Equal(t, project.Name, root.GetGroupObject().Name)
	require.Equal(t, paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED, root.Health[0].Health)
	require.Equal(t, 4.5, root.RequestRateWeight)
	require.Equal(t, float64(12), root.EffectiveWeight)
	require.True(t, root.UsedResourceFallback)
	require.Len(t, root.Children, 1)
	require.Equal(t, application.Name, root.Children[0].Application.Name)
	require.Equal(t, "degraded", root.Children[0].GetGroupValue())
	require.Zero(t, reader.checkReadyCalls)
}

func TestQueryFleetMatrixServesConvertedAggregationWithDefaults(t *testing.T) {
	t.Parallel()

	project := types.NamespacedName{Namespace: "apps", Name: "retail"}
	reader := &recordingFleetReader{
		projects: []fleet.ProjectKey{project},
		matrixResult: fleet.FleetMatrix{
			Rows:    []fleet.FleetMatrixHeader{{StableID: "project/apps/retail", Label: "retail", Object: project}},
			Columns: []fleet.FleetMatrixHeader{{StableID: "stage/production", Label: "production", Value: "production"}},
			Cells: []fleet.FleetMatrixCell{{
				RowID: "project/apps/retail", ColumnID: "stage/production",
				ApplicationCount: 1, TargetCount: 2,
				Health:         []fleet.HealthBucket{{Health: fleet.HealthProgressing, Count: 2}},
				ResourceWeight: 18, RequestRateWeight: 7.25, UsedResourceFallback: true,
			}},
			Total: 1, Generation: 81,
		},
	}
	server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))

	response, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
		Filter:      &paprikav1.FleetFilter{Projects: []*paprikav1.FleetObjectKey{{Namespace: "apps", Name: "retail"}}},
		Search:      "checkout",
		RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
		ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_STAGE,
	}))
	require.NoError(t, err)
	require.Equal(t, []fleet.ProjectKey{project}, reader.matrixQuery.Filter.Projects)
	require.Equal(t, "checkout", reader.matrixQuery.Search)
	require.Equal(t, fleet.GroupDimensionProject, reader.matrixQuery.RowGroup)
	require.Equal(t, fleet.GroupDimensionStage, reader.matrixQuery.ColumnGroup)
	require.Equal(t, fleet.SizeMetricResourceCount, reader.matrixQuery.SizeMetric)
	require.Equal(t, uint64(81), response.Msg.IndexGeneration)
	require.Equal(t, uint64(1), response.Msg.Total)
	require.Equal(t, project.Name, response.Msg.Rows[0].GetObject().Name)
	require.Equal(t, "production", response.Msg.Columns[0].GetValue())
	require.Equal(t, paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING, response.Msg.Cells[0].Health[0].Health)
	require.Equal(t, 7.25, response.Msg.Cells[0].RequestRateWeight)
	require.True(t, response.Msg.Cells[0].UsedResourceFallback)
	require.Zero(t, reader.checkReadyCalls)
}

func TestQueryApplicationsDefaultsAndReturnsValidEmptyGeneration(t *testing.T) {
	t.Parallel()

	reader := &recordingFleetReader{applicationPage: fleet.ApplicationPage{Generation: 9}}
	server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))
	request := &paprikav1.QueryApplicationsRequest{}

	response, err := server.QueryApplications(context.Background(), connect.NewRequest(request))
	require.NoError(t, err)
	require.Equal(t, uint32(100), request.PageSize)
	require.Equal(t, fleet.SortFieldName, reader.applicationQuery.Sort)
	require.Equal(t, fleet.SortDirectionAsc, reader.applicationQuery.Direction)
	require.Equal(t, uint64(9), response.Msg.IndexGeneration)
	require.Empty(t, response.Msg.Applications)
	require.Empty(t, response.Msg.Facets)

	_, err = server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{Search: "checkout"}))
	require.NoError(t, err)
	require.Equal(t, fleet.SortFieldRelevance, reader.applicationQuery.Sort)
	require.Zero(t, reader.checkReadyCalls)
}

func TestQueryFleetAuthorizationIsolation(t *testing.T) {
	t.Parallel()

	authorizedProject := fleet.ProjectKey{Namespace: "tenant-a", Name: "payments"}
	unauthorizedProject := fleet.ProjectKey{Namespace: "tenant-b", Name: "payments"}
	authorizedApplication := types.NamespacedName{Namespace: "tenant-a", Name: "checkout"}
	unauthorizedApplication := types.NamespacedName{Namespace: "tenant-b", Name: "checkout"}
	authorizedCluster := fleet.ClusterKey{Namespace: "tenant-a", Name: "production"}
	unauthorizedCluster := fleet.ClusterKey{Namespace: "tenant-b", Name: "production"}

	index := fleet.NewIndex()
	installFleetAuthorizationSnapshot(t, index, []fleet.ApplicationSummary{
		{
			Identity: authorizedApplication,
			Project:  authorizedProject,
			Targets: []fleet.StageTargetSummary{{
				StableID: "authorized-target", Stage: "production", Cluster: authorizedCluster,
				ClusterLabel: "Authorized production", Health: fleet.HealthHealthy,
			}},
			CurrentStage: "production", CurrentCluster: authorizedCluster,
			SourceType: fleet.SourceTypeGit, Health: fleet.HealthHealthy, Sync: fleet.SyncStateSynced,
			ReleaseState: fleet.ReleaseStateComplete, RolloutState: fleet.RolloutStateHealthy,
			ResourceCount: 10,
		},
		{
			Identity: unauthorizedApplication,
			Project:  unauthorizedProject,
			Targets: []fleet.StageTargetSummary{{
				StableID: "unauthorized-target", Stage: "canary", Cluster: unauthorizedCluster,
				ClusterLabel: "Unauthorized production", Health: fleet.HealthFailed,
			}},
			CurrentStage: "canary", CurrentCluster: unauthorizedCluster,
			SourceType: fleet.SourceTypeOCI, Health: fleet.HealthFailed, Sync: fleet.SyncStateOutOfSync,
			ReleaseState: fleet.ReleaseStateFailed, RolloutState: fleet.RolloutStateFailed,
			ResourceCount: 999,
		},
	})

	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{string(auth.ActionRead)},
		Resources:  []string{string(auth.ResourceApplications)},
		Namespaces: []string{authorizedProject.Namespace},
		Projects:   []string{authorizedProject.Name},
	}})
	server := NewPaprikaServer(nil, nil, WithAuthorizer(authorizer), WithFleetIndex(index))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	applications, err := server.QueryApplications(
		ctx,
		connect.NewRequest(&paprikav1.QueryApplicationsRequest{}),
	)
	require.NoError(t, err)
	require.Equal(t, uint64(42), applications.Msg.IndexGeneration)
	require.Equal(t, uint64(1), applications.Msg.Total)
	require.Len(t, applications.Msg.Applications, 1)
	require.Equal(t, authorizedApplication.Namespace, applications.Msg.Applications[0].Identity.Namespace)
	require.Equal(t, authorizedApplication.Name, applications.Msg.Applications[0].Identity.Name)
	require.NotEmpty(t, applications.Msg.Facets)
	for _, bucket := range applications.Msg.Facets {
		require.Equal(t, uint64(1), bucket.Count)
		if object := bucket.GetObject(); object != nil {
			require.NotEqual(t, unauthorizedProject.Namespace, object.Namespace)
		}
		require.NotContains(t, []string{"tenant-b", "canary", "failed", "out-of-sync", "oci"}, bucket.GetValue())
	}

	mapResponse, err := server.QueryFleetMap(
		ctx,
		connect.NewRequest(&paprikav1.QueryFleetMapRequest{}),
	)
	require.NoError(t, err)
	require.Equal(t, uint64(42), mapResponse.Msg.IndexGeneration)
	require.Equal(t, uint64(1), mapResponse.Msg.Total)
	require.Len(t, mapResponse.Msg.Roots, 1)
	require.Equal(t, authorizedProject.Namespace, mapResponse.Msg.Roots[0].GetGroupObject().Namespace)
	require.Equal(t, uint64(1), mapResponse.Msg.Roots[0].ApplicationCount)
	require.Len(t, mapResponse.Msg.Roots[0].Children, 1)

	matrixResponse, err := server.QueryFleetMatrix(
		ctx,
		connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
			RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
			ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_HEALTH,
		}),
	)
	require.NoError(t, err)
	require.Equal(t, uint64(42), matrixResponse.Msg.IndexGeneration)
	require.Equal(t, uint64(1), matrixResponse.Msg.Total)
	require.Len(t, matrixResponse.Msg.Rows, 1)
	require.Len(t, matrixResponse.Msg.Columns, 1)
	require.Len(t, matrixResponse.Msg.Cells, 1)
	require.Equal(t, authorizedProject.Namespace, matrixResponse.Msg.Rows[0].GetObject().Namespace)
	require.Equal(t, "healthy", matrixResponse.Msg.Columns[0].GetValue())
	require.Equal(t, uint64(1), matrixResponse.Msg.Cells[0].ApplicationCount)
}

func TestFleetQueryErrorMapping(t *testing.T) {
	t.Parallel()

	t.Run("reader connect errors are sanitized", func(t *testing.T) {
		const secret = "reader backend token=super-secret"
		reader := &recordingFleetReader{
			applicationErr: connect.NewError(connect.CodeUnavailable, errors.New(secret)),
		}
		server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))

		_, err := server.QueryApplications(
			context.Background(),
			connect.NewRequest(&paprikav1.QueryApplicationsRequest{}),
		)
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		require.NotContains(t, err.Error(), secret)
	})

	t.Run("authorizer connect errors are sanitized", func(t *testing.T) {
		const secret = "authorization backend password=super-secret"
		project := fleet.ProjectKey{Namespace: "tenant-a", Name: "payments"}
		reader := &recordingFleetReader{projects: []fleet.ProjectKey{project}}
		authorizer := &fleetScopeAuthorizer{
			authorizedErr: connect.NewError(connect.CodeUnavailable, errors.New(secret)),
		}
		server := NewPaprikaServer(nil, nil, WithAuthorizer(authorizer), WithFleetIndex(reader))
		ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

		_, err := server.QueryApplications(
			ctx,
			connect.NewRequest(&paprikav1.QueryApplicationsRequest{}),
		)
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		require.NotContains(t, err.Error(), secret)
	})

	t.Run("invalid cursor is an invalid argument", func(t *testing.T) {
		reader := &recordingFleetReader{applicationErr: &fleet.ErrInvalidCursor{Reason: fleet.InvalidCursorMalformed}}
		server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))
		_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{}))
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		require.NotContains(t, err.Error(), string(fleet.InvalidCursorMalformed))
	})

	t.Run("invalid search is an invalid argument", func(t *testing.T) {
		reader := &recordingFleetReader{applicationErr: &fleet.InvalidSearchError{RuneCount: 7, Maximum: 3}}
		server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))
		_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{}))
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("typed matrix axes error is an invalid argument", func(t *testing.T) {
		reader := &recordingFleetReader{matrixErr: &fleet.ErrInvalidMatrixAxes{Row: fleet.GroupDimensionProject, Column: fleet.GroupDimensionCluster}}
		server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))
		_, err := server.QueryFleetMatrix(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{
			RowGroup:    paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
			ColumnGroup: paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
		}))
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("unavailable reader exposes only its safe reason", func(t *testing.T) {
		server := NewPaprikaServer(nil, nil, WithFleetIndex(fleet.NewUnavailableReader("fleet cache is warming")))
		_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{}))
		require.Equal(t, connect.CodeUnavailable, connect.CodeOf(err))
		require.Contains(t, err.Error(), "fleet cache is warming")
	})

	t.Run("unknown errors are sanitized", func(t *testing.T) {
		reader := &recordingFleetReader{applicationErr: errors.New("backend secret token must not escape")}
		server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))
		_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{}))
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		require.NotContains(t, err.Error(), "secret token")
	})
}

type recordingFleetReader struct {
	projects         []fleet.ProjectKey
	applicationPage  fleet.ApplicationPage
	mapResult        fleet.FleetMap
	matrixResult     fleet.FleetMatrix
	applicationQuery fleet.ApplicationQuery
	cursor           string
	mapQuery         fleet.FleetMapQuery
	matrixQuery      fleet.FleetMatrixQuery
	applicationErr   error
	mapErr           error
	matrixErr        error
	checkReadyCalls  int
}

func (r *recordingFleetReader) ProjectKeys(context.Context, []string) ([]fleet.ProjectKey, error) {
	return append([]fleet.ProjectKey(nil), r.projects...), nil
}

func (r *recordingFleetReader) QueryApplications(
	_ context.Context,
	_ fleet.QueryScope,
	query fleet.ApplicationQuery,
	cursor string,
) (fleet.ApplicationPage, error) {
	r.applicationQuery = query
	r.cursor = cursor
	return r.applicationPage, r.applicationErr
}

func (r *recordingFleetReader) QueryMap(
	_ context.Context,
	_ fleet.QueryScope,
	query fleet.FleetMapQuery,
) (fleet.FleetMap, error) {
	r.mapQuery = query
	return r.mapResult, r.mapErr
}

func (r *recordingFleetReader) QueryMatrix(
	_ context.Context,
	_ fleet.QueryScope,
	query fleet.FleetMatrixQuery,
) (fleet.FleetMatrix, error) {
	r.matrixQuery = query
	return r.matrixResult, r.matrixErr
}

func (*recordingFleetReader) LoadSnapshot() (*fleet.Snapshot, error) { return nil, nil }

func (r *recordingFleetReader) CheckReady() error {
	r.checkReadyCalls++
	return nil
}

func installFleetAuthorizationSnapshot(
	t *testing.T,
	index *fleet.Index,
	applications []fleet.ApplicationSummary,
) {
	t.Helper()

	snapshot := fleet.NewSnapshot(42)
	for i := range applications {
		summary := applications[i]
		snapshot.Applications[summary.Identity] = summary
		snapshot.Projects[summary.Project] = fleet.ProjectSummary{Identity: summary.Project}
		addFleetTestPosting(snapshot.ByProject, summary.Project, summary.Identity)
		addFleetTestPosting(snapshot.ByNamespace, summary.Identity.Namespace, summary.Identity)
		addFleetTestPosting(snapshot.ByHealth, summary.Health, summary.Identity)
		addFleetTestPosting(snapshot.BySync, summary.Sync, summary.Identity)
		addFleetTestPosting(snapshot.ByRelease, summary.ReleaseState, summary.Identity)
		addFleetTestPosting(snapshot.ByRollout, summary.RolloutState, summary.Identity)
		addFleetTestPosting(snapshot.BySourceType, summary.SourceType, summary.Identity)
		for j := range summary.Targets {
			target := summary.Targets[j]
			addFleetTestPosting(snapshot.ByStage, target.Stage, summary.Identity)
			if target.Cluster != (fleet.ClusterKey{}) {
				addFleetTestPosting(snapshot.ByCluster, target.Cluster, summary.Identity)
				snapshot.Clusters[target.Cluster] = fleet.ClusterSummary{
					Identity: target.Cluster, DisplayName: target.ClusterLabel,
				}
			}
		}
	}
	require.NoError(t, index.Install(snapshot))
}

func addFleetTestPosting[K comparable](
	index map[K]fleet.IDSet,
	key K,
	application types.NamespacedName,
) {
	if index[key] == nil {
		index[key] = make(fleet.IDSet)
	}
	index[key][application] = struct{}{}
}
