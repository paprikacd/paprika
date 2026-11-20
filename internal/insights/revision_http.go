package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// The API proxy sets the identity and source headers from the authenticated principal and the call's origin, and
// builds the upstream headers from an allowlist, so a browser cannot set them. The message header is forwarded from the
// caller. The name is percent-encoded so that the header stays ASCII.
const (
	revisionMessageHeader       = "X-Insights-Revision-Message"
	revisionAuthorSubjectHeader = "X-Paprika-Revision-Author-Subject"
	revisionAuthorNameHeader    = "X-Paprika-Revision-Author-Name"
	revisionSourceHeader        = "X-Paprika-Revision-Source"
	// revisionNumberHeader carries the revision a response names: the head after a save, or the revision a read returns.
	revisionNumberHeader = "X-Paprika-Revision"
	restoredFromHeader   = "X-Paprika-Restored-From"
)

var (
	errRevisionSource          = errors.New("revision source must be ui or mcp")
	errRevisionMessageEncoding = errors.New("revision message must be percent-encoded UTF-8")
	errRevisionMessageControl  = errors.New("revision message contains control characters")
)

// saveRequest is what a save writes beside its document: its preconditions, its author and source, and, for a
// restore, the revision it restores.
type saveRequest struct {
	ifMatch     string
	ifNoneMatch string
	meta        RevisionMeta
	restored    *insightsv1.DashboardRevision
}

// revisionMetaFromHeaders reads the revision metadata a save carries. Without a service token nothing vouches for the
// proxy, so in insecure development mode the identity and source headers are ignored and the revision is a UI save.
func (s *Server) revisionMetaFromHeaders(h http.Header) (RevisionMeta, error) {
	message, err := revisionMessage(h)
	if err != nil {
		return RevisionMeta{}, err
	}
	meta := RevisionMeta{Source: insightsv1.RevisionSource_REVISION_SOURCE_UI, Message: message}
	if s.insecureDev {
		return meta, nil
	}
	switch h.Get(revisionSourceHeader) {
	case "", "ui":
	case "mcp":
		meta.Source = insightsv1.RevisionSource_REVISION_SOURCE_MCP
	default:
		return RevisionMeta{}, errRevisionSource
	}
	meta.Author = revisionAuthor(h)
	return meta, nil
}

// revisionMessage reads the optional message: percent-encoded UTF-8, trimmed, at most maxRevisionMessageUnits UTF-16
// units, and without control characters. An empty header is no message.
func revisionMessage(h http.Header) (string, error) {
	raw := h.Get(revisionMessageHeader)
	if raw == "" {
		return "", nil
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil || !utf8.ValidString(decoded) {
		return "", errRevisionMessageEncoding
	}
	message := trimJS(decoded)
	if strings.ContainsFunc(message, unicode.IsControl) {
		return "", errRevisionMessageControl
	}
	if stringUnits(message) > maxRevisionMessageUnits {
		return "", errRevisionMessageLength
	}
	return message, nil
}

// revisionAuthor reads the author the proxy stamped. A name that does not decode is dropped rather than failing the save.
func revisionAuthor(h http.Header) *insightsv1.RevisionAuthor {
	subject := h.Get(revisionAuthorSubjectHeader)
	name, err := url.PathUnescape(h.Get(revisionAuthorNameHeader))
	if err != nil || !utf8.ValidString(name) {
		name = ""
	}
	if subject == "" && name == "" {
		return nil
	}
	return &insightsv1.RevisionAuthor{Subject: subject, Name: name}
}

// listDashboardRevisions answers the retained revisions of a dashboard, newest first, with the ETag of its current
// document.
func (s *Server) listDashboardRevisions(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_, current, err := s.store.Get(id)
	if err != nil {
		storeError(w, err)
		return
	}
	revisions, err := s.store.Revisions(id)
	if err != nil {
		storeError(w, err)
		return
	}
	writeRevisionMessage(w, http.StatusOK, &insightsv1.DashboardRevisionList{
		DashboardId:    id,
		Revisions:      revisions,
		RetentionLimit: checkwire.Count(s.store.revisionLimit),
		CurrentEtag:    current,
	})
}

// getDashboardRevision returns the exact stored bytes of one revision. Its ETag is the content ETag of those bytes.
func (s *Server) getDashboardRevision(w http.ResponseWriter, r *http.Request) {
	number, ok := revisionNumber(w, r)
	if !ok {
		return
	}
	document, tag, err := s.store.RevisionDocument(r.PathValue("id"), number)
	if err != nil {
		revisionStoreError(w, err)
		return
	}
	setDocumentETag(w, tag)
	w.Header().Set(revisionNumberHeader, strconv.FormatUint(uint64(number), 10))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	// The bytes are a stored, schema-checked dashboard served as application/json, and the handler sends nosniff.
	if _, err := w.Write(document); err != nil { //nolint:gosec // A stored JSON document served as application/json, never HTML.
		slog.Debug("could not write insights revision")
	}
}

// restoreDashboardRevision saves a stored revision as a new revision of the dashboard. It takes the path of a save: the
// document is validated against the current rules, If-Match must be the current ETag, and bytes equal to the current
// document add no revision. Saved queries are not restored; their drift from the revision is recorded instead.
func (s *Server) restoreDashboardRevision(w http.ResponseWriter, r *http.Request) {
	number, ok := revisionNumber(w, r)
	if !ok {
		return
	}
	ifMatch := r.Header.Get("If-Match")
	if ifMatch == "" || ifMatch == "*" {
		writeError(w, http.StatusPreconditionRequired, "restore requires If-Match with the current ETag")
		return
	}
	meta, err := s.revisionMetaFromHeaders(r.Header)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	meta.Source = insightsv1.RevisionSource_REVISION_SOURCE_RESTORE
	if meta.Message == "" {
		meta.Message = fmt.Sprintf("Restored revision %d", number)
	}
	id := r.PathValue("id")
	document, _, err := s.store.RevisionDocument(id, number)
	if err != nil {
		revisionStoreError(w, err)
		return
	}
	entry, err := s.revisionEntry(id, number)
	if err != nil {
		revisionStoreError(w, err)
		return
	}
	checks := wantsChecks(r)
	releaseCheck := func() {}
	if checks {
		release, admitted := s.admitCheck(w, nil)
		if !admitted {
			return
		}
		releaseCheck = release
	}
	s.saveDashboard(r, document, checks, &saveRequest{ifMatch: ifMatch, meta: meta, restored: entry}, releaseCheck).replay(w)
}

// revisionEntry returns the metadata of one retained revision.
func (s *Server) revisionEntry(id string, number uint32) (*insightsv1.DashboardRevision, error) {
	revisions, err := s.store.Revisions(id)
	if err != nil {
		return nil, err
	}
	for _, rev := range revisions {
		if rev.GetNumber() == number {
			return rev, nil
		}
	}
	return nil, ErrRevisionNotFound
}

// revisionNumber reads the revision number from the path. Revision numbers start at 1.
func revisionNumber(w http.ResponseWriter, r *http.Request) (uint32, bool) {
	n, err := strconv.ParseUint(r.PathValue("revision"), 10, 32)
	if err != nil || n == 0 {
		writeError(w, http.StatusBadRequest, "revision must be a positive revision number")
		return 0, false
	}
	return uint32(n), true
}

// revisionStoreError maps an unknown revision to 404 and defers every other failure to storeError.
func revisionStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrRevisionNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	storeError(w, err)
}

// setRevisionHeaders names the revision a save or restore produced. The head is omitted when the dashboard has no
// history, which happens only while its history write is failing.
func setRevisionHeaders(w http.ResponseWriter, head, restoredFrom uint32) {
	if head > 0 {
		w.Header().Set(revisionNumberHeader, strconv.FormatUint(uint64(head), 10))
	}
	if restoredFrom > 0 {
		w.Header().Set(restoredFromHeader, strconv.FormatUint(uint64(restoredFrom), 10))
	}
}

// savedQueryPins returns the saved queries a document reads, sorted by id, each with the ETag it reads now. An absent
// saved query pins the empty ETag.
func (s *Server) savedQueryPins(document Dashboard) []*insightsv1.SavedQueryPin {
	ids := savedQueryReferences(document)
	pins := make([]*insightsv1.SavedQueryPin, 0, len(ids))
	for _, id := range ids {
		pins = append(pins, &insightsv1.SavedQueryPin{Id: id, Etag: s.savedQueryTag(id)})
	}
	return pins
}

// driftedSavedQueries returns the pins whose saved query no longer has the ETag the revision recorded.
func (s *Server) driftedSavedQueries(pinned []*insightsv1.SavedQueryPin) []*insightsv1.SavedQueryPin {
	var drifted []*insightsv1.SavedQueryPin
	for _, pin := range pinned {
		if s.savedQueryTag(pin.GetId()) != pin.GetEtag() {
			drifted = append(drifted, &insightsv1.SavedQueryPin{Id: pin.GetId(), Etag: pin.GetEtag()})
		}
	}
	return drifted
}

func (s *Server) savedQueryTag(id string) string {
	_, tag, err := s.savedQueries.get(id)
	if err != nil {
		return ""
	}
	return tag
}

// savedQueryReferences lists the saved-query ids that the widgets of a document read, by widget query or annotation.
func savedQueryReferences(document Dashboard) []string {
	type reference struct {
		ID string `json:"id"`
	}
	var parsed struct {
		Widgets []struct {
			QueryRef         *reference `json:"queryRef"`
			AnnotationSource *struct {
				QueryRef *reference `json:"queryRef"`
			} `json:"annotationSource"`
		} `json:"widgets"`
	}
	if err := json.Unmarshal(document, &parsed); err != nil {
		return nil
	}
	seen := make(map[string]bool)
	for _, widget := range parsed.Widgets {
		if widget.QueryRef != nil {
			seen[widget.QueryRef.ID] = true
		}
		if widget.AnnotationSource != nil && widget.AnnotationSource.QueryRef != nil {
			seen[widget.AnnotationSource.QueryRef.ID] = true
		}
	}
	delete(seen, "")
	return slices.Sorted(maps.Keys(seen))
}

// writeRevisionMessage writes a revision protobuf message as JSON.
func writeRevisionMessage(w http.ResponseWriter, status int, message *insightsv1.DashboardRevisionList) {
	data, err := checkwire.Marshal(message)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "dashboard revision history failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(data); err != nil {
		slog.Debug("could not write insights revision list")
	}
}
