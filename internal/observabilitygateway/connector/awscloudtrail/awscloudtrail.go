// Package awscloudtrail implements connector.Connector for AWS CloudTrail's
// LookupEvents API. Only the logs signal is served — CloudTrail events are
// the account's audit trail — and queries carry comma-separated Key=Value
// lookup attribute pairs, e.g. EventName=RunInstances,EventSource=ec2.amazonaws.com,
// where an empty query looks up all events. LookupEvents scopes server-side
// to the trailing hour when no range is passed, so a zero bound stays
// unbounded, as the connector contract promises.
//
// EventCategory deserves a call-out: it is the attribute activity and insight
// events filter through (EventCategory=Management for management events,
// EventCategory=Insight for insight events), which is how an operator reads
// the unusual-activity trail rather than the full management firehose.
//
// An empty Query is the probe path: LookupEvents limited to one event — the
// same call a query makes, so a probe exercises exactly what a query would.
package awscloudtrail

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudtrail"
	"github.com/aws/aws-sdk-go-v2/service/cloudtrail/types"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Limit shaping. LookupEvents caps maxResults at 50; 25 is a sane default,
// and the probe asks for a single event.
const (
	defaultLimit = 25
	probeLimit   = 1
	maxLimit     = 50
)

// lookupAttributeKeys is the LookupAttributeKey vocabulary the connector
// accepts, keyed by the exact wire name CloudTrail documents. Keys without
// SDK constants (EventType, Resources, SessionIssuerArn, EventCategory) are
// constructed from the wire string directly — the API accepts them even
// though the pinned SDK's enum predates them.
var lookupAttributeKeys = map[string]types.LookupAttributeKey{
	"EventId":          types.LookupAttributeKeyEventId,
	"EventName":        types.LookupAttributeKeyEventName,
	"EventSource":      types.LookupAttributeKeyEventSource,
	"EventType":        types.LookupAttributeKey("EventType"),
	"Username":         types.LookupAttributeKeyUsername,
	"Resources":        types.LookupAttributeKey("Resources"),
	"ResourceType":     types.LookupAttributeKeyResourceType,
	"ResourceName":     types.LookupAttributeKeyResourceName,
	"ReadOnly":         types.LookupAttributeKeyReadOnly,
	"EventCategory":    types.LookupAttributeKey("EventCategory"),
	"SessionIssuerArn": types.LookupAttributeKey("SessionIssuerArn"),
}

// CloudTrail is a connector for AWS CloudTrail. It is a stateless struct;
// per-call state travels in connector.QueryRequest.
type CloudTrail struct{}

// New returns a CloudTrail connector.
func New() connector.Connector { return CloudTrail{} }

// Descriptor advertises name, signals and network needs.
func (CloudTrail) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderAWSCloudTrail,
		Signals:     []connector.Signal{connector.SignalLogs},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// region, endpoint and insecureSkipTLS keys — ahead of use.
func (CloudTrail) ValidateConfig(config json.RawMessage) error {
	if err := awscommon.ValidateConfig(config, nil); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one event lookup. The query is a comma-separated Key=Value
// lookup attribute list; an empty query looks up all events and is the probe
// shape. An unparseable pair or an unknown attribute key is a caller bug —
// the connector advertises the Key=Value grammar — so it returns the
// ErrUnsupported dual result rather than a backend-failure result.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudTrail) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalLogs {
		return unsupported("aws-cloudtrail connector supplies logs only")
	}
	client, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}

	limit := httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit)
	if req.Query == "" {
		// Probe: one event — the cheapest LookupEvents call there is.
		limit = probeLimit
	}
	input := &cloudtrail.LookupEventsInput{
		MaxResults: aws.Int32(int32(limit)),
	}
	if req.Query != "" {
		attributes, attrErr := parseLookupAttributes(req.Query)
		if attrErr != nil {
			return unsupported(attrErr.Error())
		}
		input.LookupAttributes = attributes
	}
	if !req.Range.Start.IsZero() {
		input.StartTime = aws.Time(req.Range.Start)
	}
	if !req.Range.End.IsZero() {
		input.EndTime = aws.Time(req.Range.End)
	}

	out, err := client.LookupEvents(ctx, input)
	if err != nil {
		return queryError(err), nil
	}
	data, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("aws-cloudtrail: encoding backend response: %w", err)
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// setup validates the config document and assembles the service client.
// Config and credential-document problems are caller bugs, so they return as
// errors for the gateway to map rather than backend-failure results.
func setup(ctx context.Context, config json.RawMessage, credentialDocument []byte) (*cloudtrail.Client, error) {
	cfg, _, err := awscommon.ParseConfig(config, nil)
	if err != nil {
		return nil, fmt.Errorf("aws-cloudtrail: %w", err)
	}
	awsCfg, err := awscommon.NewAWSConfig(ctx, cfg, credentialDocument)
	if err != nil {
		return nil, fmt.Errorf("aws-cloudtrail: %w", err)
	}
	return cloudtrail.NewFromConfig(awsCfg, func(o *cloudtrail.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	}), nil
}

// parseLookupAttributes parses the comma-separated Key=Value query grammar
// into SDK lookup attributes. Pairs must carry an '=' with a non-empty key
// and value, and keys must belong to the documented LookupAttributeKey
// vocabulary. Errors name the offending pair or key — query text is operator
// input, not credential material.
func parseLookupAttributes(query string) ([]types.LookupAttribute, error) {
	pairs := strings.Split(query, ",")
	attributes := make([]types.LookupAttribute, 0, len(pairs))
	for _, pair := range pairs {
		key, value, ok := strings.Cut(pair, "=")
		if !ok || key == "" || value == "" {
			return nil, fmt.Errorf("aws-cloudtrail queries must be comma-separated Key=Value lookup pairs, got %q", pair)
		}
		enum, ok := lookupAttributeKeys[key]
		if !ok {
			return nil, fmt.Errorf("aws-cloudtrail connector does not support lookup attribute key %q", key)
		}
		attributes = append(attributes, types.LookupAttribute{
			AttributeKey:   enum,
			AttributeValue: aws.String(value),
		})
	}
	return attributes, nil
}

// unsupported builds the result — and error — for a query shape the
// connector does not serve. The result carries the fixed user-facing
// sentence; the error wraps connector.ErrUnsupported so the caller bug can
// be classified programmatically.
func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// queryError converts a backend failure into its sanitized result: the
// state classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract. Detail for logs travels in the
// handler's logs, not in the result.
func queryError(err error) *connector.QueryResult {
	state := awscommon.ClassifyError(err)
	return &connector.QueryResult{State: state, Reason: awscommon.ReasonFor(state)}
}
