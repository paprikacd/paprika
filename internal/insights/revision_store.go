package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/metric"
	"google.golang.org/protobuf/proto"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// Revision history keeps the bytes of each earlier dashboard save so an operator or agent can read and restore them.
// Layout below the data root:
//
//	revisions/<id>/index.json   the protojson DashboardRevisionIndex, oldest revision first
//	revisions/<id>/<n>.json     the exact document bytes of revision n
//
// The current document stays <id>.json and remains the source of truth. A revision is written after the current file,
// so a crash between the two leaves a head that differs from the document. Startup repairs that drift with a baseline
// revision. Revisions are never reused: next_number only grows, even after pruning.
const (
	// maxRevisionsPerDashboard is how many revisions one dashboard keeps. The head is always the newest.
	maxRevisionsPerDashboard = 20
	// maxRevisionStoreBytes bounds the blob bytes of all revisions together. It is about twenty times the measured live
	// use and far below the 1Gi volume the chart mounts, even with every dashboard at its maximum size.
	maxRevisionStoreBytes = 64 << 20
	// maxRevisionMessageUnits caps a revision message in UTF-16 code units.
	maxRevisionMessageUnits = 200
	// maxRevisionIndexBytes caps an index.json read. A full index is about 20 entries of a few hundred bytes each.
	maxRevisionIndexBytes = 4 << 20

	revisionsDirName      = "revisions"
	revisionIndexFileName = "index.json"
	revisionIndexFile     = "index"
	revisionSchemaVersion = 1
	// quarantineKindRevisions names the quarantine subdirectory and the counter kind for a corrupt revision index.
	quarantineKindRevisions = "revision_history"
	revisionFailureMetric   = "paprika_insights_revision_write_failures"
	documentTempPrefix      = ".document-"
)

var (
	// ErrRevisionNotFound reports a revision number the dashboard does not keep.
	ErrRevisionNotFound = errors.New("dashboard revision not found")
	// errRevisionRepairPending reports a dashboard whose corrupt history is rebuilt when startup completes.
	errRevisionRepairPending = errors.New("dashboard history is rebuilt when startup completes")
	errRevisionMessageLength = errors.New("revision message is longer than 200 UTF-16 units")
	// errRevisionIndexCorrupt marks an index that exists but cannot be trusted. Its files are quarantined. A read error
	// is not corruption: the files stay where they are.
	errRevisionIndexCorrupt = errors.New("revision index is corrupt")
)

// RevisionMeta says who wrote a revision and why. Put passes the zero value, so its revisions carry no author.
type RevisionMeta struct {
	Author              *insightsv1.RevisionAuthor
	Source              insightsv1.RevisionSource
	Message             string
	RestoredFrom        uint32
	SavedQueries        []*insightsv1.SavedQueryPin
	DriftedSavedQueries []*insightsv1.SavedQueryPin
}

// revisionHistory is the in-memory index of one dashboard. The index is loaded at open and kept in step with
// index.json. rebuild is set while a corrupt index waits for startup to finish, so no write touches its files.
type revisionHistory struct {
	index   *insightsv1.DashboardRevisionIndex
	rebuild error
}

// pendingRevisionQuarantine is a corrupt revision index found at open. It is moved aside in commitQuarantine, after
// which the history is rebuilt from the current document.
type pendingRevisionQuarantine struct {
	root   string
	id     string
	reason error
}

// PutRevision saves a document like Put and records a revision when its bytes differ from the head. It returns the new
// ETag and the head revision number. A failed history write does not fail the save: the failure is logged, counted in
// paprika_insights_revision_write_failures_total, and repaired at the next startup.
//
//nolint:gocritic // The metadata is copied once per save; the value keeps callers from changing it after the call.
func (s *Store) PutRevision(id string, document Dashboard, ifMatch, ifNoneMatch string, meta RevisionMeta) (string, uint32, error) {
	if err := validateDashboard(id, document); err != nil {
		return "", 0, err
	}
	if stringUnits(meta.Message) > maxRevisionMessageUnits {
		return "", 0, errRevisionMessageLength
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.admitLocked(id, document, ifMatch, ifNoneMatch); err != nil {
		return "", 0, err
	}
	if err := s.persist(id, document); err != nil {
		return "", 0, err
	}
	s.documents[id] = bytes.Clone(document)
	tag := etag(document)
	if err := s.recordRevisionLocked(id, document, tag, &meta); err != nil {
		s.recordRevisionWriteFailure(id, err)
		// The head is the previous revision, which holds other bytes, so the save names no revision.
		return tag, 0, nil
	}
	if s.headEtagLocked(id) != tag {
		return tag, 0, nil
	}
	return tag, s.headRevisionLocked(id), nil
}

// headEtagLocked returns the ETag of the newest revision, or "" when the dashboard has no history.
func (s *Store) headEtagLocked(id string) string {
	h := s.revisions[id]
	if h == nil {
		return ""
	}
	revs := h.index.GetRevisions()
	if len(revs) == 0 {
		return ""
	}
	return revs[len(revs)-1].GetEtag()
}

// admitLocked applies the preconditions and capacity limits that decide whether a save may proceed.
func (s *Store) admitLocked(id string, document Dashboard, ifMatch, ifNoneMatch string) error {
	previous, exists := s.documents[id]
	if err := preconditions(previous, exists, ifMatch, ifNoneMatch); err != nil {
		return err
	}
	if !exists && len(s.documents) >= maxDashboards {
		return ErrCapacity
	}
	total := len(document)
	for key, doc := range s.documents {
		if key != id {
			total += len(doc)
		}
	}
	if total > maxStoreBytes {
		return ErrCapacity
	}
	return nil
}

// recordRevisionLocked appends a revision unless the bytes equal the head, so a save that changes nothing adds nothing.
func (s *Store) recordRevisionLocked(id string, document Dashboard, tag string, meta *RevisionMeta) error {
	if h := s.revisions[id]; h != nil && h.rebuild == nil {
		if revs := h.index.GetRevisions(); len(revs) > 0 && revs[len(revs)-1].GetEtag() == tag {
			return nil
		}
	}
	_, err := s.appendRevisionLocked(id, document, tag, meta)
	return err
}

// Revisions returns the retained revisions of a dashboard, newest first.
func (s *Store) Revisions(id string) ([]*insightsv1.DashboardRevision, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.documents[id]; !ok {
		return nil, ErrNotFound
	}
	var revs []*insightsv1.DashboardRevision
	if h := s.revisions[id]; h != nil {
		revs = h.index.GetRevisions()
	}
	out := make([]*insightsv1.DashboardRevision, 0, len(revs))
	for i := len(revs) - 1; i >= 0; i-- {
		out = append(out, cloneRevision(revs[i]))
	}
	return out, nil
}

// RevisionDocument returns the exact stored bytes of revision n and the ETag they hash to.
func (s *Store) RevisionDocument(id string, n uint32) (document Dashboard, version string, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.documents[id]; !ok {
		return nil, "", ErrNotFound
	}
	h := s.revisions[id]
	if h == nil {
		return nil, "", ErrRevisionNotFound
	}
	var entry *insightsv1.DashboardRevision
	for _, rev := range h.index.GetRevisions() {
		if rev.GetNumber() == n {
			entry = rev
			break
		}
	}
	if entry == nil {
		return nil, "", ErrRevisionNotFound
	}
	data, err := readStoreDocument(s.revisionDir(id), revisionBlobName(n), maxDocumentBytes)
	if err != nil {
		return nil, "", fmt.Errorf("read revision %d: %w", n, err)
	}
	if etag(data) != entry.GetEtag() {
		return nil, "", fmt.Errorf("revision %d does not match its recorded ETag", n)
	}
	return data, entry.GetEtag(), nil
}

// RevisionWriteFailures reports how many history writes have failed since the store opened.
func (s *Store) RevisionWriteFailures() int64 {
	return s.revisionWriteFailures.Load()
}

func (s *Store) headRevisionLocked(id string) uint32 {
	h := s.revisions[id]
	if h == nil {
		return 0
	}
	revs := h.index.GetRevisions()
	if len(revs) == 0 {
		return 0
	}
	return revs[len(revs)-1].GetNumber()
}

// appendRevisionLocked writes revision blob, then the index, then prunes what the limits no longer keep. The blob is
// written first, so the index never names a file that is missing.
func (s *Store) appendRevisionLocked(id string, document Dashboard, tag string, meta *RevisionMeta) (uint32, error) {
	h := s.revisions[id]
	if h == nil {
		// No history is loaded, so any directory on disk belongs to an earlier dashboard with this id. Its numbered
		// files must not be written over, so it is set aside before the new history starts.
		if err := s.setAsideStaleHistory(id); err != nil {
			return 0, err
		}
		h = &revisionHistory{index: newRevisionIndex(id)}
	}
	if h.rebuild != nil {
		return 0, errRevisionRepairPending
	}
	number := max(h.index.GetNextNumber(), 1)
	dir := s.revisionDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0, fmt.Errorf("create revision directory: %w", err)
	}
	if err := persistFile(dir, revisionBlobID(number), document); err != nil {
		return 0, fmt.Errorf("write revision %d: %w", number, err)
	}
	next := cloneRevisionIndex(h.index)
	next.Revisions = append(next.Revisions, s.newRevisionEntry(number, document, tag, meta))
	next.NextNumber = number + 1
	var dropped []*insightsv1.DashboardRevision
	for len(next.Revisions) > s.revisionLimit {
		dropped = append(dropped, next.Revisions[0])
		next.Revisions = next.Revisions[1:]
	}
	if err := writeRevisionIndex(dir, next); err != nil {
		return 0, err
	}
	s.revisions[id] = &revisionHistory{index: next}
	s.revisionBytes += int64(len(document))
	for _, old := range dropped {
		s.revisionBytes -= int64(old.GetSizeBytes())
		removeRevisionBlob(dir, old.GetNumber())
	}
	return number, s.pruneRevisionBudgetLocked()
}

// pruneRevisionBudgetLocked drops the oldest non-head revision of any dashboard until the blob bytes fit the budget.
// The head is never a candidate, so a dashboard always keeps its current revision.
func (s *Store) pruneRevisionBudgetLocked() error {
	for s.revisionBytes > s.revisionBudget {
		victim, oldest := "", (*insightsv1.DashboardRevision)(nil)
		for _, id := range slices.Sorted(maps.Keys(s.revisions)) {
			revs := s.revisions[id].index.GetRevisions()
			if len(revs) < 2 {
				continue
			}
			if oldest == nil || revs[0].GetCreatedAtUnixMs() < oldest.GetCreatedAtUnixMs() {
				victim, oldest = id, revs[0]
			}
		}
		if oldest == nil {
			return nil
		}
		h := s.revisions[victim]
		next := cloneRevisionIndex(h.index)
		next.Revisions = next.Revisions[1:]
		dir := s.revisionDir(victim)
		if err := writeRevisionIndex(dir, next); err != nil {
			return fmt.Errorf("prune revision history: %w", err)
		}
		h.index = next
		s.revisionBytes -= int64(oldest.GetSizeBytes())
		removeRevisionBlob(dir, oldest.GetNumber())
	}
	return nil
}

func (s *Store) newRevisionEntry(number uint32, document Dashboard, tag string, meta *RevisionMeta) *insightsv1.DashboardRevision {
	var parsed dashboardDocument
	// The document passed validation, so it parses. A failure leaves the title empty and the widget count at zero.
	if err := json.Unmarshal(document, &parsed); err != nil {
		slog.Warn("revision document does not parse; its title and widget count are left empty", "error", err)
	}
	entry := &insightsv1.DashboardRevision{
		Number:              number,
		Etag:                tag,
		Source:              meta.Source,
		Message:             meta.Message,
		CreatedAtUnixMs:     s.clock().UnixMilli(),
		SizeBytes:           checkwire.Count(len(document)),
		WidgetCount:         checkwire.Count(len(parsed.Widgets)),
		Title:               parsed.Title,
		RestoredFrom:        meta.RestoredFrom,
		SavedQueries:        slices.Clone(meta.SavedQueries),
		DriftedSavedQueries: slices.Clone(meta.DriftedSavedQueries),
	}
	if meta.Author != nil {
		entry.Author = &insightsv1.RevisionAuthor{Subject: meta.Author.GetSubject(), Name: meta.Author.GetName()}
	}
	return entry
}

// cloneRevision and cloneRevisionIndex copy a message so the in-memory index never shares memory with a caller. Clone
// returns the type it was given, so the fallback is never taken.
func cloneRevision(rev *insightsv1.DashboardRevision) *insightsv1.DashboardRevision {
	clone, ok := proto.Clone(rev).(*insightsv1.DashboardRevision)
	if !ok {
		return &insightsv1.DashboardRevision{}
	}
	return clone
}

func cloneRevisionIndex(index *insightsv1.DashboardRevisionIndex) *insightsv1.DashboardRevisionIndex {
	clone, ok := proto.Clone(index).(*insightsv1.DashboardRevisionIndex)
	if !ok {
		return newRevisionIndex(index.GetDashboardId())
	}
	return clone
}

// removeRevisionHistoryLocked deletes a dashboard's history with the dashboard. A failed delete is counted and left for
// the next startup to report; the dashboard is already gone.
func (s *Store) removeRevisionHistoryLocked(id string) {
	if h := s.revisions[id]; h != nil {
		for _, rev := range h.index.GetRevisions() {
			s.revisionBytes -= int64(rev.GetSizeBytes())
		}
		delete(s.revisions, id)
	}
	s.pendingRevisions = slices.DeleteFunc(s.pendingRevisions, func(p pendingRevisionQuarantine) bool { return p.id == id })
	if err := os.RemoveAll(s.revisionDir(id)); err != nil {
		s.recordRevisionWriteFailure(id, fmt.Errorf("delete revision history: %w", err))
		return
	}
	if err := syncDirectory(filepath.Join(s.dir, revisionsDirName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("could not sync revision directory after delete", "dashboard", id, "error", err)
	}
}

// reconcileRevisions brings each loaded dashboard's history in step with its current document at startup. It never
// fails the store: a dashboard whose history cannot be read or written keeps serving, and its history is repaired.
func (s *Store) reconcileRevisions() {
	for _, id := range slices.Sorted(maps.Keys(s.documents)) {
		s.reconcileDashboardRevisions(id)
	}
	s.revisionBytes = 0
	for _, h := range s.revisions {
		for _, rev := range h.index.GetRevisions() {
			s.revisionBytes += int64(rev.GetSizeBytes())
		}
	}
	if err := s.pruneRevisionBudgetLocked(); err != nil {
		slog.Warn("could not prune revision history to its budget at startup", "error", err)
	}
}

// reconcileDashboardRevisions repairs one dashboard's history. It seeds a missing history, rebuilds the head when it
// differs from the current document, and defers a corrupt index to commitRevisionQuarantine. A file that cannot be read
// is not moved: its history is refused until the next start, and its files, which may be the only copy, are kept.
func (s *Store) reconcileDashboardRevisions(id string) {
	document := s.documents[id]
	tag := etag(document)
	dir := s.revisionDir(id)
	index, err := readRevisionIndex(dir)
	if err == nil {
		err = validateRevisionIndex(id, index)
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		s.startFreshHistory(id, document, tag)
		return
	case errors.Is(err, errRevisionIndexCorrupt) || errors.Is(err, errDocumentTooLarge):
		// The index is kept for the operator. The history restarts after startup moves it aside. The blobs it named are
		// kept too, so the sweep below must not run.
		s.revisions[id] = &revisionHistory{index: newRevisionIndex(id), rebuild: err}
		s.pendingRevisions = append(s.pendingRevisions, pendingRevisionQuarantine{root: s.dir, id: id, reason: err})
		return
	case err != nil:
		s.revisions[id] = &revisionHistory{index: newRevisionIndex(id), rebuild: err}
		slog.Warn("could not read dashboard history; it is refused until the next start", "dashboard", id, "error", err)
		s.revisionWriteFailures.Add(1)
		return
	default:
		s.revisions[id] = &revisionHistory{index: index}
		if revs := index.GetRevisions(); len(revs) == 0 || revs[len(revs)-1].GetEtag() != tag {
			s.seedBaseline(id, document, tag)
		}
	}
	if err := sweepRevisionOrphans(dir, s.revisions[id].index); err != nil {
		slog.Warn("could not remove unreferenced revision files", "dashboard", id, "error", err)
	}
}

// startFreshHistory starts the history of a dashboard that has no index. Numbered files left on disk are unreferenced, so
// they are set aside before the baseline is written, and the baseline's revision 1 cannot overwrite one of them. A history
// that cannot be set aside is refused until the next start, and its files are kept.
func (s *Store) startFreshHistory(id string, document Dashboard, tag string) {
	if err := s.setAsideStaleHistory(id); err != nil {
		s.revisions[id] = &revisionHistory{index: newRevisionIndex(id), rebuild: err}
		s.recordRevisionWriteFailure(id, err)
		return
	}
	s.revisions[id] = &revisionHistory{index: newRevisionIndex(id)}
	s.seedBaseline(id, document, tag)
}

// seedBaseline records the current document as a baseline revision. Its author and message are unknown. Its saved-query
// pins are filled in by backfillBaselinePins once the saved-query store is open.
func (s *Store) seedBaseline(id string, document Dashboard, tag string) {
	if _, err := s.appendRevisionLocked(id, document, tag, &RevisionMeta{Source: insightsv1.RevisionSource_REVISION_SOURCE_BASELINE}); err != nil {
		s.recordRevisionWriteFailure(id, err)
	}
}

// backfillBaselinePins records saved-query pins on baseline heads seeded without them. OpenStore seeds baselines before
// the saved-query store opens, so NewServer calls this afterwards. A baseline is the current document, and the pins are
// the saved-query ETags at the same moment, so they match what the baseline reads. A failed rewrite is counted and the
// baseline keeps no pins until the next start.
func (s *Store) backfillBaselinePins(pins func(Dashboard) []*insightsv1.SavedQueryPin) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range slices.Sorted(maps.Keys(s.revisions)) {
		h := s.revisions[id]
		document, ok := s.documents[id]
		if h.rebuild != nil || !ok {
			continue
		}
		revs := h.index.GetRevisions()
		if len(revs) == 0 {
			continue
		}
		head := revs[len(revs)-1]
		if head.GetSource() != insightsv1.RevisionSource_REVISION_SOURCE_BASELINE || len(head.GetSavedQueries()) > 0 {
			continue
		}
		want := pins(document)
		if len(want) == 0 {
			continue
		}
		next := cloneRevisionIndex(h.index)
		next.Revisions[len(next.Revisions)-1].SavedQueries = want
		if err := writeRevisionIndex(s.revisionDir(id), next); err != nil {
			s.recordRevisionWriteFailure(id, err)
			continue
		}
		h.index = next
	}
}

// setAsideStaleHistory moves a history directory that no loaded history owns into quarantine. It happens when a dashboard
// id is created again while its files are still on disk, after a quarantined document or a failed delete.
func (s *Store) setAsideStaleHistory(id string) error {
	_, err := os.Lstat(s.revisionDir(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect revision directory: %w", err)
	}
	destination, err := moveRevisionHistoryAside(s.dir, id)
	if err != nil {
		return err
	}
	slog.Warn("moved revision history left on disk aside; a dashboard with this id was created again", "id", id, "moved_to", destination)
	return nil
}

// commitRevisionQuarantine moves each corrupt revision index aside and rebuilds that history from the current document.
// NewServer calls it with the document quarantine. It never fails startup: a history that cannot be moved stays refused
// for this run, is counted, and is retried at the next start.
func (s *Store) commitRevisionQuarantine() {
	pending := s.pendingRevisions
	s.pendingRevisions = nil
	for _, next := range pending {
		if err := quarantineRevisionHistory(next.root, next.id, next.reason); err != nil {
			s.recordRevisionWriteFailure(next.id, err)
			continue
		}
		s.revisions[next.id].rebuild = nil
		document, exists := s.documents[next.id]
		if !exists {
			continue
		}
		s.seedBaseline(next.id, document, etag(document))
	}
}

func (s *Store) revisionDir(id string) string {
	return filepath.Join(s.dir, revisionsDirName, id)
}

func (s *Store) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Store) recordRevisionWriteFailure(id string, err error) {
	s.revisionWriteFailures.Add(1)
	slog.Warn("dashboard history write failed; the save was kept", "dashboard", id, "error", err)
}

// registerRevisionFailureCounter exposes the store's failed history writes as paprika_insights_revision_write_failures_total.
// The value is read at collection time, so the instrument needs no context on the save path.
func registerRevisionFailureCounter(meter metric.Meter, store *Store) error {
	_, err := meter.Int64ObservableCounter(revisionFailureMetric,
		metric.WithDescription("Dashboard revision history writes that failed; the save itself was kept"),
		metric.WithInt64Callback(func(_ context.Context, observer metric.Int64Observer) error {
			observer.Observe(store.RevisionWriteFailures())
			return nil
		}))
	if err != nil {
		return fmt.Errorf("create revision failure counter: %w", err)
	}
	return nil
}

func newRevisionIndex(id string) *insightsv1.DashboardRevisionIndex {
	return &insightsv1.DashboardRevisionIndex{SchemaVersion: revisionSchemaVersion, DashboardId: id, NextNumber: 1}
}

// revisionBlobID is the file stem of revision n. persistFile adds the .json suffix.
func revisionBlobID(n uint32) string {
	return strconv.FormatUint(uint64(n), 10)
}

func revisionBlobName(n uint32) string {
	return revisionBlobID(n) + ".json"
}

func readRevisionIndex(dir string) (*insightsv1.DashboardRevisionIndex, error) {
	data, err := readStoreDocument(dir, revisionIndexFileName, maxRevisionIndexBytes)
	if err != nil {
		return nil, err
	}
	var index insightsv1.DashboardRevisionIndex
	if err := checkwire.Unmarshal(data, &index); err != nil {
		return nil, fmt.Errorf("%w: decode: %w", errRevisionIndexCorrupt, err)
	}
	return &index, nil
}

// validateRevisionIndex rejects an index that names another dashboard, has an unknown schema, or lists revisions out of
// order. Each rejection makes the history corrupt, so it is rebuilt rather than trusted.
func validateRevisionIndex(id string, index *insightsv1.DashboardRevisionIndex) error {
	if index.GetSchemaVersion() != revisionSchemaVersion || index.GetDashboardId() != id {
		return corruptRevisionIndex("revision index does not match its dashboard")
	}
	if index.GetNextNumber() == 0 {
		return corruptRevisionIndex("revision index has no next number")
	}
	var previous uint32
	for _, rev := range index.GetRevisions() {
		if rev.GetNumber() <= previous || rev.GetEtag() == "" {
			return corruptRevisionIndex("revision index is out of order")
		}
		previous = rev.GetNumber()
	}
	if previous >= index.GetNextNumber() {
		return corruptRevisionIndex("revision index reuses a number")
	}
	return nil
}

// corruptRevisionIndex describes an index that cannot be trusted.
func corruptRevisionIndex(reason string) error {
	return fmt.Errorf("%w: %s", errRevisionIndexCorrupt, reason)
}

func writeRevisionIndex(dir string, index *insightsv1.DashboardRevisionIndex) error {
	data, err := checkwire.Marshal(index)
	if err != nil {
		return fmt.Errorf("encode revision index: %w", err)
	}
	if err := persistFile(dir, revisionIndexFile, data); err != nil {
		return fmt.Errorf("write revision index: %w", err)
	}
	return nil
}

// removeRevisionBlob deletes one revision file. A failure leaves an unreferenced file, which the next startup sweeps.
func removeRevisionBlob(dir string, n uint32) {
	if err := os.Remove(filepath.Join(dir, revisionBlobName(n))); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("could not remove pruned revision", "revision", n, "error", err)
	}
}

// sweepRevisionOrphans removes revision files the index does not name, and temporary files a crash left behind. Only
// names the store writes are touched.
func sweepRevisionOrphans(dir string, index *insightsv1.DashboardRevisionIndex) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read revision directory: %w", err)
	}
	keep := make(map[string]bool, len(index.GetRevisions()))
	for _, rev := range index.GetRevisions() {
		keep[revisionBlobName(rev.GetNumber())] = true
	}
	var errs []error
	for _, entry := range entries {
		if !isStaleRevisionFile(entry.Name(), keep) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// isStaleRevisionFile reports a file the store wrote that the index no longer names: a revision blob, or a temporary
// file from an interrupted write. Any other name is left alone.
func isStaleRevisionFile(name string, keep map[string]bool) bool {
	if strings.HasPrefix(name, documentTempPrefix) {
		return true
	}
	if name == revisionIndexFileName || !strings.HasSuffix(name, ".json") {
		return false
	}
	if _, err := strconv.ParseUint(strings.TrimSuffix(name, ".json"), 10, 32); err != nil {
		return false
	}
	return !keep[name]
}
