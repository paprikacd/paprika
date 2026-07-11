package apiserver

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func TestFleetValidation(t *testing.T) {
	tests := []struct {
		name     string
		wantCode connect.Code
		call     func(*testing.T, *PaprikaServer) error
	}{
		{
			name:     "applications defaults page size zero to 100 and accepts empty cursor",
			wantCode: connect.CodeUnimplemented,
			call: func(t *testing.T, server *PaprikaServer) error {
				msg := &paprikav1.QueryApplicationsRequest{}
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(msg))
				require.Equal(t, uint32(100), msg.PageSize)
				return err
			},
		},
		{
			name:     "applications accepts non-empty opaque cursor",
			wantCode: connect.CodeUnimplemented,
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
			wantCode: connect.CodeUnimplemented,
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
			wantCode: connect.CodeUnimplemented,
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
			wantCode: connect.CodeUnimplemented,
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
			name:     "filter accepts all concrete enum values",
			wantCode: connect.CodeUnimplemented,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{
						Health:        []paprikav1.FleetHealth{paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY, paprikav1.FleetHealth_FLEET_HEALTH_MISSING},
						Sync:          []paprikav1.FleetSyncState{paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED, paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNKNOWN},
						ReleaseStates: []paprikav1.FleetReleaseState{paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PENDING, paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_AWAITING_APPROVAL},
						RolloutStates: []paprikav1.FleetRolloutState{paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PENDING, paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ABORTED},
						SourceTypes:   []paprikav1.FleetSourceType{paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT, paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_INLINE},
					},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unspecified health",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{Health: []paprikav1.FleetHealth{paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unknown health",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{Health: []paprikav1.FleetHealth{paprikav1.FleetHealth(99)}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unknown sync",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{Sync: []paprikav1.FleetSyncState{paprikav1.FleetSyncState(99)}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unspecified sync",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{Sync: []paprikav1.FleetSyncState{paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNSPECIFIED}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unknown release state",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{ReleaseStates: []paprikav1.FleetReleaseState{paprikav1.FleetReleaseState(99)}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unspecified release state",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{ReleaseStates: []paprikav1.FleetReleaseState{paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_UNSPECIFIED}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unknown rollout state",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{RolloutStates: []paprikav1.FleetRolloutState{paprikav1.FleetRolloutState(99)}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unspecified rollout state",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{RolloutStates: []paprikav1.FleetRolloutState{paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_UNSPECIFIED}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unknown source type",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{SourceTypes: []paprikav1.FleetSourceType{paprikav1.FleetSourceType(99)}},
				}))
				return err
			},
		},
		{
			name:     "filter rejects unspecified source type",
			wantCode: connect.CodeInvalidArgument,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryApplications(context.Background(), connect.NewRequest(&paprikav1.QueryApplicationsRequest{
					Filter: &paprikav1.FleetFilter{SourceTypes: []paprikav1.FleetSourceType{paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_UNSPECIFIED}},
				}))
				return err
			},
		},
		{
			name:     "map accepts unspecified defaults",
			wantCode: connect.CodeUnimplemented,
			call: func(_ *testing.T, server *PaprikaServer) error {
				_, err := server.QueryFleetMap(context.Background(), connect.NewRequest(&paprikav1.QueryFleetMapRequest{}))
				return err
			},
		},
		{
			name:     "map accepts concrete group and size metric",
			wantCode: connect.CodeUnimplemented,
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
			wantCode: connect.CodeUnimplemented,
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
