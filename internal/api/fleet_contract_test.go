package apiserver

import (
	"crypto/sha256"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func TestFleetDescriptor(t *testing.T) {
	file := paprikav1.File_paprika_v1_api_proto
	assertLegacyFleetDescriptors(t, file)

	wantEnums := map[string]map[string]int32{
		"FleetHealth": {
			"FLEET_HEALTH_UNSPECIFIED": 0, "FLEET_HEALTH_HEALTHY": 1,
			"FLEET_HEALTH_PROGRESSING": 2, "FLEET_HEALTH_DEGRADED": 3,
			"FLEET_HEALTH_FAILED": 4, "FLEET_HEALTH_UNKNOWN": 5,
			"FLEET_HEALTH_MISSING": 6,
		},
		"FleetSyncState": {
			"FLEET_SYNC_STATE_UNSPECIFIED": 0, "FLEET_SYNC_STATE_SYNCED": 1,
			"FLEET_SYNC_STATE_OUT_OF_SYNC": 2, "FLEET_SYNC_STATE_UNKNOWN": 3,
		},
		"FleetSourceType": {
			"FLEET_SOURCE_TYPE_UNSPECIFIED": 0, "FLEET_SOURCE_TYPE_GIT": 1,
			"FLEET_SOURCE_TYPE_HELM": 2, "FLEET_SOURCE_TYPE_KUSTOMIZE": 3,
			"FLEET_SOURCE_TYPE_S3": 4, "FLEET_SOURCE_TYPE_OCI": 5,
			"FLEET_SOURCE_TYPE_INLINE": 6,
		},
		"FleetReleaseState": {
			"FLEET_RELEASE_STATE_UNSPECIFIED": 0, "FLEET_RELEASE_STATE_PENDING": 1,
			"FLEET_RELEASE_STATE_PROMOTING": 2, "FLEET_RELEASE_STATE_CANARYING": 3,
			"FLEET_RELEASE_STATE_VERIFYING": 4, "FLEET_RELEASE_STATE_COMPLETE": 5,
			"FLEET_RELEASE_STATE_FAILED": 6, "FLEET_RELEASE_STATE_ROLLED_BACK": 7,
			"FLEET_RELEASE_STATE_SUPERSEDED": 8, "FLEET_RELEASE_STATE_AWAITING_APPROVAL": 9,
		},
		"FleetRolloutState": {
			"FLEET_ROLLOUT_STATE_UNSPECIFIED": 0, "FLEET_ROLLOUT_STATE_PENDING": 1,
			"FLEET_ROLLOUT_STATE_PROGRESSING": 2, "FLEET_ROLLOUT_STATE_PAUSED": 3,
			"FLEET_ROLLOUT_STATE_HEALTHY": 4, "FLEET_ROLLOUT_STATE_DEGRADED": 5,
			"FLEET_ROLLOUT_STATE_FAILED": 6, "FLEET_ROLLOUT_STATE_ROLLED_BACK": 7,
			"FLEET_ROLLOUT_STATE_ABORTED": 8,
		},
		"FleetSortField": {
			"FLEET_SORT_FIELD_UNSPECIFIED": 0, "FLEET_SORT_FIELD_NAME": 1,
			"FLEET_SORT_FIELD_PROJECT": 2, "FLEET_SORT_FIELD_CLUSTER": 3,
			"FLEET_SORT_FIELD_STAGE": 4, "FLEET_SORT_FIELD_HEALTH": 5,
			"FLEET_SORT_FIELD_SYNC": 6, "FLEET_SORT_FIELD_RELEASE": 7,
			"FLEET_SORT_FIELD_ROLLOUT": 8, "FLEET_SORT_FIELD_RESOURCE_COUNT": 9,
			"FLEET_SORT_FIELD_LAST_TRANSITION": 10, "FLEET_SORT_FIELD_IMPACT": 11,
			"FLEET_SORT_FIELD_RELEVANCE": 12,
		},
		"FleetSortDirection": {
			"FLEET_SORT_DIRECTION_UNSPECIFIED": 0, "FLEET_SORT_DIRECTION_ASC": 1,
			"FLEET_SORT_DIRECTION_DESC": 2,
		},
		"FleetGroupDimension": {
			"FLEET_GROUP_DIMENSION_UNSPECIFIED": 0, "FLEET_GROUP_DIMENSION_PROJECT": 1,
			"FLEET_GROUP_DIMENSION_CLUSTER": 2, "FLEET_GROUP_DIMENSION_STAGE": 3,
			"FLEET_GROUP_DIMENSION_HEALTH": 4,
		},
		"FleetSizeMetric": {
			"FLEET_SIZE_METRIC_UNSPECIFIED": 0, "FLEET_SIZE_METRIC_RESOURCE_COUNT": 1,
			"FLEET_SIZE_METRIC_REQUEST_RATE": 2,
		},
		"FleetFacetDimension": {
			"FLEET_FACET_DIMENSION_UNSPECIFIED": 0, "FLEET_FACET_DIMENSION_PROJECT": 1,
			"FLEET_FACET_DIMENSION_NAMESPACE": 2, "FLEET_FACET_DIMENSION_CLUSTER": 3,
			"FLEET_FACET_DIMENSION_STAGE": 4, "FLEET_FACET_DIMENSION_HEALTH": 5,
			"FLEET_FACET_DIMENSION_SYNC": 6, "FLEET_FACET_DIMENSION_RELEASE": 7,
			"FLEET_FACET_DIMENSION_ROLLOUT": 8, "FLEET_FACET_DIMENSION_SOURCE_TYPE": 9,
		},
		"FleetCapability": {
			"FLEET_CAPABILITY_UNSPECIFIED": 0, "FLEET_CAPABILITY_APPLICATION_SYNC": 1,
			"FLEET_CAPABILITY_RELEASE_ROLLBACK": 2, "FLEET_CAPABILITY_GATE_APPROVE": 3,
			"FLEET_CAPABILITY_PIPELINE_RETRY": 4,
		},
		"FleetConnectionState": {
			"FLEET_CONNECTION_STATE_UNSPECIFIED": 0, "FLEET_CONNECTION_STATE_HEALTHY": 1,
			"FLEET_CONNECTION_STATE_UNHEALTHY": 2, "FLEET_CONNECTION_STATE_DISABLED": 3,
			"FLEET_CONNECTION_STATE_NOT_CONFIGURED": 4,
		},
		"FleetMapNodeKind": {
			"FLEET_MAP_NODE_KIND_UNSPECIFIED": 0, "FLEET_MAP_NODE_KIND_GROUP": 1,
			"FLEET_MAP_NODE_KIND_APPLICATION": 2,
		},
	}
	for enumName, wantValues := range wantEnums {
		enum := file.Enums().ByName(protoreflect.Name(enumName))
		require.NotNilf(t, enum, "missing enum %s", enumName)
		gotValues := make(map[string]int32, enum.Values().Len())
		for i := 0; i < enum.Values().Len(); i++ {
			value := enum.Values().Get(i)
			gotValues[string(value.Name())] = int32(value.Number())
		}
		require.Equalf(t, wantValues, gotValues, "enum %s changed", enumName)
	}

	assertFleetMessageDescriptors(t, file.Messages())

	service := file.Services().ByName("PaprikaService")
	require.NotNil(t, service)
	for _, wantMethod := range fleetQueryServiceMethods {
		method := service.Methods().ByName(protoreflect.Name(wantMethod.name))
		require.NotNilf(t, method, "missing RPC %s", wantMethod.name)
		assertFleetMethodDescriptor(t, method, wantMethod)
	}
}

type fleetFieldDescriptorContract struct {
	number         protoreflect.FieldNumber
	kind           protoreflect.Kind
	cardinality    protoreflect.Cardinality
	referencedType protoreflect.FullName
	oneof          protoreflect.Name
}

var fleetMessageDescriptorContracts = map[string]map[string]fleetFieldDescriptorContract{
	"FleetObjectKey": {
		"namespace": {number: 1, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"name":      {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
	},
	"FleetFilter": {
		"projects": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"namespaces": {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Repeated},
		"clusters": {
			number: 3, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"stages": {number: 4, kind: protoreflect.StringKind, cardinality: protoreflect.Repeated},
		"health": {
			number: 5, kind: protoreflect.EnumKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetHealth",
		},
		"sync": {
			number: 6, kind: protoreflect.EnumKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetSyncState",
		},
		"release_states": {
			number: 7, kind: protoreflect.EnumKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetReleaseState",
		},
		"rollout_states": {
			number: 8, kind: protoreflect.EnumKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetRolloutState",
		},
		"source_types": {
			number: 9, kind: protoreflect.EnumKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetSourceType",
		},
	},
	"StageTargetSummary": {
		"stable_id": {number: 1, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"stage":     {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"ring":      {number: 3, kind: protoreflect.Int32Kind, cardinality: protoreflect.Optional},
		"cluster": {
			number: 4, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"cluster_label": {number: 5, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"health": {
			number: 6, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetHealth",
		},
		"cluster_connection": {
			number: 7, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetConnectionState",
		},
		"unmanaged_inline_cluster": {number: 8, kind: protoreflect.BoolKind, cardinality: protoreflect.Optional},
	},
	"ApplicationSummary": {
		"identity": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"project": {
			number: 2, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"targets": {
			number: 3, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.StageTargetSummary",
		},
		"current_stage": {number: 4, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"current_cluster": {
			number: 5, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"current_cluster_label": {number: 6, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"source_type": {
			number: 7, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetSourceType",
		},
		"source_revision": {number: 8, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"health": {
			number: 9, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetHealth",
		},
		"sync": {
			number: 10, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetSyncState",
		},
		"drift_count":            {number: 11, kind: protoreflect.Uint32Kind, cardinality: protoreflect.Optional},
		"missing_resource_count": {number: 12, kind: protoreflect.Uint32Kind, cardinality: protoreflect.Optional},
		"release_state": {
			number: 13, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetReleaseState",
		},
		"rollout_state": {
			number: 14, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetRolloutState",
		},
		"resource_count": {number: 15, kind: protoreflect.Uint32Kind, cardinality: protoreflect.Optional},
		"repository": {
			number: 16, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"repository_connection": {
			number: 17, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetConnectionState",
		},
		"effective_observability_source": {
			number: 18, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"observability_connection": {
			number: 19, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetConnectionState",
		},
		"blocked_gate_count":      {number: 20, kind: protoreflect.Uint32Kind, cardinality: protoreflect.Optional},
		"last_transition_unix_ms": {number: 21, kind: protoreflect.Int64Kind, cardinality: protoreflect.Optional},
		"capabilities": {
			number: 22, kind: protoreflect.EnumKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetCapability",
		},
	},
	"FleetFacetBucket": {
		"dimension": {
			number: 1, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetFacetDimension",
		},
		"object": {
			number: 2, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey", oneof: "key",
		},
		"value": {number: 3, kind: protoreflect.StringKind, cardinality: protoreflect.Optional, oneof: "key"},
		"label": {number: 4, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"count": {number: 5, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
	},
	"FleetHealthBucket": {
		"health": {
			number: 1, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetHealth",
		},
		"count": {number: 2, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
	},
	"QueryApplicationsRequest": {
		"filter": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetFilter",
		},
		"search": {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"sort": {
			number: 3, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetSortField",
		},
		"direction": {
			number: 4, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetSortDirection",
		},
		"page_size": {number: 5, kind: protoreflect.Uint32Kind, cardinality: protoreflect.Optional},
		"cursor":    {number: 6, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
	},
	"QueryApplicationsResponse": {
		"applications": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.ApplicationSummary",
		},
		"total":            {number: 2, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"next_cursor":      {number: 3, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"index_generation": {number: 4, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"facets": {
			number: 5, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetFacetBucket",
		},
	},
	"FleetMapNode": {
		"stable_id": {number: 1, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"kind": {
			number: 2, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetMapNodeKind",
		},
		"label": {number: 3, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"application": {
			number: 4, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey",
		},
		"group_object": {
			number: 5, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey", oneof: "group_key",
		},
		"group_value":            {number: 6, kind: protoreflect.StringKind, cardinality: protoreflect.Optional, oneof: "group_key"},
		"application_count":      {number: 7, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"target_count":           {number: 8, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"health":                 {number: 9, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated, referencedType: "paprika.v1.FleetHealthBucket"},
		"resource_weight":        {number: 10, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"request_rate_weight":    {number: 11, kind: protoreflect.DoubleKind, cardinality: protoreflect.Optional},
		"effective_weight":       {number: 12, kind: protoreflect.DoubleKind, cardinality: protoreflect.Optional},
		"used_resource_fallback": {number: 13, kind: protoreflect.BoolKind, cardinality: protoreflect.Optional},
		"children": {
			number: 14, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetMapNode",
		},
	},
	"QueryFleetMapRequest": {
		"filter": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetFilter",
		},
		"search": {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"group": {
			number: 3, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetGroupDimension",
		},
		"size_metric": {
			number: 4, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetSizeMetric",
		},
	},
	"QueryFleetMapResponse": {
		"roots": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetMapNode",
		},
		"total":            {number: 2, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"index_generation": {number: 3, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"facets": {
			number: 4, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetFacetBucket",
		},
	},
	"FleetMatrixHeader": {
		"stable_id": {number: 1, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"label":     {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"object": {
			number: 3, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetObjectKey", oneof: "key",
		},
		"value": {number: 4, kind: protoreflect.StringKind, cardinality: protoreflect.Optional, oneof: "key"},
	},
	"FleetMatrixCell": {
		"row_id":            {number: 1, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"column_id":         {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"application_count": {number: 3, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"target_count":      {number: 4, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"health": {
			number: 5, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetHealthBucket",
		},
		"resource_weight":        {number: 6, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"request_rate_weight":    {number: 7, kind: protoreflect.DoubleKind, cardinality: protoreflect.Optional},
		"used_resource_fallback": {number: 8, kind: protoreflect.BoolKind, cardinality: protoreflect.Optional},
	},
	"QueryFleetMatrixRequest": {
		"filter": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetFilter",
		},
		"search": {number: 2, kind: protoreflect.StringKind, cardinality: protoreflect.Optional},
		"row_group": {
			number: 3, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetGroupDimension",
		},
		"column_group": {
			number: 4, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetGroupDimension",
		},
		"size_metric": {
			number: 5, kind: protoreflect.EnumKind, cardinality: protoreflect.Optional,
			referencedType: "paprika.v1.FleetSizeMetric",
		},
	},
	"QueryFleetMatrixResponse": {
		"rows": {
			number: 1, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetMatrixHeader",
		},
		"columns": {
			number: 2, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetMatrixHeader",
		},
		"cells": {
			number: 3, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetMatrixCell",
		},
		"total":            {number: 4, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"index_generation": {number: 5, kind: protoreflect.Uint64Kind, cardinality: protoreflect.Optional},
		"facets": {
			number: 6, kind: protoreflect.MessageKind, cardinality: protoreflect.Repeated,
			referencedType: "paprika.v1.FleetFacetBucket",
		},
	},
}

func assertFleetMessageDescriptors(t *testing.T, messages protoreflect.MessageDescriptors) {
	t.Helper()
	require.Len(t, fleetMessageDescriptorContracts, 15)
	for messageName, wantFields := range fleetMessageDescriptorContracts {
		message := messages.ByName(protoreflect.Name(messageName))
		require.NotNilf(t, message, "missing message %s", messageName)
		require.Equalf(t, len(wantFields), message.Fields().Len(), "message %s field count changed", messageName)
		for fieldName, wantField := range wantFields {
			field := message.Fields().ByName(protoreflect.Name(fieldName))
			require.NotNilf(t, field, "message %s missing field %s", messageName, fieldName)
			require.Equalf(t, wantField.number, field.Number(), "message %s field %s number changed", messageName, fieldName)
			require.Equalf(t, wantField.kind, field.Kind(), "message %s field %s kind changed", messageName, fieldName)
			require.Equalf(t, wantField.cardinality, field.Cardinality(), "message %s field %s cardinality changed", messageName, fieldName)

			var gotReferencedType protoreflect.FullName
			if field.Kind() == protoreflect.EnumKind {
				gotReferencedType = field.Enum().FullName()
			}
			if field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind {
				gotReferencedType = field.Message().FullName()
			}
			require.Equalf(t, wantField.referencedType, gotReferencedType, "message %s field %s referenced type changed", messageName, fieldName)

			var gotOneof protoreflect.Name
			if oneof := field.ContainingOneof(); oneof != nil {
				gotOneof = oneof.Name()
			}
			require.Equalf(t, wantField.oneof, gotOneof, "message %s field %s oneof changed", messageName, fieldName)
		}
	}
}

func assertLegacyFleetDescriptors(t *testing.T, file protoreflect.FileDescriptor) {
	t.Helper()
	require.Len(t, legacyFleetMessageDescriptorHashes, 120, "snapshot must cover every pre-existing top-level message")
	for messageName, wantHash := range legacyFleetMessageDescriptorHashes {
		message := file.Messages().ByName(protoreflect.Name(messageName))
		require.NotNilf(t, message, "legacy message %s was removed", messageName)
		encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(protodesc.ToDescriptorProto(message))
		require.NoError(t, err)
		gotHash := fmt.Sprintf("%x", sha256.Sum256(encoded))
		require.Equalf(t, wantHash, gotHash, "legacy message %s descriptor changed", messageName)
	}

	service := file.Services().ByName("PaprikaService")
	require.NotNil(t, service)
	methods := service.Methods()
	require.Len(t, legacyFleetServiceMethods, 37, "snapshot must cover every pre-existing RPC")
	require.Len(t, fleetQueryServiceMethods, 3, "snapshot must cover every fleet query RPC")
	require.GreaterOrEqual(t, methods.Len(), len(legacyFleetServiceMethods)+len(fleetQueryServiceMethods))
	for i, wantMethod := range legacyFleetServiceMethods {
		assertFleetMethodDescriptor(t, methods.Get(i), wantMethod)
	}
	for i, wantMethod := range fleetQueryServiceMethods {
		methodIndex := len(legacyFleetServiceMethods) + i
		assertFleetMethodDescriptor(t, methods.Get(methodIndex), wantMethod)
	}
}

type fleetMethodDescriptorContract struct {
	name            string
	input           protoreflect.FullName
	output          protoreflect.FullName
	clientStreaming bool
	serverStreaming bool
}

func assertFleetMethodDescriptor(t *testing.T, method protoreflect.MethodDescriptor, want fleetMethodDescriptorContract) {
	t.Helper()
	require.Equal(t, protoreflect.Name(want.name), method.Name())
	require.Equalf(t, want.input, method.Input().FullName(), "RPC %s input changed", want.name)
	require.Equalf(t, want.output, method.Output().FullName(), "RPC %s output changed", want.name)
	require.Equalf(t, want.clientStreaming, method.IsStreamingClient(), "RPC %s client streaming changed", want.name)
	require.Equalf(t, want.serverStreaming, method.IsStreamingServer(), "RPC %s server streaming changed", want.name)
}

var fleetQueryServiceMethods = []fleetMethodDescriptorContract{
	{name: "QueryApplications", input: "paprika.v1.QueryApplicationsRequest", output: "paprika.v1.QueryApplicationsResponse"},
	{name: "QueryFleetMap", input: "paprika.v1.QueryFleetMapRequest", output: "paprika.v1.QueryFleetMapResponse"},
	{name: "QueryFleetMatrix", input: "paprika.v1.QueryFleetMatrixRequest", output: "paprika.v1.QueryFleetMatrixResponse"},
}

var legacyFleetServiceMethods = []fleetMethodDescriptorContract{
	{name: "ListPipelines", input: "paprika.v1.ListPipelinesRequest", output: "paprika.v1.ListPipelinesResponse"},
	{name: "ListReleases", input: "paprika.v1.ListReleasesRequest", output: "paprika.v1.ListReleasesResponse"},
	{name: "ListStages", input: "paprika.v1.ListStagesRequest", output: "paprika.v1.ListStagesResponse"},
	{name: "ListApplications", input: "paprika.v1.ListApplicationsRequest", output: "paprika.v1.ListApplicationsResponse"},
	{name: "ListPolicies", input: "paprika.v1.ListPoliciesRequest", output: "paprika.v1.ListPoliciesResponse"},
	{name: "ListApplicationSets", input: "paprika.v1.ListApplicationSetsRequest", output: "paprika.v1.ListApplicationSetsResponse"},
	{name: "GetApplicationSet", input: "paprika.v1.GetApplicationSetRequest", output: "paprika.v1.GetApplicationSetResponse"},
	{name: "ListNotificationConfigs", input: "paprika.v1.ListNotificationConfigsRequest", output: "paprika.v1.ListNotificationConfigsResponse"},
	{name: "GetApplication", input: "paprika.v1.GetApplicationRequest", output: "paprika.v1.GetApplicationResponse"},
	{name: "SyncApplication", input: "paprika.v1.SyncApplicationRequest", output: "paprika.v1.SyncApplicationResponse"},
	{name: "ApproveGate", input: "paprika.v1.ApproveGateRequest", output: "paprika.v1.ApproveGateResponse"},
	{name: "ListGateStatus", input: "paprika.v1.ListGateStatusRequest", output: "paprika.v1.ListGateStatusResponse"},
	{name: "RejectGate", input: "paprika.v1.RejectGateRequest", output: "paprika.v1.RejectGateResponse"},
	{name: "ResolveSource", input: "paprika.v1.ResolveSourceRequest", output: "paprika.v1.ResolveSourceResponse"},
	{name: "Render", input: "paprika.v1.RenderRequest", output: "paprika.v1.RenderResponse"},
	{name: "ApplyBundle", input: "paprika.v1.ApplyBundleRequest", output: "paprika.v1.ApplyBundleResponse"},
	{name: "RollbackRelease", input: "paprika.v1.RollbackReleaseRequest", output: "paprika.v1.RollbackReleaseResponse"},
	{name: "ListRollouts", input: "paprika.v1.ListRolloutsRequest", output: "paprika.v1.ListRolloutsResponse"},
	{name: "GetRollout", input: "paprika.v1.GetRolloutRequest", output: "paprika.v1.GetRolloutResponse"},
	{name: "PromoteRollout", input: "paprika.v1.PromoteRolloutRequest", output: "paprika.v1.PromoteRolloutResponse"},
	{name: "AbortRollout", input: "paprika.v1.AbortRolloutRequest", output: "paprika.v1.AbortRolloutResponse"},
	{name: "ListAnalysisRuns", input: "paprika.v1.ListAnalysisRunsRequest", output: "paprika.v1.ListAnalysisRunsResponse"},
	{name: "GetAnalysisRun", input: "paprika.v1.GetAnalysisRunRequest", output: "paprika.v1.GetAnalysisRunResponse"},
	{name: "GetPipeline", input: "paprika.v1.GetPipelineRequest", output: "paprika.v1.GetPipelineResponse"},
	{name: "GetArtifact", input: "paprika.v1.GetArtifactRequest", output: "paprika.v1.GetArtifactResponse"},
	{name: "ListArtifacts", input: "paprika.v1.ListArtifactsRequest", output: "paprika.v1.ListArtifactsResponse"},
	{name: "RetryStep", input: "paprika.v1.RetryStepRequest", output: "paprika.v1.RetryStepResponse"},
	{name: "SkipStep", input: "paprika.v1.SkipStepRequest", output: "paprika.v1.SkipStepResponse"},
	{name: "CancelPipeline", input: "paprika.v1.CancelPipelineRequest", output: "paprika.v1.CancelPipelineResponse"},
	{name: "GetStepLogs", input: "paprika.v1.GetStepLogsRequest", output: "paprika.v1.GetStepLogsResponse"},
	{name: "GetResource", input: "paprika.v1.GetResourceRequest", output: "paprika.v1.GetResourceResponse"},
	{name: "GetResourceTree", input: "paprika.v1.GetResourceTreeRequest", output: "paprika.v1.GetResourceTreeResponse"},
	{name: "GetResourceLogs", input: "paprika.v1.GetResourceLogsRequest", output: "paprika.v1.GetResourceLogsResponse"},
	{name: "GetResourceTreeDetailed", input: "paprika.v1.GetResourceTreeDetailedRequest", output: "paprika.v1.GetResourceTreeDetailedResponse"},
	{
		name: "StreamResourceLogs", input: "paprika.v1.StreamResourceLogsRequest", output: "paprika.v1.LogChunk",
		serverStreaming: true,
	},
	{name: "Investigate", input: "paprika.v1.InvestigateRequest", output: "paprika.v1.InvestigateResponse"},
	{name: "ListInvestigatorPlugins", input: "paprika.v1.ListInvestigatorPluginsRequest", output: "paprika.v1.ListInvestigatorPluginsResponse"},
}

var legacyFleetMessageDescriptorHashes = map[string]string{
	"Step":                            "49817fbb112b1debde50a727a793330a3caa027c09cd1cdbdbe046e7f4556db2",
	"StepStatus":                      "54185b2f88d6030029335d9469e437187f023f20783cae4d1dc9a992d338efb4",
	"ArtifactRef":                     "28b808907d5ca3b9bed528f73a8583f36aef46f1b03cbf0031ca0b44a3c2b726",
	"ChartRef":                        "c07ea5dcbde8e636a41cda08e88ec56dd60026cecc6a61f15be8084e814991a3",
	"InlineSource":                    "cb5ce5b8e73cac78518781d5059fabc2ee5f795f1af75c760158676375f0bea8",
	"OCISource":                       "98eca7520c78796a5808cfa20f909543b9e0d53cb31600983c2180be458c2ab1",
	"ApplicationSource":               "5cb5a9b512a5fd690d4a2686fee3acd49e15531650463b026b7c39ad748dacc0",
	"ApplicationStage":                "2eb853f73cdd240cff83e2af8b55d33332e5df966b8f5ce6caeb190b3f3208bd",
	"HTTPProbe":                       "88aa6ae5cb999ef1e39c9195d80b9a34c40934b2e6aa73e21297ab8808f282d6",
	"HealthCheck":                     "507c75c4016d2a6e3205919a9115d78bec9bfc9101a7917dd68370e71a1d1096",
	"HealthCheckResult":               "27d4bb05971e03045aa45824eff90bd2b1552807ec578c9b445c1138f633bd84",
	"ResourceSync":                    "27c03d6dfe07b123fc7b2249a5b0a311d9636c29c8425b46a71a941bd815063f",
	"ResourceHealth":                  "8538b3b3fb94ddf0a3adf21f90824b9382dd738ac86927b95517104b1d37fe45",
	"GateStatus":                      "7029c6f25f2a5571fdae5b47047e0638a2277cfddcfa7aef55c29a2b3743c1d5",
	"Condition":                       "5153d114d3fcee89260789a7c15f51cc974707f941dda5fa0a53906a3c1884eb",
	"AnalysisResult":                  "36bf3e50d081bbfd652ae8dcc12539d562659da94765dec980e39f0c5998c5a4",
	"AnalysisRunResult":               "c6579c4b88cd99359b7462942f50ee61676847ffd54314a3efac0c2ee822835d",
	"AnalysisRun":                     "6a84dcb7147ad7ba8d7763a395e2336e8a0e8b1f1a9b8ae32120ef930462a798",
	"Application":                     "2dae4949c5b1d3ac9632aecc12732ff8be133ef505dc8759596d3d7ccd3a070e",
	"Pipeline":                        "0569d43ff198497537987d88afea6d8531b1cbf57d7f15fb8871d39590079ff2",
	"ManifestSource":                  "6fd2c813b5b4e5998fe5095419248a5bbfbb8c5d63b155e527264a3564f9b729",
	"PolicyResult":                    "cf37eb8bbc14a30b100d648b0276c2ca311f20b38090813773451e6431e2ee42",
	"Release":                         "c4fe296b93ca546a7044b96a941ceb471d55acac07926e7d7f2ec4c6d22245cc",
	"Promotion":                       "75883e8659c4e5daa70dfcae41fee002e7c745ccfd19d2223a77b1fb47a7b3ae",
	"HookStatus":                      "571b4a203bf3d6c8315a968a9a814e8c07118aa60b85eb4e3755f962d47be766",
	"Stage":                           "491a73905bc8d2c864a5c8b72c4ebeb76cd927fcdf55405f09c49bf481db74ff",
	"TrafficRouter":                   "285aaf969e8f328872f32622d0ddfe618511269d51702ec8145c6eb273d7dd96",
	"IstioRouterConfig":               "8897f3564c8e560430072603a866313fea6511b5a5cdfb8096189ce89825b8e0",
	"GatewayAPIRouterConfig":          "e6246ee9360ce144341be06611b44ccd6989197eb4e6d3e7866e17b4c1fc30d9",
	"RolloutStep":                     "a5a2864b238d3b2fc74493f212d6bd9794dc187c7bf77ece7be39a5c7fe43d78",
	"RolloutAnalysisCheck":            "e41fa8353b44936d92b71515ea214cb611249440bed2c3604191ab2b631c60d0",
	"RolloutABRoute":                  "cf654c36ce9821a02249dd46223ca99ca5d5669bc3c9e9e36e1e5c16bfb02f5b",
	"ListPipelinesRequest":            "1bbca9f24c2f250c576d3f45ac2e6ab22c6ac2d3eb49340b41ab61e043af59dd",
	"ListPipelinesResponse":           "b213a20ce972ea4e9e9069b3eefc32681484e6f7620e2b88b9f1e48425fb6221",
	"ListReleasesRequest":             "ba7a7d5e64ab2825a4ca35d4a4e2a6232d8ad48a83d133822a72a4f4feb06440",
	"ListReleasesResponse":            "b2c3cd47a995002babdcdec0af1f27d7cca34191af12876dc945d232db8e7d95",
	"ListStagesRequest":               "a09d401321c8d58d0e858acbf6ddd3d1434873883da30d2cce3f5877e388ddb6",
	"ListStagesResponse":              "0948ec18ca5408a02a70f7c8404f2f2df9a74cd88a5343d122c4187927b8b048",
	"ListApplicationsRequest":         "6777f3957c84fb7476626118d1d06d8db838bd34ddc9682d4193ba7672b9446f",
	"ListApplicationsResponse":        "94916fcab16612e37c458708917bbe68404f1c46e6f87b0087693607c1d0a9a6",
	"ListPoliciesRequest":             "f3defaac024dedf03bac434a716ff1208b9a9bc348ecfbbe76df3e54a0b0e008",
	"ListPoliciesResponse":            "06006665163148e35ba027312c6c4923a36641365bd8c13ba1ba41d7b7fb7158",
	"Policy":                          "1db15bbec53108466837281c61cddb1e9b15a6e9d4ee53461cc3d83626842ab4",
	"GetApplicationRequest":           "967ec3e79b1d2529aa06658ec8e9628134ca78ccc7afe5fd8f3a362b463ab4af",
	"GetApplicationResponse":          "60930e4dbd755feb6a2a0a0450eef27ddd1ad5119fef5a52e58818ed82426d01",
	"ApplicationSet":                  "09e98385b6d5a98a102cf1fb8945b1c3176d13889fc921b41e7aaa7696c1877f",
	"ListApplicationSetsRequest":      "dbf97ea26f0e3e58409b9ba91a2f6f7b0389f128246400568826ce6d5b6219a6",
	"ListApplicationSetsResponse":     "655f2c0beff03f930cb680054469a778a3426c01f73db19fcb1e8ede929cbe4c",
	"GetApplicationSetRequest":        "9e4ed4ad447d7854aff637d79b3373f053d95c00dddde1d3969da8bb658fe743",
	"GetApplicationSetResponse":       "5355c98a912a994a2d2ac2c42c0167e40bad647c866a36a1623fdbb34e5e0746",
	"SyncApplicationRequest":          "93d29208e403d5cd17caa1d5e19db1e85fe0416718207b3cceb452fc7889ec10",
	"SyncApplicationResponse":         "fb137db2775fd3defb0a60f28a4ac360337a6ee69fc4e44c4c3b07606d2e371f",
	"NotificationTrigger":             "e4a54552c3abbb5f7e089ba5a344a1a8bcd25d68fe1727d1407e7680d3a2e5bc",
	"NotificationDestination":         "daad09f5890d61c8b7e6c5e943d7afaa82003b7994634f73ffbb2d77232f74f4",
	"SMTPConfig":                      "94d90dba9eb5b7102d68164476978f45224c9c6f0d3c17d3d29f25036f82558c",
	"NotificationRateLimit":           "417f34852b201e5742f533c5fda3c86c7782551755ea59910b04ef57644fe69f",
	"NotificationConfig":              "e730dda860140d5b1c18b0d8fd5a815d0734f68f75d91d896fc2365852578163",
	"ListNotificationConfigsRequest":  "86b2a80c47420b680c7ec3fdf990a15593360542f31b2a86540949723c56eb91",
	"ListNotificationConfigsResponse": "74016d2dc5a73bdcc9ad98eb6feca503bf6a428eacf600968e25391e30116d56",
	"ApproveGateRequest":              "59d06579d04e65f1b43329a1fa74df9e04ff8e60ed2d2827741cbc987fb86629",
	"ApproveGateResponse":             "9e7876cc69cb0243220179bcffb5e2fe04a927a3978d17071dc8cffe623850ba",
	"ListGateStatusRequest":           "3778f22f8deca2f17a2023fc6747845158a14bb17aceea1df57e5c960618c28b",
	"ListGateStatusResponse":          "59abc7372a8f4d37314fe66f36a973987d08916a9eba47b8682815b2bfdc1415",
	"RejectGateRequest":               "2e98547c1ea304e6605fb7c2fceae5c7e6f7c694028ae314794380f9af38dfa6",
	"RejectGateResponse":              "dd6a08e7151dc9265c27fc6937d79a90e4833e55e8087266deebd5ac03a22b7b",
	"ResolveSourceRequest":            "2ea16efdd045c66514c71bccb299c5366d3575886d7bcde7f5d6d98e1d049531",
	"ResolveSourceResponse":           "6b86ab1fb26a7e25921da9887e9206584865b62ba66a8ba2e0a3f9ea18aea435",
	"RenderRequest":                   "83dc37a7fa43d1c8a2cfcbaaf8d7dfdaf1de300a4c1d1e77d0b03ed0a39cab95",
	"RenderResponse":                  "f0cc0a73b785d7e71f9381985370bddd62f2cfa54494210afd23e25c33341885",
	"ApplyBundleRequest":              "4dcd92a51bd86f237829297611dc71a7d8f0bee3b78279149aad371ca4e17ec4",
	"ApplyBundleResponse":             "d05dae6326bce57c73bffca6358f78653c5516232b939257ba0977710aec58b9",
	"RollbackReleaseRequest":          "7fd7220518220279806e5c89aa160610194471c9222df96ba10cfb338432789b",
	"RollbackReleaseResponse":         "ac7a0ac1d6ca85761c68120ebd531efbf8da060dbb545a26da944639c1ba6564",
	"Rollout":                         "7b8811339a21e5e5597fdac3543f7aed9a1c909ba0d03b32c00b23a140d418c8",
	"ListRolloutsRequest":             "527fb50637aabc20a28d67c3f0cd078cfca7b9e8e62e05364539f61292e676a3",
	"ListRolloutsResponse":            "75b1c1fea1ecae6d4f6c62b127bf516a62d9a9d6e4b27a886af0f9deb1dc2234",
	"GetRolloutRequest":               "b0a1d28ad919bc73e11dea6f0b5bfab4a0cba6d1856a515220a8ba24877af1cf",
	"GetRolloutResponse":              "7bd5dfb4cf74e8ddf58003329b5f6b1ad64627cef42533622107fa2deff50cee",
	"PromoteRolloutRequest":           "a454e7452f2f251123b22d5a8b79430881ad0e923e41cdee8155cf9b3e1e26a4",
	"PromoteRolloutResponse":          "0a02c209f66a780956ca791bd6f2db1e761521f85b27f09fd7ef9759fdc3d3af",
	"AbortRolloutRequest":             "9a6a69f1dc335f61a6289b7eb1cb125ba6472772bdfb277600abac8358218b7d",
	"AbortRolloutResponse":            "918432553bfcd3005d4aa6d90b1ebb48928e670b06a8ace022a42ca1a1305099",
	"ListAnalysisRunsRequest":         "8be06e4e923a445dbd5b64dce80a4ed5b6e43949951fbb9a86d5485780042151",
	"ListAnalysisRunsResponse":        "d385d12cc76d52214ea6215e6c6118514c1fcb63d4a5f1d4be9ffd0c2885a54d",
	"GetAnalysisRunRequest":           "5be9cc31021e639bb4e8d42c62c34de59d0b031109dc97193b9c3418c00b9f11",
	"GetAnalysisRunResponse":          "5bc1653dabb102172b91f22fa9ea2504a075835a53445363f5fa076d9afcc16f",
	"GetPipelineRequest":              "78aeaf4724dc3c33358415a16366fed84c778a31196f3e3df72b09e174c27de5",
	"GetPipelineResponse":             "352f070e6df1cb272589165f52d630b1a24f80986aaa29b6bb746e9de5ca8546",
	"GetArtifactRequest":              "6effbb5df7594dbe6fb77a8f282842c6457c76241a780f8c8dd3c0ec03471ba9",
	"GetArtifactResponse":             "c38cc153e950dc559a1e959d8db1a1f49dbdceca20993ade7ddb4b2177603a07",
	"ListArtifactsRequest":            "4b6a4626ca2b2e7b92f74a52ed1835de35f51424b97c3b0f871138aeadd74b48",
	"ListArtifactsResponse":           "90188a070b6e7b84f0b507c4296ea1a3e0f8eef782521ae63db592fcf1d2feea",
	"RetryStepRequest":                "912c0efbede0896838fe535caffa5f0862870d28e0db1b6d64a5152f64b01f95",
	"RetryStepResponse":               "a347075a93db39b672bd3b5747bd525c7350bb302c587a0d41f8208af957a071",
	"SkipStepRequest":                 "1bac64ce0458c73aa04eb2011b98de5f1d2929bfbb16771f3f3603416ead1afe",
	"SkipStepResponse":                "82d38e8d5bc38e324768febb1b616643d909c5261c8e34cadb5a91cffde05e1d",
	"CancelPipelineRequest":           "d542f7a5aac0aa5d0c3b7b344206841bdba8e4f4055cf8d3d16705d4bb53bed7",
	"CancelPipelineResponse":          "bc9e7fba404111e38727dcc659c339521749ef9048898a7a60335c4877cdb06c",
	"GetStepLogsRequest":              "2ae0d44a6ea096bb706141309b3303995a10310ba68fc2d973fbf3a54a740fd1",
	"GetStepLogsResponse":             "c005ce589ab444c18a168ad54f1d6bd2dcc69cfc76bfbab114719edbab810848",
	"GetResourceRequest":              "ac3a01c370ce1b4b67375394b1cf120b8c001606be3bb15093ac6dd1d0adf738",
	"KubernetesEvent":                 "b02e00a72be25e5b3916dd7b2f966cedc0a03e899161f549494e0637703d8f3a",
	"GetResourceResponse":             "7b58be684ababb3a76bc59325f3086ea04c48f361088eaa41a8ee9249fa1a902",
	"GetResourceTreeRequest":          "dba087c15fd9a2337180fcfb2215d6f35f274cd4ae4d6ecf973985e02dc073e2",
	"ResourceNode":                    "948bf15780b08e98609771fc1a48743ec1300c4e3fdeb58b12ec7ecc7a732099",
	"GetResourceTreeResponse":         "5262612a5c99bfff9c154487d543881d456fb8d78bbbec59b7bd53980de6479e",
	"GetResourceLogsRequest":          "e7e80c16be403d1d7da0df942f63f6618fde024596c6f946e4865295d7a60f1c",
	"GetResourceLogsResponse":         "424ce36da2beefda271623a0c6ef66f231789069deaa5a53bf88188ad362f707",
	"GetResourceTreeDetailedRequest":  "a8b5c4e568e25a9e64600fddd7aa65b70597fb3197e5fb7b38b64bbc03152db7",
	"ResourceTreeNode":                "1b64c16aeda6386f9019ad4461799cde595d53af00054ecc4135b626be31bf01",
	"GetResourceTreeDetailedResponse": "a1808619ab9b2c28e5d660425b71afae282da62656e63f1ca1cf70e4aae36d62",
	"InvestigateRequest":              "20d6204f8c5c56dc68551f42df4596e6965286de1a67ca6b364fd08b8646307f",
	"FindingEvidence":                 "ded8c822dbb4e70333d20d320ad3abd081198bfb685200735165a5d4cd992e5c",
	"InvestigationFinding":            "9aa8f6deb5fa4b7c3a2c435a40951c91fa52530a8ec1affb9cd48a7c039787c8",
	"InvestigateResponse":             "8b6ff78e6e96b95be44a58339d52f36bad0fb030e6c7edc21f886943d5a7d473",
	"ListInvestigatorPluginsRequest":  "d2424cac20f513800c33b75065fbdf1e9439b9e55868723b062201a49672e1ed",
	"PluginInfo":                      "bc38a78ab29cbcf5aecb3219e125ac0f0c9e1802e95738884500c341513dba80",
	"ListInvestigatorPluginsResponse": "8e5dcaaa105879f6eb15b64de764c50553bd271dbc736f94d601313eaed1463c",
	"StreamResourceLogsRequest":       "e166fc1554198131ee84cd53968910b332ea494fe1cea7d6f412f99ac60fe088",
	"LogChunk":                        "4386e5fbd814ac6e54e5e7037ad1c2a1b2a46ab078d4f2b70d65e8968abf1279",
}
