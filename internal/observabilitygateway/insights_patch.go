package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"

	"connectrpc.com/connect"
)

const (
	insightsDashboardPatchBytes  = 256 << 10
	insightsSavedQueryPatchBytes = 32 << 10
	insightsPatchDepth           = 32
	insightsWidgetEditLimit      = 48
)

type insightsPatchArgs struct {
	ID                 string               `json:"id"`
	ETag               string               `json:"etag"`
	Patch              json.RawMessage      `json:"patch,omitempty"`
	WidgetEdits        []insightsWidgetEdit `json:"widget_edits,omitempty"` //nolint:tagliatelle // MCP arguments use snake_case.
	inputBytes         int
	widgetEditsPresent bool
}

type insightsWidgetEdit struct {
	Op     string          `json:"op"`
	ID     string          `json:"id,omitempty"`
	Patch  json.RawMessage `json:"patch,omitempty"`
	Widget json.RawMessage `json:"widget,omitempty"`
}

func decodeInsightsPatchArgs(raw json.RawMessage) (*insightsPatchArgs, error) {
	args := &insightsPatchArgs{}
	if len(raw) > insightsDashboardPatchBytes || validateInsightsPatchJSON(raw) != nil {
		return args, invalidInsightsPatch("patch arguments must be bounded JSON without duplicate keys")
	}
	fields, err := insightsPatchObject(raw)
	if err != nil || !insightsPatchFields(fields, "id", "etag", "patch", "widget_edits") {
		return args, invalidInsightsPatch("invalid patch argument fields")
	}
	if json.Unmarshal(raw, args) != nil {
		return args, invalidInsightsPatch("invalid patch arguments")
	}
	args.inputBytes = len(raw)
	if edits, present := fields["widget_edits"]; present {
		args.widgetEditsPresent = true
		if err := validateInsightsWidgetEditFields(edits); err != nil {
			return args, err
		}
	}
	return args, nil
}

func validateInsightsWidgetEditFields(raw json.RawMessage) error {
	var operations []json.RawMessage
	if json.Unmarshal(raw, &operations) != nil || len(operations) == 0 {
		return invalidInsightsPatch("widget_edits must be a nonempty array")
	}
	allowed := map[string][]string{"update": {"op", "id", "patch"}, "add": {"op", "widget"}, "remove": {"op", "id"}}
	for _, operation := range operations {
		fields, err := insightsPatchObject(operation)
		if err != nil {
			return invalidInsightsPatch("invalid widget edit fields")
		}
		var op string
		if json.Unmarshal(fields["op"], &op) != nil {
			return invalidInsightsPatch("widget edit requires an operation")
		}
		if !insightsPatchFields(fields, allowed[op]...) {
			return invalidInsightsPatch("invalid fields for widget operation")
		}
	}
	return nil
}

// patch composes the same authenticated read and conditional write used by the
// UI. The original caller ETag remains the write precondition even if another
// writer changes the document after our read; a conflict is never retried.
func (c *InsightsAuthoringClient) patch(ctx context.Context, collection string, args *insightsPatchArgs) (result *insightsDocumentResult, err error) {
	if err = validateInsightsPatchTarget(collection, args.ID); err != nil {
		return nil, err
	}
	putAudits := false
	defer func() {
		if err != nil && !putAudits {
			c.auditMutation(ctx, collection, args.ID, false, err)
		}
	}()
	if _, err = c.credential(ctx, true); err != nil {
		return nil, err
	}
	if err = validateInsightsPatchArgs(collection, args); err != nil {
		return nil, err
	}
	current, err := c.get(ctx, collection, args.ID)
	if err != nil {
		return nil, err
	}
	if current.ETag != args.ETag {
		return nil, connect.NewError(connect.CodeAborted, errors.New("document has changed; get the latest document and ETag before retrying"))
	}
	document, err := applyInsightsPatch(current.Document, collection, args)
	if err != nil {
		return nil, err
	}
	putAudits = true
	return c.put(ctx, collection, insightsAuthoringArgs{Document: document, ETag: args.ETag}, false)
}

func validateInsightsPatchTarget(collection, id string) error {
	if collection != "dashboards" && collection != "saved-queries" {
		return invalidInsightsPatch("unsupported patch collection")
	}
	if !insightsDocumentID.MatchString(id) {
		return invalidInsightsPatch("invalid document ID")
	}
	return nil
}

func validateInsightsPatchArgs(collection string, args *insightsPatchArgs) error {
	if !insightsDocumentETag.MatchString(args.ETag) {
		return invalidInsightsPatch("patch requires the exact ETag returned by get; wildcard and weak ETags are not allowed")
	}
	if err := validateInsightsPatchLimits(collection, args); err != nil {
		return err
	}
	forbidden := []string{"id", "schemaVersion", "widgets"}
	if collection == "saved-queries" {
		forbidden = []string{"id", "schemaVersion", "providerId", "kind"}
		if args.widgetEditsPresent || len(args.WidgetEdits) != 0 {
			return invalidInsightsPatch("saved queries do not support widget edits")
		}
	}
	if len(args.Patch) != 0 {
		if err := validateInsightsMergePatch(args.Patch, forbidden...); err != nil {
			return err
		}
	}
	if len(args.Patch) == 0 && len(args.WidgetEdits) == 0 {
		return invalidInsightsPatch("provide a nonempty patch or widget edits")
	}
	return validateInsightsWidgetEdits(args.WidgetEdits)
}

func validateInsightsPatchLimits(collection string, args *insightsPatchArgs) error {
	raw, err := json.Marshal(args)
	if err != nil || validateInsightsPatchJSON(raw) != nil || len(raw) > insightsPatchByteLimit(collection) || args.inputBytes > insightsPatchByteLimit(collection) {
		return invalidInsightsPatch("patch arguments exceed their size or nesting limit")
	}
	return nil
}

func validateInsightsWidgetEdits(edits []insightsWidgetEdit) error {
	if len(edits) > insightsWidgetEditLimit {
		return invalidInsightsPatch("at most 48 widget edits are allowed")
	}
	seen := make(map[string]bool, len(edits))
	for i := range edits {
		id, err := validateInsightsWidgetEdit(&edits[i])
		if err != nil {
			return err
		}
		if seen[id] {
			return invalidInsightsPatch("widget edit targets must be unique")
		}
		seen[id] = true
	}
	return nil
}

func validateInsightsMergePatch(raw json.RawMessage, forbidden ...string) error {
	fields, err := insightsPatchObject(raw)
	if err != nil || len(fields) == 0 {
		return invalidInsightsPatch("patch must be a nonempty JSON object")
	}
	for _, field := range forbidden {
		if _, present := fields[field]; present {
			return invalidInsightsPatch("patch cannot change " + field)
		}
	}
	return nil
}

func validateInsightsWidgetEdit(edit *insightsWidgetEdit) (string, error) {
	switch edit.Op {
	case "update":
		if len(edit.Widget) != 0 || !insightsDocumentID.MatchString(edit.ID) {
			return "", invalidInsightsPatch("widget update requires a valid id and patch only")
		}
		return edit.ID, validateInsightsMergePatch(edit.Patch, "id")
	case "add":
		return validateInsightsWidgetAddition(edit)
	case "remove":
		if !insightsDocumentID.MatchString(edit.ID) || len(edit.Patch) != 0 || len(edit.Widget) != 0 {
			return "", invalidInsightsPatch("widget remove requires a valid id only")
		}
		return edit.ID, nil
	default:
		return "", invalidInsightsPatch("widget operation must be update, add or remove")
	}
}

func validateInsightsWidgetAddition(edit *insightsWidgetEdit) (string, error) {
	fields, err := insightsPatchObject(edit.Widget)
	var id string
	if err != nil || edit.ID != "" || len(edit.Patch) != 0 || json.Unmarshal(fields["id"], &id) != nil || !insightsDocumentID.MatchString(id) {
		return "", invalidInsightsPatch("widget add requires a widget with a valid id")
	}
	return id, nil
}

func applyInsightsPatch(current json.RawMessage, collection string, args *insightsPatchArgs) (json.RawMessage, error) {
	document := bytes.Clone(current)
	var err error
	if len(args.Patch) != 0 {
		document, err = mergeInsightsObject(document, args.Patch)
		if err != nil {
			return nil, err
		}
	}
	if len(args.WidgetEdits) != 0 {
		document, err = editInsightsWidgets(document, args.WidgetEdits)
		if err != nil {
			return nil, err
		}
	}
	if len(document) > insightsPatchByteLimit(collection) || validateInsightsPatchJSON(document) != nil {
		return nil, invalidInsightsPatch("patched document exceeds its size or nesting limit")
	}
	if sameInsightsJSON(current, document) {
		return nil, invalidInsightsPatch("patch must change the document")
	}
	return document, nil
}

// RawMessage preserves numeric literals in untouched plugin configuration.
// Objects merge recursively, null removes keys, and all other values (including
// arrays) replace the previous value, following JSON Merge Patch semantics.
func mergeInsightsObject(current, patch json.RawMessage) (json.RawMessage, error) {
	fields, err := insightsPatchObject(patch)
	if err != nil {
		return nil, invalidInsightsPatch("patch must be a JSON object")
	}
	merged, currentErr := insightsPatchObject(current)
	if currentErr != nil {
		merged = make(map[string]json.RawMessage)
	}
	for key, value := range fields {
		trimmed := bytes.TrimSpace(value)
		switch {
		case bytes.Equal(trimmed, []byte("null")):
			delete(merged, key)
		case len(trimmed) > 0 && trimmed[0] == '{':
			next, mergeErr := mergeInsightsObject(merged[key], value)
			if mergeErr != nil {
				return nil, mergeErr
			}
			merged[key] = next
		default:
			merged[key] = bytes.Clone(value)
		}
	}
	raw, err := json.Marshal(merged)
	if err != nil {
		return nil, invalidInsightsPatch("invalid merged document")
	}
	return raw, nil
}

func editInsightsWidgets(document json.RawMessage, edits []insightsWidgetEdit) (json.RawMessage, error) {
	fields, err := insightsPatchObject(document)
	if err != nil {
		return nil, invalidInsightsPatch("invalid dashboard document")
	}
	var widgets []json.RawMessage
	if json.Unmarshal(fields["widgets"], &widgets) != nil || widgets == nil {
		return nil, invalidInsightsPatch("dashboard widgets must be an array")
	}
	indices, err := insightsWidgetIndices(widgets)
	if err != nil {
		return nil, err
	}
	for i := range edits {
		widgets, err = applyInsightsWidgetEdit(widgets, indices, &edits[i])
		if err != nil {
			return nil, err
		}
	}
	return encodeInsightsWidgets(fields, widgets)
}

func insightsWidgetIndices(widgets []json.RawMessage) (map[string]int, error) {
	indices := make(map[string]int, len(widgets))
	for index, widget := range widgets {
		var identity struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(widget, &identity) != nil {
			return nil, invalidInsightsPatch("invalid stored widget")
		}
		indices[identity.ID] = index
	}
	return indices, nil
}

func applyInsightsWidgetEdit(widgets []json.RawMessage, indices map[string]int, edit *insightsWidgetEdit) ([]json.RawMessage, error) {
	id, err := validateInsightsWidgetEdit(edit)
	if err != nil {
		return nil, err
	}
	index, exists := indices[id]
	if edit.Op == "add" {
		if exists {
			return nil, invalidInsightsPatch("cannot add a widget whose id already exists")
		}
		return append(widgets, bytes.Clone(edit.Widget)), nil
	}
	if !exists {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("widget edit target was not found"))
	}
	if edit.Op == "remove" {
		widgets[index] = nil
		return widgets, nil
	}
	widgets[index], err = mergeInsightsObject(widgets[index], edit.Patch)
	if err != nil {
		return nil, err
	}
	return widgets, nil
}

func encodeInsightsWidgets(fields map[string]json.RawMessage, widgets []json.RawMessage) (json.RawMessage, error) {
	remaining := make([]json.RawMessage, 0, len(widgets))
	for _, widget := range widgets {
		if widget != nil {
			remaining = append(remaining, widget)
		}
	}
	if len(remaining) > insightsWidgetEditLimit {
		return nil, invalidInsightsPatch("dashboard may contain at most 48 widgets")
	}
	rawWidgets, err := json.Marshal(remaining)
	if err != nil {
		return nil, invalidInsightsPatch("invalid widget edits")
	}
	fields["widgets"] = rawWidgets
	raw, err := json.Marshal(fields)
	if err != nil {
		return nil, invalidInsightsPatch("invalid dashboard edits")
	}
	return raw, nil
}

func insightsPatchByteLimit(collection string) int {
	if collection == "saved-queries" {
		return insightsSavedQueryPatchBytes
	}
	return insightsDashboardPatchBytes
}

func insightsPatchObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, errors.New("expected a JSON object")
	}
	return fields, nil
}

func insightsPatchFields(fields map[string]json.RawMessage, allowed ...string) bool {
	for key := range fields {
		found := false
		for _, field := range allowed {
			if key == field {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func sameInsightsJSON(a, b json.RawMessage) bool {
	decode := func(raw json.RawMessage) any {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		_ = decoder.Decode(&value) //nolint:errcheck // Both inputs have already passed JSON validation.
		return value
	}
	return reflect.DeepEqual(decode(a), decode(b))
}

func invalidInsightsPatch(message string) error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New(message))
}

// Bound recursive merge work and reject ambiguous keys before encoding/json's
// last-key-wins behavior can hide immutable fields or widget operations.
func validateInsightsPatchJSON(raw json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := walkInsightsPatchJSON(decoder, 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON value")
	}
	return nil
}

func walkInsightsPatchJSON(decoder *json.Decoder, depth int) error {
	if depth > insightsPatchDepth {
		return errors.New("patch JSON is nested too deeply")
	}
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("read patch JSON value: %w", err)
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	seen := make(map[string]bool)
	for decoder.More() {
		if delimiter == '{' {
			if keyErr := readInsightsPatchKey(decoder, seen); keyErr != nil {
				return keyErr
			}
		}
		if childErr := walkInsightsPatchJSON(decoder, depth+1); childErr != nil {
			return childErr
		}
	}
	_, err = decoder.Token()
	if err != nil {
		return fmt.Errorf("read patch JSON delimiter: %w", err)
	}
	return nil
}

func readInsightsPatchKey(decoder *json.Decoder, seen map[string]bool) error {
	key, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("read patch JSON key: %w", err)
	}
	name, ok := key.(string)
	if !ok || seen[name] {
		return errors.New("duplicate or invalid JSON key")
	}
	seen[name] = true
	return nil
}
