package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/mcp"
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// insightsValidateDocumentBytes matches the Insights store's dashboard limit, so
// a document that validates here is one the save path accepts on size.
const insightsValidateDocumentBytes = 256 << 10

// insightsValidateDescription is the validate_dashboard tool description.
const insightsValidateDescription = "Dry-run a dashboard document, or a saved dashboard by id, without saving. Returns schema and lint findings; errors block a save, warnings do not. Read-only."

const insightsValidateSchema = `{"type":"object","properties":{"document":` + dashboardDocumentSchema + `,"id":` + insightsIDSchema + `},"oneOf":[{"required":["document"]},{"required":["id"]}],"additionalProperties":false}`

// insightsValidateTool is the read-only dry run. It needs paprika:observe only:
// it never writes, so it never needs paprika:insights:write.
func insightsValidateTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{Name: "validate_dashboard", Description: insightsValidateDescription, Scope: mcp.ScopeObserve, InputSchema: json.RawMessage(insightsValidateSchema), Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
		args, err := decodeInsightsAuthoringArgs(raw)
		if err != nil {
			return nil, err
		}
		return c.validate(ctx, args)
	}}
}

// validate runs the Insights dry run on a document, or on the stored dashboard
// with id. The stored document is read with the caller's own token, so a
// dashboard the caller cannot read is PermissionDenied, as the test asserts.
func (c *InsightsAuthoringClient) validate(ctx context.Context, args insightsAuthoringArgs) (any, error) {
	if args.ETag != "" || args.ProviderID != "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("validate_dashboard takes only document or id"))
	}
	document, err := c.validationDocument(ctx, args)
	if err != nil {
		return nil, err
	}
	// The envelope is built by concatenation, not json.Marshal: encoding a
	// RawMessage escapes <, > and & as six bytes each, which can push a document
	// that saves fine past the limit on the way to the dry run.
	body := make([]byte, 0, len(document)+len(`{"document":}`))
	body = append(body, `{"document":`...)
	body = append(body, document...)
	body = append(body, '}')
	// A dry run is a POST that writes nothing, so it is read-authorized.
	raw, _, err := c.requestAuthorized(ctx, http.MethodPost, "dashboards/validate", body, nil, false, 2<<20)
	if err != nil {
		return nil, err
	}
	report, err := insightsChecksReport(raw)
	if err != nil {
		return nil, err
	}
	return checkResult(nil, report)
}

// validationDocument returns exactly one submitted or stored document. Both or
// neither is a caller error, so the tool never guesses which one it was given.
func (c *InsightsAuthoringClient) validationDocument(ctx context.Context, args insightsAuthoringArgs) (json.RawMessage, error) {
	hasDocument := len(args.Document) != 0
	hasID := args.ID != ""
	if hasDocument == hasID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("validate_dashboard takes exactly one of document or id"))
	}
	if !hasID {
		return submittedDocument(args.Document)
	}
	if !insightsDocumentID.MatchString(args.ID) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid document ID"))
	}
	stored, err := c.get(ctx, "dashboards", args.ID)
	if err != nil {
		return nil, err
	}
	return stored.Document, nil
}

// submittedDocument checks a document before any upstream call. Its size error
// is InvalidArgument: retrying the same document cannot succeed, so it must not
// read as a capacity fault.
func submittedDocument(document json.RawMessage) (json.RawMessage, error) {
	if len(document) > insightsValidateDocumentBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("dashboard document exceeds 256 KiB"))
	}
	if _, err := insightsPatchObject(document); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("document must be a JSON object"))
	}
	return document, nil
}

// insightsWriteResult renders a successful save with its checks section. A
// failed save returns its error unchanged, so its issue rendering is kept.
func insightsWriteResult(result *insightsDocumentResult, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return checkResult(result, result.Checks)
}

// checkResult renders a checked result. A failure here is a renderer fault, not
// a caller error, so it is reported as internal with no upstream text.
func checkResult(payload any, report *insightsv1.CheckReport) (any, error) {
	res, err := mcp.CheckedResult(payload, report)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights checks could not be rendered"))
	}
	return res, nil
}
