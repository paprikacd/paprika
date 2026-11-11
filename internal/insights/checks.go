package insights

import (
	"encoding/json"
	"strconv"
	"strings"
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
	ruleWidget            = "schema.widget"
	ruleWidgetShape       = "schema.widget.shape"
	ruleWidgetID          = "schema.widget.id"
	ruleWidgetText        = "schema.widget.text"
	ruleWidgetType        = "schema.widget.type"
	ruleWidgetLayout      = "schema.widget.layout"
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
func schemaFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	if !validID.MatchString(id) || len(document) > maxDocumentBytes {
		return []*insightsv1.CheckFinding{schemaFinding(ruleDocument, "", "dashboard id or size is invalid", "")}
	}
	root, err := requireObjectShape(document, dashboardRequiredFields, dashboardOptionalFields)
	if err != nil {
		return []*insightsv1.CheckFinding{schemaFinding(ruleDocument, "", err.Error(), "")}
	}
	if finding := extensionFinding(root); finding != nil {
		return []*insightsv1.CheckFinding{finding}
	}
	var widgets []json.RawMessage
	if json.Unmarshal(root["widgets"], &widgets) != nil {
		return []*insightsv1.CheckFinding{schemaFinding(ruleWidgets, "/widgets", "widgets must be an array", "")}
	}
	findings, shapeOK := widgetShapeFindings(widgets)
	var header dashboardHeader
	if json.Unmarshal(document, &header) != nil {
		return append(findings, schemaFinding(ruleDocument, "", "dashboard must be a valid JSON object", ""))
	}
	findings = append(findings, identityFindings(id, &header)...)
	if len(widgets) > maxDashboardWidgets {
		return append(findings, schemaFinding(ruleWidgets, "/widgets", "dashboard requires an array of at most 48 widgets", ""))
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
			return schemaFinding("schema.document."+field, "/"+field, err.Error(), "")
		}
	}
	return nil
}

// identityFindings checks the top-level identity fields. It returns at most one
// finding, the first failure in the order validateDashboardIdentity reports.
func identityFindings(id string, header *dashboardHeader) []*insightsv1.CheckFinding {
	identity := &dashboardDocument{SchemaVersion: header.SchemaVersion, ID: header.ID, Title: header.Title, Description: header.Description, TimeRange: header.TimeRange, RefreshInterval: header.RefreshInterval}
	if err := validateDashboardIdentity(identity, id); err != nil {
		return []*insightsv1.CheckFinding{identityFinding(err)}
	}
	return nil
}

// widgetShapeFindings checks each widget's structure and reports every failure.
// It also returns which widgets passed, so content checks run only on those.
func widgetShapeFindings(widgets []json.RawMessage) (findings []*insightsv1.CheckFinding, shapeOK []bool) {
	shapeOK = make([]bool, len(widgets))
	for i, widget := range widgets {
		if err := validateDashboardWidgetShape(widget); err != nil {
			findings = append(findings, schemaFinding(ruleWidgetShape, widgetPointer(i, ""), err.Error(), widgetIDOf(widget)))
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
			findings = append(findings, schemaFinding(ruleWidgetShape, widgetPointer(i, ""), "dashboard must be a valid JSON object", widgetIDOf(raw)))
			continue
		}
		if err := validateDashboardWidget(&widget, seen); err != nil {
			rule, field := widgetContentRule(err)
			findings = append(findings, schemaFinding(rule, widgetPointer(i, field), err.Error(), widget.ID))
		}
	}
	return findings
}

// widgetContentRule names the rule and the field a widget content message
// describes. Messages that span several fields point at the widget itself.
func widgetContentRule(err error) (rule, field string) {
	switch err.Error() {
	case "widget ids must be valid and unique":
		return ruleWidgetID, "/id"
	case "unsupported widget type":
		return ruleWidgetType, "/type"
	case "widget layout is outside the dashboard grid":
		return ruleWidgetLayout, "/layout"
	case "widget title or metadata is invalid", "widget provider and query are required":
		return ruleWidgetText, ""
	default:
		return ruleWidget, ""
	}
}

// identityFinding names the identity rule for a document-level identity failure.
func identityFinding(err error) *insightsv1.CheckFinding {
	switch err.Error() {
	case "unsupported dashboard time range":
		return schemaFinding(ruleDocumentTimeRange, "/timeRange", err.Error(), "")
	case "unsupported refresh interval":
		return schemaFinding(ruleDocumentRefresh, "/refreshInterval", err.Error(), "")
	default:
		return schemaFinding(ruleDocument, "", err.Error(), "")
	}
}

func widgetPointer(index int, field string) string {
	return "/widgets/" + strconv.Itoa(index) + field
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
	return schemaFindings(id, document)
}

// capCheckReport keeps the first checkwire.MaxIssues findings and counts the rest.
// Document-level findings come first, so a count or identity failure is never
// pushed past the cap by many widget findings.
func capCheckReport(findings []*insightsv1.CheckFinding) *insightsv1.CheckReport {
	ordered := documentFirst(findings)
	report := &insightsv1.CheckReport{Total: checkwire.Count(len(ordered))}
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
