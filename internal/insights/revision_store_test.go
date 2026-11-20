package insights

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// titledDocument is a stored dashboard whose title, and so its size, is fixed by the caller.
func titledDocument(t *testing.T, id, title string) []byte {
	t.Helper()
	return storedDashboardDocument(t, id, map[string]any{"title": title})
}

// tickingClock returns a clock that advances one second per reading, so revisions get distinct timestamps.
func tickingClock() func() time.Time {
	var tick int64
	return func() time.Time {
		tick++
		return time.Unix(tick, 0)
	}
}

func revisionNumbers(revs []*insightsv1.DashboardRevision) []uint32 {
	numbers := make([]uint32, 0, len(revs))
	for _, rev := range revs {
		numbers = append(numbers, rev.GetNumber())
	}
	return numbers
}

func openRevisionStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	require.NoError(t, err)
	store.now = tickingClock()
	return store, dir
}

func TestPutRecordsRevisionsWithMetadataAndExactBytes(t *testing.T) {
	store, _ := openRevisionStore(t)
	v1 := titledDocument(t, "demo", "First")
	v2 := titledDocument(t, "demo", "Second")
	author := &insightsv1.RevisionAuthor{Subject: "sub-1", Name: "Ada Lovelace"}

	_, rev, err := store.PutRevision("demo", v1, "", "", RevisionMeta{Author: author, Source: insightsv1.RevisionSource_REVISION_SOURCE_UI, Message: "first"})
	require.NoError(t, err)
	require.Equal(t, uint32(1), rev)
	tag2, rev, err := store.PutRevision("demo", v2, "", "", RevisionMeta{Source: insightsv1.RevisionSource_REVISION_SOURCE_MCP, Message: "second"})
	require.NoError(t, err)
	require.Equal(t, uint32(2), rev)

	revs, err := store.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{2, 1}, revisionNumbers(revs), "revisions are newest first")
	require.Equal(t, tag2, revs[0].GetEtag())
	require.Equal(t, "Second", revs[0].GetTitle())
	require.Equal(t, uint32(0), revs[0].GetWidgetCount())
	require.Equal(t, insightsv1.RevisionSource_REVISION_SOURCE_MCP, revs[0].GetSource())
	require.Equal(t, "second", revs[0].GetMessage())
	require.Equal(t, "sub-1", revs[1].GetAuthor().GetSubject())
	require.Equal(t, "Ada Lovelace", revs[1].GetAuthor().GetName())
	require.Equal(t, int64(1000), revs[1].GetCreatedAtUnixMs(), "the clock is read once per revision, so the first is tick one")
	require.EqualValues(t, len(v1), revs[1].GetSizeBytes())

	data, tag, err := store.RevisionDocument("demo", 1)
	require.NoError(t, err)
	require.Equal(t, string(v1), string(data), "a revision returns the exact stored bytes")
	require.Equal(t, etag(v1), tag)
}

func TestSaveWithUnchangedBytesAddsNoRevision(t *testing.T) {
	store, _ := openRevisionStore(t)
	document := titledDocument(t, "demo", "Same")
	_, _, err := store.PutRevision("demo", document, "", "", RevisionMeta{})
	require.NoError(t, err)
	_, rev, err := store.PutRevision("demo", document, "", "", RevisionMeta{Message: "no change"})
	require.NoError(t, err)
	require.Equal(t, uint32(1), rev, "the head number is unchanged")
	revs, err := store.Revisions("demo")
	require.NoError(t, err)
	require.Len(t, revs, 1)
}

func TestRetentionKeepsTwentyRevisionsAndNeverReusesNumbers(t *testing.T) {
	store, dir := openRevisionStore(t)
	var last uint32
	for i := 1; i <= 25; i++ {
		_, rev, err := store.PutRevision("demo", titledDocument(t, "demo", fmt.Sprintf("Save %02d", i)), "", "", RevisionMeta{})
		require.NoError(t, err)
		last = rev
	}
	require.Equal(t, uint32(25), last)

	revs, err := store.Revisions("demo")
	require.NoError(t, err)
	require.Len(t, revs, maxRevisionsPerDashboard)
	require.Equal(t, uint32(25), revs[0].GetNumber(), "the head is always kept")
	require.Equal(t, uint32(6), revs[len(revs)-1].GetNumber(), "the oldest five are pruned")

	_, _, err = store.RevisionDocument("demo", 5)
	require.ErrorIs(t, err, ErrRevisionNotFound)
	_, err = os.Stat(filepath.Join(dir, "revisions", "demo", "5.json"))
	require.ErrorIs(t, err, os.ErrNotExist, "a pruned blob is removed from disk")

	_, rev, err := store.PutRevision("demo", titledDocument(t, "demo", "Save 26"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.Equal(t, uint32(26), rev, "a pruned number is never reused")
}

func TestByteBudgetPrunesOldestNonHeadAcrossDashboards(t *testing.T) {
	store, _ := openRevisionStore(t)
	size := len(titledDocument(t, "aa", "Rev 00"))
	store.revisionBudget = int64(3 * size)

	for i, id := range []string{"aa", "aa", "bb", "bb"} {
		_, _, err := store.PutRevision(id, titledDocument(t, id, fmt.Sprintf("Rev %02d", i+1)), "", "", RevisionMeta{})
		require.NoError(t, err)
	}
	require.LessOrEqual(t, store.revisionBytes, store.revisionBudget)

	aaRevs, err := store.Revisions("aa")
	require.NoError(t, err)
	require.Equal(t, []uint32{2}, revisionNumbers(aaRevs), "the oldest non-head revision of aa is pruned first")
	bbRevs, err := store.Revisions("bb")
	require.NoError(t, err)
	require.Equal(t, []uint32{2, 1}, revisionNumbers(bbRevs))

	_, _, err = store.PutRevision("bb", titledDocument(t, "bb", "Rev 05"), "", "", RevisionMeta{})
	require.NoError(t, err)
	bbRevs, err = store.Revisions("bb")
	require.NoError(t, err)
	require.Equal(t, []uint32{3, 2}, revisionNumbers(bbRevs), "bb's oldest goes, because aa has only its head")
	aaRevs, err = store.Revisions("aa")
	require.NoError(t, err)
	require.Equal(t, []uint32{2}, revisionNumbers(aaRevs), "a dashboard's head is never pruned for the budget")
	require.LessOrEqual(t, store.revisionBytes, store.revisionBudget)
}

func TestDeleteRemovesRevisionHistory(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Two"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.NoError(t, store.Delete("demo", ""))

	_, err = os.Stat(filepath.Join(dir, "revisions", "demo"))
	require.ErrorIs(t, err, os.ErrNotExist, "the history directory is removed with the dashboard")
	require.Zero(t, store.revisionBytes)
	_, err = store.Revisions("demo")
	require.ErrorIs(t, err, ErrNotFound)

	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Again"), "", "", RevisionMeta{})
	require.NoError(t, err)
	revs, err := store.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{1}, revisionNumbers(revs), "a recreated dashboard starts a new history")
}

func TestOpenStoreIgnoresRevisionDirectoryAsDashboards(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "Kept"), "", "", RevisionMeta{})
	require.NoError(t, err)
	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Newer"), "", "", RevisionMeta{})
	require.NoError(t, err)

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	documents := reopened.List()
	require.Len(t, documents, 1, "the revisions tree is never loaded as a dashboard")
	revs, err := reopened.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{2, 1}, revisionNumbers(revs), "history survives a restart")
}

func TestStartupSeedsBaselineForExistingDashboards(t *testing.T) {
	dir := t.TempDir()
	document := titledDocument(t, "legacy", "Before history")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "legacy.json"), document, 0o600))

	store, err := OpenStore(dir)
	require.NoError(t, err)
	revs, err := store.Revisions("legacy")
	require.NoError(t, err)
	require.Len(t, revs, 1)
	require.Equal(t, uint32(1), revs[0].GetNumber())
	require.Equal(t, insightsv1.RevisionSource_REVISION_SOURCE_BASELINE, revs[0].GetSource())
	require.Equal(t, etag(document), revs[0].GetEtag())

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	revs, err = reopened.Revisions("legacy")
	require.NoError(t, err)
	require.Len(t, revs, 1, "an unchanged dashboard is not seeded again")
}

func TestStartupRemovesUnreferencedRevisionFiles(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	stray := filepath.Join(dir, "revisions", "demo", "99.json")
	require.NoError(t, os.WriteFile(stray, []byte("left by a crash"), 0o600))
	temp := filepath.Join(dir, "revisions", "demo", ".document-123")
	require.NoError(t, os.WriteFile(temp, []byte("partial"), 0o600))

	_, err = OpenStore(dir)
	require.NoError(t, err)
	_, err = os.Stat(stray)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = os.Stat(temp)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = os.Stat(filepath.Join(dir, "revisions", "demo", "1.json"))
	require.NoError(t, err, "a referenced revision is kept")
}

func TestStartupRepairsHeadAfterCrashBetweenFiles(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "Indexed"), "", "", RevisionMeta{})
	require.NoError(t, err)
	// A crash after the current file was replaced but before the index was rewritten leaves exactly this state.
	crashed := titledDocument(t, "demo", "Not indexed")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "demo.json"), crashed, 0o600))

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	revs, err := reopened.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{2, 1}, revisionNumbers(revs), "the head is repaired and the earlier revision is kept")
	require.Equal(t, insightsv1.RevisionSource_REVISION_SOURCE_BASELINE, revs[0].GetSource())
	require.Equal(t, etag(crashed), revs[0].GetEtag())
	data, _, err := reopened.RevisionDocument("demo", 2)
	require.NoError(t, err)
	require.Equal(t, string(crashed), string(data))
}

// Numbered files with no index are unreferenced leftovers. Startup sets them aside before seeding the baseline, so the
// baseline's revision 1 never overwrites them.
func TestStartupSetsAsideNumberedHistoryWithoutIndex(t *testing.T) {
	dir := t.TempDir()
	document := titledDocument(t, "demo", "Current")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "demo.json"), document, 0o600))
	history := filepath.Join(dir, "revisions", "demo")
	require.NoError(t, os.MkdirAll(history, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(history, "1.json"), []byte("earlier history"), 0o600))

	store, err := OpenStore(dir)
	require.NoError(t, err)
	revs, err := store.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{1}, revisionNumbers(revs))
	require.Equal(t, insightsv1.RevisionSource_REVISION_SOURCE_BASELINE, revs[0].GetSource())
	data, _, err := store.RevisionDocument("demo", 1)
	require.NoError(t, err)
	require.Equal(t, string(document), string(data), "the baseline is the current document, not the stale file")

	moved, err := filepath.Glob(filepath.Join(dir, "quarantine", "revisions", "demo.*", "1.json"))
	require.NoError(t, err)
	require.Len(t, moved, 1, "the stale revision 1 is kept under quarantine")
	kept, err := os.ReadFile(moved[0])
	require.NoError(t, err)
	require.Equal(t, "earlier history", string(kept))
}

func TestCorruptRevisionIndexIsQuarantinedAndRebuiltAfterStartup(t *testing.T) {
	store, dir := openRevisionStore(t)
	document := titledDocument(t, "demo", "Stable")
	_, _, err := store.PutRevision("demo", document, "", "", RevisionMeta{})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "revisions", "demo", "index.json"), []byte("{not an index"), 0o600))

	reopened, err := OpenStore(dir)
	require.NoError(t, err, "a corrupt index never blocks startup")
	revs, err := reopened.Revisions("demo")
	require.NoError(t, err)
	require.Empty(t, revs, "the history waits for startup to finish")
	_, _, err = reopened.PutRevision("demo", titledDocument(t, "demo", "Edited"), "", "", RevisionMeta{})
	require.NoError(t, err, "a save during the repair window still succeeds")
	require.EqualValues(t, 1, reopened.RevisionWriteFailures(), "the save's history write is refused and counted")

	require.NoError(t, reopened.commitQuarantine())
	quarantined, err := filepath.Glob(filepath.Join(dir, "quarantine", "revisions", "demo.*", "index.json"))
	require.NoError(t, err)
	require.Len(t, quarantined, 1, "the corrupt index is kept under quarantine")
	revs, err = reopened.Revisions("demo")
	require.NoError(t, err)
	require.Len(t, revs, 1, "the history is rebuilt from the current document")
	require.Equal(t, insightsv1.RevisionSource_REVISION_SOURCE_BASELINE, revs[0].GetSource())

	again, err := OpenStore(dir)
	require.NoError(t, err)
	require.NoError(t, again.commitQuarantine())
	revs, err = again.Revisions("demo")
	require.NoError(t, err)
	require.Len(t, revs, 1, "a second start quarantines nothing again")
}

func TestFailedHistoryWriteKeepsTheSave(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "Before"), "", "", RevisionMeta{})
	require.NoError(t, err)
	// A regular file where the history directory belongs makes every history write fail.
	require.NoError(t, os.RemoveAll(filepath.Join(dir, "revisions", "demo")))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "revisions", "demo"), []byte("blocked"), 0o600))

	after := titledDocument(t, "demo", "After")
	tag, rev, err := store.PutRevision("demo", after, "", "", RevisionMeta{})
	require.NoError(t, err, "the save succeeds when its history write fails")
	require.Equal(t, etag(after), tag)
	require.Zero(t, rev, "no revision is named while the history write fails")
	doc, _, err := store.Get("demo")
	require.NoError(t, err)
	require.Equal(t, string(after), string(doc), "the current document is the source of truth")
	require.EqualValues(t, 1, store.RevisionWriteFailures())
}

func TestRevisionMessageIsBoundedInUTF16Units(t *testing.T) {
	store, _ := openRevisionStore(t)
	document := titledDocument(t, "demo", "Message")
	_, _, err := store.PutRevision("demo", document, "", "", RevisionMeta{Message: strings.Repeat("a", 201)})
	require.ErrorIs(t, err, errRevisionMessageLength)
	require.ErrorContains(t, err, "200 UTF-16 units", "the limit is stated in the units the server counts")
	_, _, err = store.Get("demo")
	require.ErrorIs(t, err, ErrNotFound, "a refused message stores nothing")

	_, _, err = store.PutRevision("demo", document, "", "", RevisionMeta{Message: strings.Repeat("😀", 100)})
	require.NoError(t, err, "200 units of a surrogate pair is accepted")
	_, _, err = store.PutRevision("demo", document, "", "", RevisionMeta{Message: strings.Repeat("😀", 101)})
	require.ErrorIs(t, err, errRevisionMessageLength)
}

func TestPutRefusesStaleIfMatchWithoutRecordingRevision(t *testing.T) {
	store, _ := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Two"), `"stale"`, "", RevisionMeta{})
	require.ErrorIs(t, err, ErrConflict)
	revs, err := store.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{1}, revisionNumbers(revs))
}

// The failure counter reads the store at collection time, so a failed history write shows up in the metric and a save
// that succeeded does not.
func TestRevisionFailureCounterReportsFailedHistoryWrites(t *testing.T) {
	store, dir := openRevisionStore(t)
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	require.NoError(t, registerRevisionFailureCounter(provider.Meter("test"), store))

	failures := func() int64 {
		var collected metricdata.ResourceMetrics
		require.NoError(t, reader.Collect(context.Background(), &collected))
		for _, scope := range collected.ScopeMetrics {
			for _, m := range scope.Metrics {
				if m.Name != revisionFailureMetric {
					continue
				}
				sum, ok := m.Data.(metricdata.Sum[int64])
				require.True(t, ok, "the failure counter is an int64 sum")
				var total int64
				for _, point := range sum.DataPoints {
					total += point.Value
				}
				return total
			}
		}
		t.Fatalf("%s was not reported", revisionFailureMetric)
		return 0
	}

	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "Clean"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.Zero(t, failures())

	require.NoError(t, os.RemoveAll(filepath.Join(dir, "revisions", "demo")))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "revisions", "demo"), []byte("blocked"), 0o600))
	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Blocked"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.EqualValues(t, 1, failures())
}

// A save whose history write fails names no revision: the head on disk holds other bytes, so it is reported as zero.
func TestFailedHistoryWriteReturnsNoHeadRevision(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, rev, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.EqualValues(t, 1, rev)
	// The history directory is made read-only, so the next revision cannot be written.
	history := filepath.Join(dir, "revisions", "demo")
	require.NoError(t, os.Chmod(history, 0o500))       //nolint:gosec // a read-only history directory is the failure under test
	t.Cleanup(func() { _ = os.Chmod(history, 0o700) }) //nolint:gosec // restores the directory so the temp dir can be removed
	if os.Geteuid() == 0 {
		t.Skip("file permissions do not stop root")
	}

	after := titledDocument(t, "demo", "Two")
	tag, rev, err := store.PutRevision("demo", after, "", "", RevisionMeta{})
	require.NoError(t, err, "the save succeeds when its history write fails")
	require.Equal(t, etag(after), tag)
	require.Zero(t, rev, "the previous head holds different bytes, so no revision is named")
	require.EqualValues(t, 1, store.RevisionWriteFailures())
}

// A dashboard created again while an earlier history is still on disk must not write over that history's numbered files.
func TestRecreatingADashboardSetsAsideItsStaleHistory(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Two"), "", "", RevisionMeta{})
	require.NoError(t, err)
	// The current document goes missing while its history stays on disk, as a quarantined document leaves it.
	require.NoError(t, os.Remove(filepath.Join(dir, "demo.json")))

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	_, rev, err := reopened.PutRevision("demo", titledDocument(t, "demo", "Reborn"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.EqualValues(t, 1, rev, "the new history starts at its first number")
	require.Zero(t, reopened.RevisionWriteFailures())
	kept, err := filepath.Glob(filepath.Join(dir, "quarantine", "revisions", "demo.*", "2.json"))
	require.NoError(t, err)
	require.Len(t, kept, 1, "the earlier revision 2 is kept under quarantine, not overwritten or deleted")
	revs, err := reopened.Revisions("demo")
	require.NoError(t, err)
	require.Equal(t, []uint32{1}, revisionNumbers(revs))
}

// A corrupt index does not make its revision files unreferenced. They move to quarantine with the index.
func TestCorruptRevisionIndexKeepsItsRevisionFiles(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	_, _, err = store.PutRevision("demo", titledDocument(t, "demo", "Two"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "revisions", "demo", "index.json"), []byte("{not an index"), 0o600))

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	require.NoError(t, reopened.commitQuarantine())
	for _, n := range []string{"1.json", "2.json"} {
		kept, err := filepath.Glob(filepath.Join(dir, "quarantine", "revisions", "demo.*", n))
		require.NoError(t, err)
		require.Len(t, kept, 1, "%s is kept for an operator to read", n)
	}
}

// A quarantine that cannot be written is counted, not fatal: the store opens and keeps serving the dashboard.
func TestCorruptRevisionIndexDoesNotBlockStartupWhenQuarantineFails(t *testing.T) {
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "Stable"), "", "", RevisionMeta{})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "revisions", "demo", "index.json"), []byte("{not an index"), 0o600))
	// A regular file where the quarantine directory belongs makes the move fail.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "quarantine"), []byte("blocked"), 0o600))

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	require.NoError(t, reopened.commitQuarantine(), "a history that cannot be quarantined never fails startup")
	doc, _, err := reopened.Get("demo")
	require.NoError(t, err)
	require.Equal(t, string(titledDocument(t, "demo", "Stable")), string(doc))
	_, _, err = reopened.PutRevision("demo", titledDocument(t, "demo", "Edited"), "", "", RevisionMeta{})
	require.NoError(t, err, "a save still succeeds while its history is refused")
	require.Positive(t, reopened.RevisionWriteFailures())
}

// An index that exists but cannot be read is not corrupt: its files stay in place and the history waits for a restart.
func TestUnreadableRevisionIndexIsNotQuarantined(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("file permissions do not stop root")
	}
	store, dir := openRevisionStore(t)
	_, _, err := store.PutRevision("demo", titledDocument(t, "demo", "One"), "", "", RevisionMeta{})
	require.NoError(t, err)
	index := filepath.Join(dir, "revisions", "demo", "index.json")
	require.NoError(t, os.Chmod(index, 0))
	t.Cleanup(func() { _ = os.Chmod(index, 0o600) })

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	require.NoError(t, reopened.commitQuarantine())
	_, err = os.Stat(index)
	require.NoError(t, err, "the unreadable index stays where it is")
	kept, err := filepath.Glob(filepath.Join(dir, "quarantine", "revisions", "demo.*"))
	require.NoError(t, err)
	require.Empty(t, kept)
	require.Positive(t, reopened.RevisionWriteFailures())
}
