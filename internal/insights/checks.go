package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// maxFindingMessageRunes bounds the message the service writes for a finding.
// A submitted key can appear in a message, so the bound keeps it short.
const maxFindingMessageRunes = 200

const maxDashboardWidgets = 48

// Rule ids are fixed per check. A rule never depends on the submitted keys or
// on which widget failed, so agents and dashboards can match on it.
const (
	ruleDocument          = "schema.document"
	ruleDocumentTimeRange = "schema.document.timeRange"
	ruleDocumentRefresh   = "schema.document.refreshInterval"
	ruleWidgets           = "schema.widgets"
	ruleWidgetShape       = "schema.widget.shape"
	ruleWidgetID          = "schema.widget.id"
	ruleWidgetText        = "schema.widget.text"
	ruleWidgetType        = "schema.widget.type"
	ruleWidgetLayout      = "schema.widget.layout"
	ruleWidgetOptions     = "schema.widget.options"
)

var dashboardRequiredFields = []string{"schemaVersion", "id", "title", "timeRange", "refreshInterval", "widgets"}
var dashboardOptionalFields = []string{"description", "folder", "customTimeRange", "timeZone", "variables"}

// dashboardExtensionFields is the order validateDashboardExtensions checks them in.
var dashboardExtensionFields = []string{"variables", "folder", "customTimeRange", "timeZone"}

// checkFixes gives agents the allowed values for the most common rule
// violations. Rules without an entry have a message that already says enough.
var checkFixes = map[string]string{
	ruleWidgetLayout:      "Keep x and y at least 0, y at most 1000, w from 1 to 12 with x + w at most 12, and h from 2 to 12 (1 for stat widgets).",
	ruleWidgetID:          "Use a unique id of up to 80 letters, digits, underscores or hyphens, starting with a letter or digit.",
	ruleWidgetType:        "Use one of timeseries, bar, stat, table, traces, heatmap or plugin.",
	ruleWidgets:           "Use an array of at most 48 widgets.",
	ruleDocumentTimeRange: "Use one of 15m, 30m, 1h, 6h, 24h, 7d or 30d.",
	ruleDocumentRefresh:   "Use 0, 15, 30 or 60 seconds.",
}

// dashboardHeader holds the top-level fields the identity check reads. Widgets
// are decoded one at a time, so one malformed widget cannot hide the others.
type dashboardHeader struct {
	SchemaVersion   int    `json:"schemaVersion"`
	ID              string `json:"id"`
	Title           string `json:"title"`
	Description     string `json:"description"`
	TimeRange       string `json:"timeRange"`
	RefreshInterval int    `json:"refreshInterval"`
}

// schemaFindings returns every save-time schema finding for a submitted
// document. The first finding carries the message a save has always reported,
// so the existing error field keeps its meaning. Document-structure failures
// stop the check, as they always have. Widget failures are collected for every
// widget: a widget whose shape is broken is reported as a shape finding, and
// the content checks still run on every widget whose shape passed.
//
// Each finding names its own JSON Pointer: the validator that failed reports
// the member it concerns, and its parents add their segments. See pointedError.
func schemaFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	findings := unanchoredSchemaFindings(id, document)
	if len(findings) == 0 {
		return findings
	}
	return anchorFindings(document, findings)
}

// anchorFindings moves a finding whose pointer names a member the document does
// not have to the nearest ancestor it does have. A required member that is
// missing, or an element that is null, is reported at the object that should
// hold it, so every pointer resolves against the document it was checked from.
func anchorFindings(document Dashboard, findings []*insightsv1.CheckFinding) []*insightsv1.CheckFinding {
	var tree any
	if json.Unmarshal(document, &tree) != nil {
		return findings
	}
	for _, finding := range findings {
		finding.Pointer = nearestPresentPointer(tree, finding.GetPointer())
	}
	return findings
}

// nearestPresentPointer returns pointer if the tree holds the node it names,
// and otherwise the longest ancestor of it that the tree holds.
func nearestPresentPointer(tree any, pointer string) string {
	for !pointerPresent(tree, pointer) {
		cut := strings.LastIndex(pointer, "/")
		if cut <= 0 {
			return ""
		}
		pointer = pointer[:cut]
	}
	return pointer
}

// pointerPresent reports whether the tree holds the node at an RFC 6901 pointer.
// The empty pointer names the root, which is always present.
func pointerPresent(tree any, pointer string) bool {
	node := tree
	if pointer == "" {
		return true
	}
	for _, segment := range strings.Split(pointer[1:], "/") {
		segment = strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")
		switch current := node.(type) {
		case map[string]any:
			next, ok := current[segment]
			if !ok {
				return false
			}
			node = next
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(current) {
				return false
			}
			node = current[index]
		default:
			return false
		}
	}
	return true
}

// unanchoredSchemaFindings runs the schema checks and reports each finding at the
// pointer its validator named. schemaFindings anchors those pointers.
func unanchoredSchemaFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	if !validID.MatchString(id) || len(document) > maxDocumentBytes {
		return []*insightsv1.CheckFinding{findingAt("", errAt("", "dashboard id or size is invalid"), "")}
	}
	root, err := requireObjectShape(document, dashboardRequiredFields, dashboardOptionalFields)
	if err != nil {
		return []*insightsv1.CheckFinding{findingAt("", err, "")}
	}
	if finding := extensionFinding(root); finding != nil {
		return []*insightsv1.CheckFinding{finding}
	}
	var widgets []json.RawMessage
	if json.Unmarshal(root["widgets"], &widgets) != nil {
		return []*insightsv1.CheckFinding{findingAt("", errAt("/widgets", "widgets must be an array"), "")}
	}
	findings, shapeOK := widgetShapeFindings(widgets)
	var header dashboardHeader
	if json.Unmarshal(document, &header) != nil {
		return append(findings, findingAt("", errAt("", "dashboard must be a valid JSON object"), ""))
	}
	findings = append(findings, identityFindings(id, &header)...)
	if len(widgets) > maxDashboardWidgets {
		return append(findings, findingAt("", errAt("/widgets", "dashboard requires an array of at most 48 widgets"), ""))
	}
	return append(findings, widgetContentFindings(widgets, shapeOK)...)
}

// extensionFinding runs the document-level extension checks, in their fixed
// order, and returns the first failure, or nil.
func extensionFinding(root map[string]json.RawMessage) *insightsv1.CheckFinding {
	for _, field := range dashboardExtensionFields {
		raw, ok := root[field]
		if !ok {
			continue
		}
		if err := validateDashboardExtensions(map[string]json.RawMessage{field: raw}); err != nil {
			return findingAt("", err, "")
		}
	}
	return nil
}

// identityFindings checks the top-level identity fields. It returns at most one
// finding, the first failure in the order validateDashboardIdentity reports.
func identityFindings(id string, header *dashboardHeader) []*insightsv1.CheckFinding {
	identity := &dashboardDocument{SchemaVersion: header.SchemaVersion, ID: header.ID, Title: header.Title, Description: header.Description, TimeRange: header.TimeRange, RefreshInterval: header.RefreshInterval}
	if err := validateDashboardIdentity(identity, id); err != nil {
		return []*insightsv1.CheckFinding{findingAt("", err, "")}
	}
	return nil
}

// widgetShapeFindings checks each widget's structure and reports every failure.
// It also returns which widgets passed, so content checks run only on those.
func widgetShapeFindings(widgets []json.RawMessage) (findings []*insightsv1.CheckFinding, shapeOK []bool) {
	shapeOK = make([]bool, len(widgets))
	for i, widget := range widgets {
		if err := validateDashboardWidgetShape(widget); err != nil {
			findings = append(findings, findingAt(widgetBase(i), err, widgetIDOf(widget)))
			continue
		}
		shapeOK[i] = true
	}
	return findings, shapeOK
}

// widgetContentFindings runs the id, text, type and layout checks on every
// widget whose shape passed. Duplicate ids are judged across the widgets that
// were checked, in document order.
func widgetContentFindings(widgets []json.RawMessage, shapeOK []bool) []*insightsv1.CheckFinding {
	seen := make(map[string]bool, len(widgets))
	var findings []*insightsv1.CheckFinding
	for i, raw := range widgets {
		if !shapeOK[i] {
			continue
		}
		var widget dashboardWidget
		if json.Unmarshal(raw, &widget) != nil {
			findings = append(findings, findingAt(widgetBase(i), errAt("", "dashboard must be a valid JSON object"), widgetIDOf(raw)))
			continue
		}
		if err := validateDashboardWidget(&widget, seen); err != nil {
			findings = append(findings, findingAt(widgetBase(i), err, widget.ID))
		}
	}
	return findings
}

// findingAt turns a validator error into an error-severity schema finding. base
// is the pointer of the value the validator checked; the error's own pointer,
// relative to that value, is appended to it. An error that names no pointer
// concerns the value itself. The rule id follows from the final pointer, so it
// never depends on a submitted key. The widget id is checked before it is used.
func findingAt(base string, err error, widgetID string) *insightsv1.CheckFinding {
	pointer, message := base, err.Error()
	var pointed *pointedError
	if errors.As(err, &pointed) {
		pointer += pointed.pointer
	}
	pointer = boundPointer(pointer)
	return schemaFinding(ruleFor(pointer), pointer, message, widgetID)
}

// ruleFor names the rule for a schema finding from where it points. The set of
// rule ids is closed: a submitted key only ever changes the pointer, and an
// unknown widget member is reported as the shape rule.
func ruleFor(pointer string) string {
	if pointer == "" {
		return ruleDocument
	}
	segments := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	switch segments[0] {
	case "timeRange":
		return ruleDocumentTimeRange
	case "refreshInterval":
		return ruleDocumentRefresh
	case "variables", "folder", "customTimeRange", "timeZone":
		return "schema.document." + segments[0]
	case "widgets":
		if len(segments) == 1 {
			return ruleWidgets
		}
		if len(segments) == 2 {
			return ruleWidgetShape
		}
		return widgetRule(segments[2])
	default:
		return ruleDocument
	}
}

// widgetRule names the rule for a widget member. Members that are not part of
// the widget contract report the shape rule.
func widgetRule(member string) string {
	switch member {
	case "id":
		return ruleWidgetID
	case "type":
		return ruleWidgetType
	case "layout":
		return ruleWidgetLayout
	case "title", "description", "unit", "providerId", "query":
		return ruleWidgetText
	case "options":
		return ruleWidgetOptions
	case "color", "pluginId", "dataKind", "config", "drilldowns", "queryRef", "selectionBindings", "annotationSource":
		return "schema.widget." + member
	default:
		return ruleWidgetShape
	}
}

// schemaFinding builds an error-severity schema finding. It bounds the message
// and checks the widget id, so no field grows with the submitted document.
func schemaFinding(rule, pointer, message, widgetID string) *insightsv1.CheckFinding {
	if !validID.MatchString(widgetID) {
		widgetID = ""
	}
	return &insightsv1.CheckFinding{
		RuleId:   rule,
		Severity: insightsv1.Severity_SEVERITY_ERROR,
		Source:   insightsv1.Source_SOURCE_SCHEMA,
		WidgetId: widgetID,
		Pointer:  pointer,
		Message:  truncateRunes(message, maxFindingMessageRunes),
		Fix:      checkFixes[rule],
	}
}

// widgetBase is the JSON Pointer of the widget at index.
func widgetBase(index int) string {
	return "/widgets/" + strconv.Itoa(index)
}

func widgetIDOf(raw json.RawMessage) string {
	var head struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &head) != nil {
		return ""
	}
	return head.ID
}

// pointedError is a validation failure that names the member it concerns.
// pointer is an RFC 6901 JSON Pointer relative to the value the validator
// checked; the empty string means that value itself. message is the text the
// service has always reported, so wrapping the error never changes it.
//
// A validator reports the pointer of the member that failed. A parent places
// the child's error under its own member or element with in, so the pointer
// grows as the error travels up and always names the exact node.
type pointedError struct {
	pointer string
	message string
}

func (e *pointedError) Error() string { return e.message }

// errAt reports message at a pointer relative to the value being checked.
func errAt(pointer, message string) error {
	return &pointedError{pointer: pointer, message: message}
}

// fieldErr reports message at a named member of the value being checked.
func fieldErr(field, message string) error {
	return errAt("/"+escapePointerSegment(field), message)
}

// in places an error from a child value under its member or element segment.
// An error that names no pointer concerns the child itself, so it lands on the
// child's own pointer.
func in(segment string, err error) error {
	if err == nil {
		return nil
	}
	var pointed *pointedError
	if errors.As(err, &pointed) {
		return &pointedError{pointer: "/" + escapePointerSegment(segment) + pointed.pointer, message: pointed.message}
	}
	return &pointedError{pointer: "/" + escapePointerSegment(segment), message: err.Error()}
}

// decodeMember decodes raw into v for a validator that reports message. encoding/json
// names the first member of the wrong JSON type in UnmarshalTypeError.Field, so a
// wrong member is reported at that member and not at a valid neighbour. Any other
// failure, such as a value that is not an object, names the element itself.
func decodeMember(raw []byte, v any, message string) error {
	err := json.Unmarshal(raw, v)
	if err == nil {
		return nil
	}
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return errAt(fieldPointer(typeErr.Field), message)
	}
	return errors.New(message)
}

// fieldPointer turns the dotted member path encoding/json reports into a JSON Pointer.
func fieldPointer(path string) string {
	var pointer strings.Builder
	for _, segment := range strings.Split(path, ".") {
		pointer.WriteString("/" + escapePointerSegment(segment))
	}
	return pointer.String()
}

// maxKeyPointerBytes is the longest member name a finding names exactly. A
// longer submitted key would only make the pointer long, so the finding names
// the object that holds it.
const maxKeyPointerBytes = 96

// keyPointer is the pointer error for a submitted member name, relative to its
// object. Long names fall back to the object itself, as described above.
func keyPointer(key string) string {
	escaped := escapePointerSegment(key)
	if len(escaped) > maxKeyPointerBytes {
		return ""
	}
	return "/" + escaped
}

// escapePointerSegment applies RFC 6901 escaping: "~" becomes "~0" and "/" becomes "~1".
func escapePointerSegment(segment string) string {
	return strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
}

// boundPointer keeps a pointer within the wire bound. A longer pointer is cut
// back to its nearest ancestor that fits, which still names a real node.
func boundPointer(pointer string) string {
	limit := checkwire.MaxPointerBytes
	if len(pointer) <= limit {
		return pointer
	}
	// Search one byte past the limit: a slash at the limit starts the next
	// segment, so the segments before it fit and the cut lands on it.
	return pointer[:strings.LastIndex(pointer[:limit+1], "/")]
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

// dryRunPlaceholderID stands in for the path id of a dry run when the document
// has no string id. The structure checks then report the document the way a save does.
const dryRunPlaceholderID = "dry-run"

// dryRunFindings checks a document the way a save at the path named by its own
// id would, so a dry run reports exactly what the save reports. Structure is
// checked before identity, and a missing or non-string id is never compared.
func dryRunFindings(document Dashboard) []*insightsv1.CheckFinding {
	var head struct {
		ID *string `json:"id"`
	}
	id := dryRunPlaceholderID
	if json.Unmarshal(document, &head) == nil && head.ID != nil {
		id = *head.ID
	}
	return saveFindings(id, document)
}

// capCheckReport keeps the first checkwire.MaxIssues findings and counts the rest.
// Document-level findings come first, so a count or identity failure is never
// pushed past the cap by many widget findings.
func capCheckReport(findings []*insightsv1.CheckFinding) *insightsv1.CheckReport {
	ordered := documentFirst(findings)
	report := &insightsv1.CheckReport{Total: checkwire.Count(len(ordered))}
	// Severity counts cover every finding, including those past the cap, so a
	// truncated report never understates its errors.
	counts := checkwire.CountSeverities(ordered)
	report.ErrorCount, report.WarningCount, report.InfoCount = counts.Errors, counts.Warnings, counts.Infos
	if len(ordered) > checkwire.MaxIssues {
		ordered = ordered[:checkwire.MaxIssues]
		report.Truncated = true
	}
	report.Issues = ordered
	return report
}

// documentFirst returns the findings with document-level ones ahead of widget
// ones. Each group keeps its validation order.
func documentFirst(findings []*insightsv1.CheckFinding) []*insightsv1.CheckFinding {
	ordered := make([]*insightsv1.CheckFinding, 0, len(findings))
	for _, finding := range findings {
		if !strings.HasPrefix(finding.GetPointer(), "/widgets/") {
			ordered = append(ordered, finding)
		}
	}
	for _, finding := range findings {
		if strings.HasPrefix(finding.GetPointer(), "/widgets/") {
			ordered = append(ordered, finding)
		}
	}
	return ordered
}

// dryRunSummaryOptions bounds what the dry run keeps of each query result. Eight
// series is the most a summary holds, so the unit rule sees every series the
// summary keeps. The caller never receives these summaries, only the findings
// and per-widget states derived from them.
var dryRunSummaryOptions = DashboardSummaryOptions{MaxSeries: 8, MaxTraces: 1}

// dryRunInputError is a caller error in a dry run with execute: the variables or
// the document's time range cannot be used. It is reported as a 400.
type dryRunInputError struct{ message string }

func (e *dryRunInputError) Error() string { return e.message }

// dryRunOutcome is what executing a document's queries reports: the data.*
// findings and one state per widget, in document order.
type dryRunOutcome struct {
	findings []*insightsv1.CheckFinding
	widgets  []*insightsv1.WidgetDataState
}

// executeDryRun answers a dry run that asks for execute. A document with a schema
// or error-severity lint finding is not executed, because it could not be saved;
// each of its widgets reports not_run. Otherwise every distinct query runs once,
// through the same path query_dashboard uses, under the same budget.
func (s *Server) executeDryRun(w http.ResponseWriter, r *http.Request, request *checkRequest) {
	findings := dryRunFindings(request.Document)
	if hasErrorFinding(findings) {
		writeDryRunReport(w, capCheckReport(findings), notRunStates(request.Document))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dashboardQueryBudget)
	defer cancel()
	outcome, err := s.dryRunData(r.WithContext(ctx), request.Document, request.Variables)
	if err != nil {
		var input *dryRunInputError
		if errors.As(err, &input) {
			writeError(w, http.StatusBadRequest, input.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "dashboard validation failed")
		return
	}
	writeDryRunReport(w, capCheckReport(append(findings, outcome.findings...)), outcome.widgets)
}

// dryRunData plans the document's widgets and runs their queries with the shared
// dashboard path, then reports what each returned. It reads the document and
// the query providers only; it never writes.
func (s *Server) dryRunData(r *http.Request, document Dashboard, variables map[string]string) (dryRunOutcome, error) {
	var doc dashboardReadDocument
	if err := json.Unmarshal(document, &doc); err != nil {
		return dryRunOutcome{}, fmt.Errorf("decode dry-run document: %w", err)
	}
	if len(variables) > checkwire.MaxDryRunVariables {
		return dryRunOutcome{}, &dryRunInputError{message: "variables must contain at most 20 string values"}
	}
	values, err := dashboardVariableValues(doc.Variables, variables)
	if err != nil {
		return dryRunOutcome{}, &dryRunInputError{message: err.Error()}
	}
	now := time.Now().UTC()
	queryRange, start, end, err := dashboardQueryTimeRange(&dashboardQueryRequest{}, &doc, now)
	if err != nil {
		return dryRunOutcome{}, &dryRunInputError{message: err.Error()}
	}
	saved, err := s.dashboardSavedQuerySnapshot(doc.Widgets)
	if err != nil {
		return dryRunOutcome{}, err
	}
	result := DashboardQueryResult{
		SchemaVersion: 1, Dashboard: DashboardQueryDocument{ID: doc.ID, Title: doc.Title},
		ObservedAt: now.Format(time.RFC3339Nano), Range: queryRange, Variables: values,
		Widgets: make([]DashboardQueryWidget, 0, len(doc.Widgets)), SavedQueries: []DashboardQueryDocument{}, Signals: []DashboardSignal{}, State: "empty",
	}
	s.runDashboardPlan(r, &result, doc.Widgets, saved, doc.Variables, start, end, dryRunSummaryOptions)
	return dryRunWidgets(&doc, &result, saved, end), nil
}

// dryRunWidgets joins each planned widget to its executed query and derives the
// data.* findings and per-widget states. Planned widgets keep the document's
// order, so result.Widgets[i] is the widget at /widgets/i. end is the query range
// end, which the freshness of the widgets the query path does not judge is measured from.
func dryRunWidgets(doc *dashboardReadDocument, result *DashboardQueryResult, saved map[string]dashboardSavedSnapshot, end float64) dryRunOutcome {
	signals := make(map[string]*DashboardSignal, len(result.Signals))
	for i := range result.Signals {
		signals[result.Signals[i].ID] = &result.Signals[i]
	}
	widgets := make([]dataWidget, 0, len(result.Widgets))
	for i := range result.Widgets {
		planned := &result.Widgets[i]
		declared := &doc.Widgets[i]
		widget := dataWidget{
			index: i, id: planned.ID, title: planned.Title, widgetType: declared.Type, pluginID: declared.PluginID, unit: planned.Unit,
			queryRef: declared.QueryRef != nil, expression: dryRunExpression(declared, saved),
			options: dataOptionsOf(declared), failure: planned.Error, annotation: planned.AnnotationError,
			signal: signals[planned.SignalID], freshness: dryRunWidgetFreshness(planned, declared, signals[planned.SignalID], end),
		}
		if widget.failure == nil && widget.signal != nil {
			widget.failure = widget.signal.Error
		}
		widgets = append(widgets, widget)
	}
	states := make([]*insightsv1.WidgetDataState, 0, len(widgets))
	for i := range widgets {
		states = append(states, widgetDataState(&widgets[i]))
	}
	return dryRunOutcome{findings: dataFindings(widgets), widgets: states}
}

// dryRunWidgetFreshness is the freshness a widget's data state and data.stale
// read. A stat keeps the query path's judgement; a timeseries or rich-metrics
// widget over metrics is judged here against its own staleAfterSeconds.
func dryRunWidgetFreshness(planned *DashboardQueryWidget, declared *dashboardReadWidget, signal *DashboardSignal, end float64) *DashboardObservationFreshness {
	if planned.Freshness != nil {
		return planned.Freshness
	}
	if signal == nil || signal.Error != nil || signal.Kind != "metrics" || declared.Options.StaleAfterSeconds == nil || !staleJudgedByDryRun(declared) {
		return nil
	}
	return dryRunFreshness(signal, end, *declared.Options.StaleAfterSeconds)
}

// staleJudgedByDryRun reports whether a widget honours staleAfterSeconds beyond
// the stat the query path judges: a timeseries, or the rich-metrics plugin.
func staleJudgedByDryRun(declared *dashboardReadWidget) bool {
	return declared.Type == "timeseries" || (declared.Type == "plugin" && declared.PluginID == "rich-metrics")
}

// dryRunExpression is the query text a widget reads: its own, or its saved query's.
func dryRunExpression(declared *dashboardReadWidget, saved map[string]dashboardSavedSnapshot) string {
	if declared.QueryRef != nil {
		return saved[declared.QueryRef.ID].Query.Query
	}
	return declared.Query
}

// dataOptionsOf reads the declared options the data rules compare with.
func dataOptionsOf(declared *dashboardReadWidget) dataOptions {
	options := dataOptions{showSparkline: declared.Options.ShowSparkline, min: declared.Options.Min, max: declared.Options.Max}
	var colors []json.RawMessage
	if json.Unmarshal(declared.Options.SeriesColors, &colors) == nil {
		options.seriesColors = len(colors)
	}
	for _, threshold := range declared.Options.Thresholds {
		options.thresholds = append(options.thresholds, threshold.Value)
	}
	return options
}

// dryRunFreshness judges the newest valid sample across a widget's summarised
// series against its staleAfterSeconds, as the query path judges a stat. It returns
// nil when no series holds a valid sample, so there is nothing to judge.
func dryRunFreshness(signal *DashboardSignal, end, threshold float64) *DashboardObservationFreshness {
	newest := math.Inf(-1)
	for i := range signal.Series {
		if last := signal.Series[i].Last; last != nil {
			newest = math.Max(newest, last.Timestamp)
		}
	}
	if math.IsInf(newest, -1) {
		return nil
	}
	age := math.Max(0, end-newest/1000)
	freshness := &DashboardObservationFreshness{ThresholdSeconds: int(threshold), State: "fresh", LastTimestamp: &newest, AgeSeconds: &age}
	if age > threshold {
		freshness.State = "stale"
	}
	return freshness
}

// widgetDataState reports one widget's data for the dry-run report.
func widgetDataState(widget *dataWidget) *insightsv1.WidgetDataState {
	state := &insightsv1.WidgetDataState{
		WidgetId: boundedWidgetID(widget.id),
		Pointer:  widgetBase(widget.index),
		State:    dataStateOf(widget),
	}
	if widget.signal != nil && widget.signal.SeriesReturned != nil {
		state.SeriesReturned = checkwire.Count(*widget.signal.SeriesReturned)
	}
	if failure := widget.failure; failure != nil {
		state.ErrorCode = failureCode(failure.Code)
	}
	return state
}

// failureCode returns a query error code the report may carry. Codes are fixed
// names; anything else is reported as a generic failure.
func failureCode(code string) string {
	if _, known := queryCodeText[code]; known {
		return code
	}
	return "provider_error"
}

// notRunStates reports every widget of a document that was not executed. Each
// widget is reported on its own, so an id that is not a string only blanks that
// widget's id. It is bounded by the widget limit, which a document with more
// widgets fails anyway.
func notRunStates(document Dashboard) []*insightsv1.WidgetDataState {
	var head struct {
		Widgets []json.RawMessage `json:"widgets"`
	}
	states := []*insightsv1.WidgetDataState{}
	if json.Unmarshal(document, &head) != nil {
		return states
	}
	for i, widget := range head.Widgets {
		if i == maxDashboardWidgets {
			break
		}
		states = append(states, &insightsv1.WidgetDataState{WidgetId: boundedWidgetID(widgetIDOf(widget)), Pointer: widgetBase(i), State: insightsv1.DataState_DATA_STATE_NOT_RUN})
	}
	return states
}

// writeDryRunReport writes a dry run that executed, or was asked to. The report
// bytes are the same CheckReport a dry run writes, with the per-widget states
// added after its members, so the list shape stays what clients already read.
func writeDryRunReport(w http.ResponseWriter, report *insightsv1.CheckReport, widgets []*insightsv1.WidgetDataState) {
	body, err := checkwire.Marshal(report)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "dashboard validation failed")
		return
	}
	var out bytes.Buffer
	out.Write(body[:len(body)-1])
	out.WriteString(`,"widgets":[`)
	for i, state := range widgets {
		encoded, err := checkwire.Marshal(state)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "dashboard validation failed")
			return
		}
		if i > 0 {
			out.WriteByte(',')
		}
		out.Write(encoded)
	}
	out.WriteString("]}")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(out.Bytes()); err != nil {
		slog.Debug("could not write insights dry run report")
	}
}
