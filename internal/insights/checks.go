package insights

import (
	"encoding/json"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protojson"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// maxCheckFindings bounds every findings list the service returns: the 400
// response to a rejected save and the validate dry run. Agents retry against
// the listed issues, so one bad document cannot produce an unbounded payload.
const maxCheckFindings = 32

// Findings are copied into responses and tool errors, so their text stays small
// even when a submitted key is long.
const maxFindingMessageRunes = 200
const maxFindingPointerBytes = 256

const maxDashboardWidgets = 48
const maxLocateDepth = 8

var checkJSON = protojson.MarshalOptions{EmitUnpopulated: true}

var dashboardRequiredFields = []string{"schemaVersion", "id", "title", "timeRange", "refreshInterval", "widgets"}
var dashboardOptionalFields = []string{"description", "folder", "customTimeRange", "timeZone", "variables"}

// dashboardExtensionFields is the order validateDashboardExtensions checks them in.
var dashboardExtensionFields = []string{"variables", "folder", "customTimeRange", "timeZone"}

// Messages produced by the validators in store.go map to the field they
// describe. A message without an entry points at the widget or document itself.
var widgetMessagePointers = map[string]string{
	"widget ids must be valid and unique":         "/id",
	"unsupported widget type":                     "/type",
	"widget layout is outside the dashboard grid": "/layout",
}

var documentMessagePointers = map[string]string{
	"unsupported dashboard time range": "/timeRange",
	"unsupported refresh interval":     "/refreshInterval",
}

// widgetFields and dashboardFields are the names a rule may cite. A key the
// document invented is reported under the generic rule, so a long or hostile
// key never becomes part of a rule id.
var widgetFields = []string{"id", "title", "type", "providerId", "query", "unit", "layout", "description", "color", "options", "pluginId", "dataKind", "config", "drilldowns", "queryRef", "selectionBindings", "annotationSource"}
var dashboardFields = append(append([]string{}, dashboardRequiredFields...), dashboardOptionalFields...)

// checkFixes gives agents the allowed values for the most common rule
// violations. Rules without an entry have a message that already says enough.
var checkFixes = map[string]string{
	"schema.widget.layout":            "Keep x and y at least 0, y at most 1000, w from 1 to 12 with x + w at most 12, and h from 2 to 12 (1 for stat widgets).",
	"schema.widget.id":                "Use a unique id of up to 80 letters, digits, underscores or hyphens, starting with a letter or digit.",
	"schema.widget.type":              "Use one of timeseries, bar, stat, table, traces, heatmap or plugin.",
	"schema.widgets":                  "Use an array of at most 48 widgets.",
	"schema.document.timeRange":       "Use one of 15m, 30m, 1h, 6h, 24h, 7d or 30d.",
	"schema.document.refreshInterval": "Use 0, 15, 30 or 60 seconds.",
}

// schemaFindings returns every save-time schema finding for a submitted
// document, in the order the store checks them. The first finding carries the
// message a save has always reported, so the existing error field keeps its
// meaning. Structural failures stop the check, as they always have; widget
// failures are collected for every widget, each with its own pointer.
func schemaFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	root, findings := documentStructureFindings(id, document)
	if findings != nil {
		return findings
	}
	if shape := widgetShapeFindings(root["widgets"]); len(shape) > 0 {
		return shape
	}
	return semanticFindings(id, document)
}

// documentStructureFindings checks the identity, size, required fields and
// document-level extensions. It returns the parsed root object, or the single
// fatal finding that stops the check.
func documentStructureFindings(id string, document Dashboard) (map[string]json.RawMessage, []*insightsv1.CheckFinding) {
	if !validID.MatchString(id) || len(document) > maxDocumentBytes {
		return nil, []*insightsv1.CheckFinding{schemaFinding("", "dashboard id or size is invalid", "")}
	}
	root, err := requireObjectShape(document, dashboardRequiredFields, dashboardOptionalFields)
	if err != nil {
		return nil, []*insightsv1.CheckFinding{schemaFinding("", err.Error(), "")}
	}
	for _, field := range dashboardExtensionFields {
		raw, ok := root[field]
		if !ok {
			continue
		}
		if err := validateDashboardExtensions(map[string]json.RawMessage{field: raw}); err != nil {
			return nil, []*insightsv1.CheckFinding{schemaFinding("/"+field, err.Error(), "")}
		}
	}
	return root, nil
}

// semanticFindings checks the dashboard identity and each widget's id, text,
// type and grid placement. Every widget is checked, so one save reports them all.
func semanticFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	var d dashboardDocument
	if json.Unmarshal(document, &d) != nil {
		return []*insightsv1.CheckFinding{schemaFinding("", "dashboard must be a valid JSON object", "")}
	}
	if err := validateDashboardIdentity(&d, id); err != nil {
		return []*insightsv1.CheckFinding{schemaFinding(documentMessagePointers[err.Error()], err.Error(), "")}
	}
	if d.Widgets == nil || len(d.Widgets) > maxDashboardWidgets {
		return []*insightsv1.CheckFinding{schemaFinding("/widgets", "dashboard requires an array of at most 48 widgets", "")}
	}
	var findings []*insightsv1.CheckFinding
	seen := make(map[string]bool, len(d.Widgets))
	for i := range d.Widgets {
		if err := validateDashboardWidget(&d.Widgets[i], seen); err != nil {
			base := "/widgets/" + strconv.Itoa(i)
			findings = append(findings, schemaFinding(base+widgetMessagePointers[err.Error()], err.Error(), d.Widgets[i].ID))
		}
	}
	return findings
}

// widgetShapeFindings checks each widget's structure. Shape errors can sit
// deep in options, so each one is located by locateShapeError.
func widgetShapeFindings(raw json.RawMessage) []*insightsv1.CheckFinding {
	var widgets []json.RawMessage
	if json.Unmarshal(raw, &widgets) != nil {
		return []*insightsv1.CheckFinding{schemaFinding("/widgets", "widgets must be an array", "")}
	}
	var findings []*insightsv1.CheckFinding
	for i, widget := range widgets {
		err := validateDashboardWidgetShape(widget)
		if err == nil {
			continue
		}
		base := "/widgets/" + strconv.Itoa(i)
		pointer := locateShapeError(widget)
		if len(base+pointer) > maxFindingPointerBytes {
			pointer = ""
		}
		findings = append(findings, schemaFinding(base+pointer, err.Error(), widgetIDOf(widget)))
	}
	return findings
}

// locateShapeError returns the JSON Pointer, relative to the widget, of the
// smallest node whose removal makes the widget valid. It narrows from the widget
// root into objects and arrays. A node is kept only when exactly one of its
// children is that culprit, so an ambiguous error stops at the enclosing node
// instead of naming the wrong option. The probes need no knowledge of each
// option's rules, so the option validators stay unchanged.
func locateShapeError(widget json.RawMessage) string {
	return locateNode(widget, func(node json.RawMessage) json.RawMessage { return node }, "", 0)
}

// locateNode narrows toward the culprit inside node. rebuild returns the whole
// widget with node put back where it came from, so every probe validates the
// full widget.
func locateNode(node json.RawMessage, rebuild func(json.RawMessage) json.RawMessage, pointer string, depth int) string {
	if depth >= maxLocateDepth {
		return pointer
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(node, &fields) == nil && fields != nil {
		return locateInObject(fields, rebuild, pointer, depth)
	}
	var elements []json.RawMessage
	if json.Unmarshal(node, &elements) == nil && elements != nil {
		return locateInArray(elements, rebuild, pointer, depth)
	}
	return pointer
}

func locateInObject(fields map[string]json.RawMessage, rebuild func(json.RawMessage) json.RawMessage, pointer string, depth int) string {
	var culprits []string
	for _, key := range slices.Sorted(maps.Keys(fields)) {
		rest := maps.Clone(fields)
		delete(rest, key)
		if removalFixes(rebuild(marshalObject(rest))) {
			culprits = append(culprits, key)
		}
	}
	if len(culprits) != 1 {
		return pointer
	}
	key := culprits[0]
	return locateNode(fields[key], func(child json.RawMessage) json.RawMessage {
		updated := maps.Clone(fields)
		updated[key] = child
		return rebuild(marshalObject(updated))
	}, pointer+"/"+escapePointerToken(key), depth+1)
}

func locateInArray(elements []json.RawMessage, rebuild func(json.RawMessage) json.RawMessage, pointer string, depth int) string {
	var culprits []int
	for i := range elements {
		if removalFixes(rebuild(marshalArray(slices.Delete(slices.Clone(elements), i, i+1)))) {
			culprits = append(culprits, i)
		}
	}
	if len(culprits) != 1 {
		return pointer
	}
	index := culprits[0]
	return locateNode(elements[index], func(child json.RawMessage) json.RawMessage {
		updated := slices.Clone(elements)
		updated[index] = child
		return rebuild(marshalArray(updated))
	}, pointer+"/"+strconv.Itoa(index), depth+1)
}

func removalFixes(widget json.RawMessage) bool {
	return validateDashboardWidgetShape(widget) == nil
}

func marshalObject(fields map[string]json.RawMessage) json.RawMessage {
	data, err := json.Marshal(fields)
	if err != nil {
		return nil
	}
	return data
}

func marshalArray(elements []json.RawMessage) json.RawMessage {
	data, err := json.Marshal(elements)
	if err != nil {
		return nil
	}
	return data
}

func escapePointerToken(token string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(token)
}

// schemaFinding builds an error-severity schema finding. It bounds the message
// and the widget id, so no field of a finding grows with the submitted document.
func schemaFinding(pointer, message, widgetID string) *insightsv1.CheckFinding {
	rule := ruleForPointer(pointer)
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

// ruleForPointer names the rule from the part of the document a pointer
// reaches: the document, the widget list, a widget, or one widget field.
func ruleForPointer(pointer string) string {
	if pointer == "" {
		return "schema.document"
	}
	segments := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	if segments[0] == "widgets" {
		return widgetRule(segments)
	}
	if slices.Contains(dashboardFields, segments[0]) {
		return "schema.document." + segments[0]
	}
	return "schema.document"
}

func widgetRule(segments []string) string {
	switch {
	case len(segments) == 1:
		return "schema.widgets"
	case len(segments) == 2:
		return "schema.widget"
	case slices.Contains(widgetFields, segments[2]):
		return "schema.widget." + segments[2]
	default:
		return "schema.widget"
	}
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

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

// capCheckReport keeps the first maxCheckFindings findings and counts the rest.
func capCheckReport(findings []*insightsv1.CheckFinding) *insightsv1.CheckReport {
	report := &insightsv1.CheckReport{Total: countOf(len(findings))}
	if len(findings) > maxCheckFindings {
		findings = findings[:maxCheckFindings]
		report.Truncated = true
	}
	report.Findings = findings
	return report
}

// countOf converts a length to the uint32 a report carries, saturating rather
// than wrapping for any value a document could reach.
func countOf(n int) uint32 {
	if n < 0 {
		return 0
	}
	return uint32(min(n, math.MaxUint32))
}
