package apiserver

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"

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
					assertFilterCode(t, dimension.filter(value.Number()), connect.CodeUnimplemented)
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
