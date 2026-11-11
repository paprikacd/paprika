package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// insightsValidateDocumentBytes matches the Insights store's dashboard limit, so
// a document that validates here is one the save path accepts on size.
const insightsValidateDocumentBytes = 256 << 10

// insightsValidateRequestBytes is the largest dry-run request the service takes:
// a document at its limit, the execute envelope and up to 20 variable values.
const insightsValidateRequestBytes = insightsValidateDocumentBytes + 32<<10

// maxInsightsValidateVariables matches the variables a dashboard query accepts.
const maxInsightsValidateVariables = 20

// maxInsightsValidateWidgets is the widget limit a dashboard document has, so
// the per-widget states of a dry run never exceed it.
const maxInsightsValidateWidgets = 48

// insightsValidateDescription is the validate_dashboard tool description.
const insightsValidateDescription = "Dry-run a dashboard document, or a saved dashboard by id, without saving. Returns schema and lint findings; errors block a save, warnings do not. With execute:true it also runs each distinct widget query once over the dashboard's default time range, with optional variables, and returns data.* warnings and each widget's data state. Read-only."

const insightsValidateSchema = `{"type":"object","properties":{"document":` + dashboardDocumentSchema + `,"id":` + insightsIDSchema + `,"execute":{"type":"boolean","description":"Run each distinct widget query once and report what it returned. Read-only; nothing is saved. Default false."},"variables":{"type":"object","description":"Values for declared dashboard variables. Used only with execute.","maxProperties":20,"additionalProperties":{"type":"string","maxLength":1024}}},"oneOf":[{"required":["document"]},{"required":["id"]}],"additionalProperties":false}`

// insightsValidateArgs are the validate_dashboard arguments: the authoring
// arguments plus the dry-run options, so the tool can take execute and variables
// without the other authoring tools accepting them.
type insightsValidateArgs struct {
	insightsAuthoringArgs
	Execute   bool              `json:"execute,omitempty"`
	Variables map[string]string `json:"variables,omitempty"`
}

// insightsValidateTool is the read-only dry run. It needs paprika:observe only:
// it never writes, so it never needs paprika:insights:write. Execute runs queries,
// which is the read that observe scope already grants.
func insightsValidateTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{Name: "validate_dashboard", Description: insightsValidateDescription, Scope: mcp.ScopeObserve, InputSchema: json.RawMessage(insightsValidateSchema), Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
		args, err := decodeInsightsValidateArgs(raw)
		if err != nil {
			return nil, err
		}
		return c.validate(ctx, &args)
	}}
}

// decodeInsightsValidateArgs decodes the tool arguments with the same strictness
// as the other authoring tools: unknown members and trailing values are errors.
func decodeInsightsValidateArgs(raw json.RawMessage) (insightsValidateArgs, error) {
	var args insightsValidateArgs
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

// validate runs the Insights dry run on a document, or on the stored dashboard
// with id. The stored document is read with the caller's own token, so a
// dashboard the caller cannot read is PermissionDenied, as the test asserts.
func (c *InsightsAuthoringClient) validate(ctx context.Context, args *insightsValidateArgs) (any, error) {
	if err := validateDryRunArgs(args); err != nil {
		return nil, err
	}
	document, err := c.validationDocument(ctx, args.insightsAuthoringArgs)
	if err != nil {
		return nil, err
	}
	body, err := insightsValidateBody(document, args)
	if err != nil {
		return nil, err
	}
	// A dry run is a POST that writes nothing, so it is read-authorized.
	raw, _, err := c.requestAuthorized(ctx, http.MethodPost, "dashboards/validate", body, nil, false, 2<<20)
	if err != nil {
		return nil, err
	}
	report, err := insightsChecksReport(raw)
	if err != nil {
		return nil, err
	}
	if !args.Execute {
		return checkResult(nil, report)
	}
	widgets, err := insightsDryRunWidgets(raw)
	if err != nil {
		return nil, err
	}
	return insightsDryRunResult(report, widgets)
}

// validateDryRunArgs rejects the argument combinations the dry run does not take.
// Variables are a dry-run option, so they need execute, and the service caps them.
func validateDryRunArgs(args *insightsValidateArgs) error {
	if args.ETag != "" || args.ProviderID != "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("validate_dashboard takes only document or id, with optional execute and variables"))
	}
	if len(args.Variables) > 0 && !args.Execute {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("variables apply only with execute:true"))
	}
	if len(args.Variables) > maxInsightsValidateVariables {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("variables must contain at most 20 string values"))
	}
	return nil
}

// insightsValidateBody builds the dry-run envelope. It is built by concatenation,
// not json.Marshal, for the reason below: encoding a RawMessage escapes <, > and &
// as six bytes each, which can push a document that saves fine past the limit on
// the way to the dry run. Only the variables are encoded with json.Marshal, and
// the whole request is bounded before it is sent.
func insightsValidateBody(document json.RawMessage, args *insightsValidateArgs) ([]byte, error) {
	body := make([]byte, 0, len(document)+len(`{"document":,"execute":true,"variables":}`))
	body = append(body, `{"document":`...)
	body = append(body, document...)
	if args.Execute {
		body = append(body, `,"execute":true`...)
	}
	if len(args.Variables) > 0 {
		encoded, err := json.Marshal(args.Variables)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("variables must be strings"))
		}
		body = append(body, `,"variables":`...)
		body = append(body, encoded...)
	}
	body = append(body, '}')
	if len(body) > insightsValidateRequestBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("dry-run request exceeds 288 KiB; shorten the variable values"))
	}
	return body, nil
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

// insightsDryRunWidgets decodes the per-widget states of a dry run that executed.
// Each state is protobuf-decoded and bounded, as findings are, and the list keeps
// at most the widget limit.
func insightsDryRunWidgets(raw []byte) ([]*insightsv1.WidgetDataState, error) {
	var response struct {
		Widgets []json.RawMessage `json:"widgets"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid check report"))
	}
	widgets := make([]*insightsv1.WidgetDataState, 0, min(len(response.Widgets), maxInsightsValidateWidgets))
	for _, item := range response.Widgets {
		if len(widgets) == maxInsightsValidateWidgets {
			break
		}
		var state insightsv1.WidgetDataState
		if checkwire.Unmarshal(item, &state) != nil {
			continue
		}
		widgets = append(widgets, boundWidgetDataState(&state))
	}
	return widgets, nil
}

// boundWidgetDataState drops any field that does not fit the wire bounds. A cut
// pointer or id would name the wrong widget, so an overlong one is removed.
func boundWidgetDataState(state *insightsv1.WidgetDataState) *insightsv1.WidgetDataState {
	if len(state.GetWidgetId()) > checkwire.MaxWidgetIDBytes {
		state.WidgetId = ""
	}
	if len(state.GetPointer()) > checkwire.MaxPointerBytes {
		state.Pointer = ""
	}
	if len(state.GetErrorCode()) > checkwire.MaxRuleIDBytes {
		state.ErrorCode = ""
	}
	return state
}

// insightsDryRunResult renders a checked dry run that executed. The checks are
// rendered as usual; the per-widget states join them in structured content, and
// the verdict text gains one data line.
func insightsDryRunResult(report *insightsv1.CheckReport, widgets []*insightsv1.WidgetDataState) (any, error) {
	result, err := checkResult(nil, report)
	if err != nil {
		return nil, err
	}
	res, ok := result.(*sdkmcp.CallToolResult)
	if !ok {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights checks could not be rendered"))
	}
	if err := addDryRunData(res, widgets); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("insights checks could not be rendered"))
	}
	return res, nil
}

// addDryRunData adds the widget states to the structured content and its JSON
// text, then adds the data line after the verdict in the checks section.
func addDryRunData(res *sdkmcp.CallToolResult, widgets []*insightsv1.WidgetDataState) error {
	structured, ok := res.StructuredContent.(json.RawMessage)
	if !ok || len(res.Content) != 2 {
		return errors.New("checks result has an unexpected shape")
	}
	jsonBlock, ok := res.Content[0].(*sdkmcp.TextContent)
	if !ok {
		return errors.New("checks result has an unexpected shape")
	}
	section, ok := res.Content[1].(*sdkmcp.TextContent)
	if !ok {
		return errors.New("checks result has an unexpected shape")
	}
	data, err := withDryRunWidgets(structured, widgets)
	if err != nil {
		return err
	}
	res.StructuredContent = json.RawMessage(data)
	jsonBlock.Text = string(data)
	section.Text = withDryRunDataLine(section.Text, widgets)
	return nil
}

// withDryRunWidgets returns the structured checks object with a widgets member.
func withDryRunWidgets(structured json.RawMessage, widgets []*insightsv1.WidgetDataState) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(structured, &fields); err != nil || fields == nil {
		return nil, errors.New("checks result is not an object")
	}
	encoded := make([]json.RawMessage, 0, len(widgets))
	for _, widget := range widgets {
		raw, err := checkwire.Marshal(widget)
		if err != nil {
			return nil, fmt.Errorf("encode dry-run widget: %w", err)
		}
		encoded = append(encoded, raw)
	}
	list, err := json.Marshal(encoded)
	if err != nil {
		return nil, fmt.Errorf("marshal dry-run widgets: %w", err)
	}
	fields["widgets"] = list
	data, err := json.Marshal(fields)
	if err != nil {
		return nil, fmt.Errorf("marshal dry-run result: %w", err)
	}
	return data, nil
}

// withDryRunDataLine places the data line directly under the verdict, which is
// always the section's first line, and keeps the issue lines after it.
func withDryRunDataLine(section string, widgets []*insightsv1.WidgetDataState) string {
	verdict, rest, hasRest := strings.Cut(section, "\n")
	line := verdict + "\n" + dryRunDataLine(widgets)
	if hasRest {
		line += "\n" + rest
	}
	return line
}

// dryRunDataLine summarises the widget states in one plain line, counting each
// state that occurs. A dry run that did not execute says so.
func dryRunDataLine(widgets []*insightsv1.WidgetDataState) string {
	if len(widgets) == 0 {
		return "Data: no widgets to check."
	}
	counts := make(map[insightsv1.DataState]int, len(widgets))
	for _, widget := range widgets {
		counts[widget.GetState()]++
	}
	if counts[insightsv1.DataState_DATA_STATE_NOT_RUN] == len(widgets) {
		return "Data: not run, because the document has errors that block a save. Fix them, then run again."
	}
	labels := []struct {
		state insightsv1.DataState
		label string
	}{
		{insightsv1.DataState_DATA_STATE_OK, "ok"},
		{insightsv1.DataState_DATA_STATE_EMPTY, "empty"},
		{insightsv1.DataState_DATA_STATE_PARTIAL, "partial"},
		{insightsv1.DataState_DATA_STATE_STALE, "stale"},
		{insightsv1.DataState_DATA_STATE_ERROR, "error"},
		{insightsv1.DataState_DATA_STATE_UNAVAILABLE, "unavailable"},
	}
	parts := make([]string, 0, len(labels))
	for _, entry := range labels {
		if n := counts[entry.state]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, entry.label))
		}
	}
	noun := "widgets"
	if len(widgets) == 1 {
		noun = "widget"
	}
	return fmt.Sprintf("Data: %s across %d %s.", strings.Join(parts, ", "), len(widgets), noun)
}
