package main

import (
	"context"
	"strconv"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// maxTriggeredApplications is the wire's bound on the inline identity list. The
// count beside it is authoritative, and truncated says which of the two the
// console must believe.
const maxTriggeredApplications = 50

// sourceEventShape is the provider-shaped detail behind one SourceEventKind. It
// is a table rather than a switch so a new kind cannot silently inherit an
// unrelated kind's provider or reference format.
type sourceEventShape struct {
	sourceType paprikav1.FleetSourceType
	provider   string
	reference  string
}

var sourceEventShapes = map[paprikav1.SourceEventKind]sourceEventShape{
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_GIT_PUSH: {
		sourceType: paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT,
		provider:   "github", reference: "refs/heads/main",
	},
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_GIT_TAG: {
		sourceType: paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT,
		provider:   "gitlab", reference: "refs/tags/v1.4.2",
	},
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_OCI_PUSH: {
		sourceType: paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_OCI,
		provider:   "oci", reference: "ghcr.io/paprika/fixture:2026.01",
	},
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_S3_OBJECT: {
		sourceType: paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_S3,
		provider:   "s3", reference: "bundles/fixture/manifest.tar.gz",
	},
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_POLL_DETECTED: {
		sourceType: paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT,
		provider:   "poll", reference: "refs/heads/main",
	},
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_MANUAL_SYNC: {
		sourceType: paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT,
		provider:   "api", reference: "refs/heads/main",
	},
}

// defaultSourceEventKinds is the rotation an unfiltered feed cycles through, in
// enum order, so every kind the console can render appears on the first page.
var defaultSourceEventKinds = [...]paprikav1.SourceEventKind{
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_GIT_PUSH,
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_GIT_TAG,
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_OCI_PUSH,
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_S3_OBJECT,
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_POLL_DETECTED,
	paprikav1.SourceEventKind_SOURCE_EVENT_KIND_MANUAL_SYNC,
}

// sourceEventOutcomes rotates outcomes so the feed is not uniformly successful.
// A fixture in which nothing is ever rejected leaves the console's failure
// rendering unexercised, which is where the bugs are.
var sourceEventOutcomes = [...]paprikav1.SourceEventOutcome{
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_ACCEPTED,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_ACCEPTED,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_ACCEPTED,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_NO_MATCH,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_ACCEPTED,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_REJECTED,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_ACCEPTED,
	paprikav1.SourceEventOutcome_SOURCE_EVENT_OUTCOME_FAILED,
}

// ListSourceEvents serves the recent source-trigger feed.
func (c *consoleServer) ListSourceEvents(
	ctx context.Context,
	req *connect.Request[paprikav1.ListSourceEventsRequest],
) (*connect.Response[paprikav1.ListSourceEventsResponse], error) {
	response, err := c.PaprikaServer.ListSourceEvents(ctx, req)
	if err != nil {
		return nil, err
	}
	start, end, next := sourceEventFeed.window(
		req.Msg.GetPageSize(), req.Msg.GetCursor(), req.Msg.GetSinceUnixMs(),
	)
	events := make([]*paprikav1.SourceEvent, 0, end-start)
	for ordinal := start; ordinal < end; ordinal++ {
		if event := c.buildSourceEvent(ordinal, req.Msg); event != nil {
			events = append(events, event)
		}
	}
	response.Msg.State = paprikav1.DataState_DATA_STATE_OK
	response.Msg.Events = events
	response.Msg.NextCursor = next
	response.Msg.RetentionHorizonUnixMs = sourceEventFeed.horizon()
	response.Msg.RetentionLimit = sourceEventRetentionLimit
	return response, nil
}

func (c *consoleServer) buildSourceEvent(
	ordinal int,
	msg *paprikav1.ListSourceEventsRequest,
) *paprikav1.SourceEvent {
	application := c.eventApplication(ordinal, msg)
	if application == nil {
		return nil
	}
	kind := eventKind(ordinal, msg.GetKinds())
	shape := sourceEventShapes[kind]
	receivedAt := sourceEventFeed.timestamp(ordinal)
	index := fixtureApplicationIndex(application.GetName())
	state := fixtureStateFor(index)
	triggered, count, truncated := c.triggeredApplications(ordinal, application)
	return &paprikav1.SourceEvent{
		Identity: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: "event-" + strconv.Itoa(ordinal),
		},
		Kind:          kind,
		SourceType:    shape.sourceType,
		RepositoryUrl: "https://example.invalid/fixture/" + state.repository + ".git",
		Repository: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: state.repository,
		},
		Reference:                      shape.reference,
		Commit:                         syntheticCommit(application, ordinal, receivedAt),
		Provider:                       shape.provider,
		DeliveryId:                     "fixture-delivery-" + strconv.Itoa(ordinal),
		ReceivedAtUnixMs:               receivedAt,
		Outcome:                        sourceEventOutcomes[ordinal%len(sourceEventOutcomes)],
		TriggeredApplications:          triggered,
		TriggeredApplicationCount:      count,
		TriggeredApplicationsTruncated: truncated,
		Message:                        "source event recorded by the fleet console fixture",
	}
}

// eventApplication honours an explicit application filter before falling back
// to the ordinal's own namespace-scoped identity.
func (c *consoleServer) eventApplication(
	ordinal int,
	msg *paprikav1.ListSourceEventsRequest,
) *paprikav1.FleetObjectKey {
	if filters := msg.GetApplications(); len(filters) != 0 {
		return filters[ordinal%len(filters)]
	}
	return c.applicationKeyForOrdinal(ordinal, msg.Namespace)
}

func eventKind(ordinal int, filters []paprikav1.SourceEventKind) paprikav1.SourceEventKind {
	if len(filters) != 0 {
		return filters[ordinal%len(filters)]
	}
	return defaultSourceEventKinds[ordinal%len(defaultSourceEventKinds)]
}

// triggeredApplications returns the bounded inline list, the authoritative
// count, and whether the two differ. The count deliberately exceeds the list on
// some events so the console's "and N more" path is exercised.
func (c *consoleServer) triggeredApplications(
	ordinal int,
	application *paprikav1.FleetObjectKey,
) (listed []*paprikav1.FleetObjectKey, total uint32, truncated bool) {
	count := min(
		consoleSpread(consoleHash(application.GetName(), strconv.Itoa(ordinal)), 1, 120),
		c.applications,
	)
	inline := min(count, maxTriggeredApplications)
	listed = make([]*paprikav1.FleetObjectKey, 0, inline)
	for offset := range inline {
		index := (fixtureApplicationIndex(application.GetName()) + offset) % c.applications
		listed = append(listed, &paprikav1.FleetObjectKey{
			Namespace: fixtureNamespace(index), Name: fixtureApplicationName(index),
		})
	}
	return listed, countU32(count), count > inline
}
