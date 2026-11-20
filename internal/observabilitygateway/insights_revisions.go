package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/mcp"
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

const (
	// insightsRevisionMessageHeader carries the optional note of a dashboard save or restore. The API proxy forwards it.
	insightsRevisionMessageHeader = "X-Insights-Revision-Message"
	// insightsRevisionNumberHeader and insightsRestoredFromHeader name the revision a save or restore produced.
	insightsRevisionNumberHeader = "X-Paprika-Revision"
	insightsRestoredFromHeader   = "X-Paprika-Restored-From"
	// maxInsightsRevisionList is the number of revisions a dashboard keeps, and so the most a listing returns.
	maxInsightsRevisionList = 20
)

const insightsRevisionMessageSchema = `{"type":"string","maxLength":200,"description":"Optional note saved with this revision and shown in its history. At most 200 UTF-16 units, without control characters. Dashboards only."}`
const insightsRevisionNumberSchema = `{"type":"integer","minimum":1,"description":"Revision number from list_dashboard_revisions."}`

// insightsRevisionMessageProperty is the message argument of a dashboard write. Saved queries keep no revisions, so
// their tools do not take one.
func insightsRevisionMessageProperty(singular string) string {
	if singular != "dashboard" {
		return ""
	}
	return `,"message":` + insightsRevisionMessageSchema
}

type insightsRevisionListArgs struct {
	ID    string `json:"id"`
	Limit uint32 `json:"limit,omitempty"`
}

type insightsRevisionArgs struct {
	ID       string `json:"id"`
	Revision uint32 `json:"revision"`
}

type insightsRevisionRestoreArgs struct {
	ID       string `json:"id"`
	Revision uint32 `json:"revision"`
	ETag     string `json:"etag"`
	Message  string `json:"message,omitempty"`
}

// decodeInsightsToolArgs decodes one argument object and rejects fields the tool does not define.
func decodeInsightsToolArgs[T any](raw json.RawMessage) (T, error) {
	var args T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid Insights tool arguments"))
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return args, connect.NewError(connect.CodeInvalidArgument, errors.New("expected one argument object"))
	}
	return args, nil
}

// insightsRevisionTools are the dashboard revision tools. Listing and reading need observe scope, and restoring is a
// write that also needs paprika:insights:write and the human's Insights write permission.
func insightsRevisionTools(c *InsightsAuthoringClient) []mcp.Tool {
	return []mcp.Tool{
		{
			Name:        "list_dashboard_revisions",
			Description: "List the retained revisions of a dashboard, newest first, with each revision's number, ETag, author name, source (ui, mcp, restore or baseline), message, widget count and saved-query pins. Each revision is a whole saved dashboard. Read-only; use get_dashboard_revision to read one and restore_dashboard_revision to restore it.",
			Scope:       mcp.ScopeObserve,
			InputSchema: json.RawMessage(`{"type":"object","properties":{"id":` + insightsIDSchema + `,"limit":{"type":"integer","minimum":1,"maximum":20,"description":"Newest revisions to return. Default 20."}},"required":["id"],"additionalProperties":false}`),
			Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
				args, err := decodeInsightsToolArgs[insightsRevisionListArgs](raw)
				if err != nil {
					return nil, err
				}
				return c.listRevisions(ctx, args.ID, args.Limit)
			},
		},
		{
			Name:        "get_dashboard_revision",
			Description: "Get the exact stored document of one retained dashboard revision and its content ETag, to compare with the current dashboard before restoring. Read-only.",
			Scope:       mcp.ScopeObserve,
			InputSchema: json.RawMessage(`{"type":"object","properties":{"id":` + insightsIDSchema + `,"revision":` + insightsRevisionNumberSchema + `},"required":["id","revision"],"additionalProperties":false}`),
			Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
				args, err := decodeInsightsToolArgs[insightsRevisionArgs](raw)
				if err != nil {
					return nil, err
				}
				return c.getRevision(ctx, args.ID, args.Revision)
			},
		},
		{
			Name:        "restore_dashboard_revision",
			Description: "Restore a retained dashboard revision. The result is a new revision of the dashboard, so history keeps the one it replaces. Requires the exact current ETag from get_dashboard, paprika:observe, paprika:insights:write and human Insights write permission. Saved queries are not restored: any that changed since the revision are listed in driftedSavedQueries. Restoring the current content adds no revision. The revision is validated against the current rules and is not saved if it fails them. Clean UI views refresh; unsaved drafts remain protected.",
			Scope:       mcp.ScopeInsightsWrite,
			InputSchema: json.RawMessage(`{"type":"object","properties":{"id":` + insightsIDSchema + `,"revision":` + insightsRevisionNumberSchema + `,"etag":` + insightsETagSchema + `,"message":` + insightsRevisionMessageSchema + `},"required":["id","revision","etag"],"additionalProperties":false}`),
			Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
				args, err := decodeInsightsToolArgs[insightsRevisionRestoreArgs](raw)
				if err != nil {
					return nil, err
				}
				return insightsRestoreResult(c.restoreRevision(ctx, args))
			},
		},
	}
}

func validateInsightsRevisionTarget(id string, revision uint32) error {
	if !insightsDocumentID.MatchString(id) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid document ID"))
	}
	if revision == 0 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("revision must be a positive revision number"))
	}
	return nil
}

func insightsRevisionPath(id string, revision uint32) string {
	return "dashboards/" + id + "/revisions/" + strconv.FormatUint(uint64(revision), 10)
}

// revisionList reads every retained revision of a dashboard, newest first.
func (c *InsightsAuthoringClient) revisionList(ctx context.Context, id string) (*insightsv1.DashboardRevisionList, error) {
	if !insightsDocumentID.MatchString(id) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid document ID"))
	}
	body, _, err := c.request(ctx, http.MethodGet, "dashboards/"+id+"/revisions", nil, nil)
	if err != nil {
		return nil, err
	}
	var list insightsv1.DashboardRevisionList
	if checkwire.Unmarshal(body, &list) != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid revision list"))
	}
	return &list, nil
}

func (c *InsightsAuthoringClient) listRevisions(ctx context.Context, id string, limit uint32) (json.RawMessage, error) {
	if limit > maxInsightsRevisionList {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("limit must be at most 20"))
	}
	list, err := c.revisionList(ctx, id)
	if err != nil {
		return nil, err
	}
	if limit == 0 {
		limit = maxInsightsRevisionList
	}
	if int(limit) < len(list.GetRevisions()) {
		list.Revisions = list.Revisions[:limit]
	}
	data, err := checkwire.Marshal(list)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights revision list could not be rendered"))
	}
	return data, nil
}

// insightsRevisionDocument is one stored revision: its exact document and the content ETag of those bytes.
type insightsRevisionDocument struct {
	Revision uint32          `json:"revision"`
	Document json.RawMessage `json:"document"`
	ETag     string          `json:"etag"`
	UIURL    string          `json:"uiUrl"`
}

func (c *InsightsAuthoringClient) getRevision(ctx context.Context, id string, revision uint32) (*insightsRevisionDocument, error) {
	if err := validateInsightsRevisionTarget(id, revision); err != nil {
		return nil, err
	}
	body, etag, err := c.request(ctx, http.MethodGet, insightsRevisionPath(id, revision), nil, nil)
	if err != nil {
		return nil, err
	}
	stored, err := c.documentResult("dashboards", id, body, etag)
	if err != nil {
		return nil, err
	}
	return &insightsRevisionDocument{Revision: revision, Document: stored.Document, ETag: stored.ETag, UIURL: stored.UIURL}, nil
}

// insightsSavedQueryPin is a saved query a revision read, with the ETag that revision recorded for it.
type insightsSavedQueryPin struct {
	ID   string `json:"id"`
	ETag string `json:"etag"`
}

// insightsRevisionRestore is the result of a restore: the new current document and the revision it created. Drifted
// saved queries are the ones whose ETag no longer matches the pin the restored revision recorded. DriftUnknown is set
// when the drift could not be read after the restore succeeded, so an empty list is never a false all-clear.
type insightsRevisionRestore struct {
	Revision            uint32                  `json:"revision"`
	RestoredFrom        uint32                  `json:"restoredFrom"`
	Document            json.RawMessage         `json:"document"`
	ETag                string                  `json:"etag"`
	UIURL               string                  `json:"uiUrl"`
	DriftedSavedQueries []insightsSavedQueryPin `json:"driftedSavedQueries,omitempty"`
	DriftUnknown        bool                    `json:"driftUnknown,omitempty"`
	// Checks is the warnings report of the new document. Like a save, it is returned beside the result.
	Checks *insightsv1.CheckReport `json:"-"`
}

// restoreRevision writes a stored revision as the dashboard's new revision. The write takes the UI's save path, so
// the current rules and the ETag precondition apply. The audit records the attempt as a restore.
func (c *InsightsAuthoringClient) restoreRevision(ctx context.Context, args insightsRevisionRestoreArgs) (result *insightsRevisionRestore, err error) {
	if err = validateInsightsRevisionTarget(args.ID, args.Revision); err != nil {
		return nil, err
	}
	defer func() { c.auditAction(ctx, "dashboards", args.ID, "restore", err) }()
	if !insightsDocumentETag.MatchString(args.ETag) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("restore requires the exact ETag returned by get_dashboard; wildcard and weak ETags are not allowed"))
	}
	headers := make(http.Header)
	headers.Set("If-Match", args.ETag)
	if args.Message != "" {
		headers.Set(insightsRevisionMessageHeader, url.PathEscape(args.Message))
	}
	body, header, err := c.send(ctx, http.MethodPost, insightsRevisionPath(args.ID, args.Revision)+"/restore?checks=true", nil, headers, true, 2<<20)
	if err != nil {
		return nil, err
	}
	document, report, err := splitInsightsChecks(body)
	if err != nil {
		return nil, err
	}
	stored, err := c.documentResult("dashboards", args.ID, document, header.Get("ETag"))
	if err != nil {
		return nil, err
	}
	result = &insightsRevisionRestore{
		Revision:     revisionHeader(header, insightsRevisionNumberHeader),
		RestoredFrom: revisionHeader(header, insightsRestoredFromHeader),
		Document:     stored.Document,
		ETag:         stored.ETag,
		UIURL:        stored.UIURL,
		Checks:       report,
	}
	// A restore whose content already matched the dashboard adds no revision, so it has no drift to report. When the
	// content changed but no revision names it, as after a failed history write, the drift cannot be read.
	if result.ETag != args.ETag {
		if result.Revision == 0 {
			result.DriftUnknown = true
		} else {
			var known bool
			result.DriftedSavedQueries, known = c.restoredDrift(ctx, args.ID, result.Revision)
			result.DriftUnknown = !known
		}
	}
	return result, nil
}

// revisionHeader reads a revision number header. A missing or malformed header reads as zero.
func revisionHeader(header http.Header, name string) uint32 {
	n, err := strconv.ParseUint(header.Get(name), 10, 32)
	if err != nil {
		return 0
	}
	return uint32(n)
}

// restoredDrift reads the saved-query pins of the revision a restore just created. The second return is false when
// the listing failed, so the caller reports the drift as unknown rather than as none.
func (c *InsightsAuthoringClient) restoredDrift(ctx context.Context, id string, revision uint32) ([]insightsSavedQueryPin, bool) {
	list, err := c.revisionList(ctx, id)
	if err != nil {
		return nil, false
	}
	for _, rev := range list.GetRevisions() {
		if rev.GetNumber() != revision {
			continue
		}
		var drifted []insightsSavedQueryPin
		for _, pin := range rev.GetDriftedSavedQueries() {
			drifted = append(drifted, insightsSavedQueryPin{ID: pin.GetId(), ETag: pin.GetEtag()})
		}
		return drifted, true
	}
	return nil, false
}

// insightsRestoreResult renders a restore like a save: the new document, then its checks section.
func insightsRestoreResult(result *insightsRevisionRestore, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return checkResult(result, result.Checks)
}
