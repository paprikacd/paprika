package main

import (
	"strconv"
	"strings"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// Retention limits and spacings for the three record feeds.
//
// Records are immutable, so these feeds have no staleness budget. What they
// have instead are completeness markers: a retention limit and a horizon. Both
// are mandatory on every aggregate (design section 4.5, rule 3) because a
// windowed count presented as a lifetime one is a lie the console cannot detect.
const (
	sourceEventRetentionLimit    = 500
	rolloutHistoryRetentionLimit = 200
	pipelineRunRetentionLimit    = 200

	defaultHistoryPageSize = 25

	sourceEventSpacingMs    = 7 * 60 * 1000
	rolloutHistorySpacingMs = 47 * 60 * 1000
	pipelineRunSpacingMs    = 23 * 60 * 1000
)

// historyFeed describes one bounded, descending, immutable record feed.
//
// Every feed is generated on demand from an ordinal, never materialized: at
// --applications 10000 a page still costs one page's worth of allocation,
// because nothing here is indexed by application. Ordinal 0 is the newest
// record and ordinals run backwards in time at a fixed spacing, which is what
// makes since_unix_ms a prefix of the feed rather than a scan of it.
type historyFeed struct {
	limit     int
	spacingMs int64
}

func (f historyFeed) timestamp(ordinal int) int64 {
	return consoleNowUnixMs() - int64(ordinal)*f.spacingMs
}

func (f historyFeed) horizon() int64 {
	return f.timestamp(f.limit - 1)
}

// window resolves one page request into the half-open ordinal range to emit.
// It returns the next cursor separately so the caller cannot forget to publish
// the completeness marker that says whether more records exist.
func (f historyFeed) window(
	pageSize uint32,
	cursor string,
	sinceUnixMs int64,
) (start, end int, nextCursor string) {
	start = decodeFixtureCursor(cursor)
	limit := int(pageSize)
	if limit <= 0 || limit > defaultHistoryPageSize {
		limit = defaultHistoryPageSize
	}
	end = min(start+limit, f.limit)
	// Ordinals descend in time, so the since filter truncates the tail of the
	// page rather than filtering it record by record.
	for end > start && f.timestamp(end-1) < sinceUnixMs {
		end--
	}
	if end <= start {
		return 0, 0, ""
	}
	if end >= f.limit || f.timestamp(end) < sinceUnixMs {
		return start, end, ""
	}
	return start, end, encodeFixtureCursor(end)
}

var (
	sourceEventFeed    = historyFeed{limit: sourceEventRetentionLimit, spacingMs: sourceEventSpacingMs}
	rolloutHistoryFeed = historyFeed{limit: rolloutHistoryRetentionLimit, spacingMs: rolloutHistorySpacingMs}
	pipelineRunFeed    = historyFeed{limit: pipelineRunRetentionLimit, spacingMs: pipelineRunSpacingMs}
)

// applicationKeyForOrdinal maps a feed ordinal onto a seeded application,
// honouring an optional namespace filter arithmetically rather than by scanning
// the fleet. It returns nil for a namespace this fixture never seeded, which
// makes the feed empty rather than inventing an application there.
func (c *consoleServer) applicationKeyForOrdinal(ordinal int, namespace *string) *paprikav1.FleetObjectKey {
	if c.applications <= 0 {
		return nil
	}
	index := ordinal % c.applications
	if namespace != nil {
		offset, ok := seededNamespaceIndex(*namespace)
		if !ok {
			return nil
		}
		// Application i lives in namespace i mod fixtureNamespaceCount, so the
		// applications of one namespace are an arithmetic progression.
		count := (c.applications - offset + fixtureNamespaceCount - 1) / fixtureNamespaceCount
		if count <= 0 {
			return nil
		}
		index = offset + fixtureNamespaceCount*(ordinal%count)
	}
	return &paprikav1.FleetObjectKey{
		Namespace: fixtureNamespace(index), Name: fixtureApplicationName(index),
	}
}

func seededNamespaceIndex(namespace string) (int, bool) {
	suffix, found := strings.CutPrefix(namespace, "team-")
	if !found {
		return 0, false
	}
	index, err := strconv.Atoi(suffix)
	if err != nil || index < 0 || index >= fixtureNamespaceCount {
		return 0, false
	}
	return index, true
}

// syntheticCommit builds the commit metadata behind one record. Every field is
// derived from the identity and the ordinal, so the same revision always
// carries the same author and message wherever the console shows it.
func syntheticCommit(key *paprikav1.FleetObjectKey, ordinal int, committedAt int64) *paprikav1.CommitInfo {
	seed := consoleHash(key.GetNamespace(), key.GetName(), strconv.Itoa(ordinal))
	revision := revisionForSeed(seed)
	author := commitAuthors[int(seed)%len(commitAuthors)]
	return &paprikav1.CommitInfo{
		State:             paprikav1.DataState_DATA_STATE_OK,
		Revision:          revision,
		ShortRevision:     revision[:7],
		AuthorName:        author.name,
		AuthorEmail:       author.email,
		Message:           commitSubjects[int(seed>>8)%len(commitSubjects)],
		CommittedAtUnixMs: committedAt,
		Url:               "https://example.invalid/" + key.GetName() + "/commit/" + revision,
	}
}

// revisionForSeed produces a 40-character hex string. Real SHAs are 40
// characters and the console truncates them itself, so a shorter stand-in would
// leave the truncation path untested.
func revisionForSeed(seed uint32) string {
	var builder strings.Builder
	builder.Grow(40)
	state := uint64(seed) | 1
	for range 5 {
		state = state*6364136223846793005 + 1442695040888963407
		builder.WriteString(strconv.FormatUint(state&0xFFFFFFFF, 16) + "0000000")
	}
	return builder.String()[:40]
}

type commitAuthor struct {
	name  string
	email string
}

var commitAuthors = [...]commitAuthor{
	{name: "Rae Whitmore", email: "rae.whitmore@example.invalid"},
	{name: "Tomas Iyer", email: "tomas.iyer@example.invalid"},
	{name: "Priya Nandakumar", email: "priya.nandakumar@example.invalid"},
	{name: "Ken Ashworth", email: "ken.ashworth@example.invalid"},
}

var commitSubjects = [...]string{
	"Raise the checkout worker pool to 12",
	"Pin the base image to the December digest",
	"Drop the retired ledger migration job",
	"Add readiness probe to the settlement sidecar",
	"Reduce the reconcile interval to 30s",
}
