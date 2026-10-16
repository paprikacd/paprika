// Schema exploration for AWS CloudTrail: the lookup-attribute vocabulary a
// caller can filter events by, served as a static catalog. CloudTrail has no
// server-side enumeration API for its lookup attributes — the vocabulary IS
// the API's documented LookupAttributeKey enum — so label_names returns the
// catalog from the connector itself rather than asking the backend. This is
// the one kind where a valid config is parsed for consistency with the
// other connectors and their shape-then-config contract, but no CloudTrail
// client is ever built and no network call is made: the catalog cannot
// drift from what the backend accepts because the connector's own Query
// path validates queries against the same vocabulary (lookupAttributeKeys).
//
// Metric-oriented kinds have no meaning for an audit-trail backend, and
// trace kinds are not served, so everything but label_names reports
// StateNotAvailable.
package awscloudtrail

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
)

// exploreLookupAttributes is the static LookupAttributeKey catalog served
// for label_names. It is the subset of lookupAttributeKeys this connector's
// Query path documents as the filter vocabulary — the ones an operator
// reaches for when building an event lookup.
var exploreLookupAttributes = []string{
	"EventId",
	"EventName",
	"ReadOnly",
	"Username",
	"ResourceType",
	"ResourceName",
	"EventSource",
	"AccessKeyId",
}

// CloudTrail satisfies connector.Explorer: the lookup-attribute vocabulary
// is enumerable from the connector itself.
var _ connector.Explorer = CloudTrail{}

// Explore enumerates one schema slice of the CloudTrail backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudTrail) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if req.Kind != connector.ExploreLabelNames {
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the aws-cloudtrail connector", req.Kind))
	}

	// The catalog is static, but config is still parsed first: an invalid
	// document is a caller bug whatever kind was asked for, mirroring Query.
	if _, _, err := awscommon.ParseConfig(req.Config, nil); err != nil {
		return nil, fmt.Errorf("aws-cloudtrail: %w", err)
	}

	data, err := json.Marshal(struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}{Status: "success", Data: exploreLookupAttributes})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}, nil
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
}

// exploreUnsupported builds the result — and error — for an exploration kind
// the connector does not serve, mirroring Query's unsupported contract.
func exploreUnsupported(reason string) (*connector.ExploreResult, error) {
	return &connector.ExploreResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}
