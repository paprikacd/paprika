package awscloudtrail

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// validConfig is a config document needing no endpoint: the label_names
// catalog is static and never touches the network.
var validConfig = json.RawMessage(`{"region":"us-east-1"}`)

func TestExploreLabelNamesStaticCatalog(t *testing.T) {
	t.Parallel()

	res, err := CloudTrail{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Config: validConfig,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "success", decoded.Status)
	require.Equal(t, []string{
		"EventId",
		"EventName",
		"ReadOnly",
		"Username",
		"ResourceType",
		"ResourceName",
		"EventSource",
		"AccessKeyId",
	}, decoded.Data)
}

func TestExploreLabelNamesInvalidConfigIsCallerBug(t *testing.T) {
	t.Parallel()

	// The catalog is static, but the config is still parsed: a caller bug
	// stays a caller bug.
	res, err := CloudTrail{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Config: json.RawMessage(`{"region":"us-east-1","bogus":true}`),
	})
	require.Error(t, err)
	require.Nil(t, res)
	require.ErrorContains(t, err, "aws-cloudtrail")
}

func TestExploreUnsupportedKinds(t *testing.T) {
	t.Parallel()

	for _, kind := range []connector.ExploreKind{
		connector.ExploreMetricNames,
		connector.ExploreLabelValues,
		connector.ExploreMetricMetadata,
		connector.ExploreTraceServices,
	} {
		res, err := CloudTrail{}.Explore(context.Background(), connector.ExploreRequest{
			Kind:   kind,
			Config: validConfig,
		})
		require.ErrorIs(t, err, connector.ErrUnsupported)
		require.Equal(t, connector.StateNotAvailable, res.State)
	}
}
