package insights

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// lintRule is one design rule a dashboard document can break. Schema checks
// reject documents that cannot be stored; lint rules describe documents that
// can be stored but render or read badly. Only an error-severity rule rejects a
// save. Warnings and info travel back in the checks field and never change
// whether a document is stored.
//
// Each rule's summary is a line of composition guidance. The guidance package
// holds that line, and TestLintSummariesAreComposed fails if the two drift.
type lintRule struct {
	ID       string
	Severity insightsv1.Severity
	// Summary is a single imperative guidance line, quote-free and ending with a full stop.
	Summary string
	// Fix tells an author what to change. It is fixed text, never document content.
	Fix   string
	check func(*lintDocument) []lintHit
}

// lintHit is one place a rule fires. pointer is the exact JSON Pointer of the
// member that breaks the rule, and widgetID names the widget it belongs to.
type lintHit struct {
	pointer  string
	widgetID string
	message  string
}

const (
	errorSeverity   = insightsv1.Severity_SEVERITY_ERROR
	warningSeverity = insightsv1.Severity_SEVERITY_WARNING
	infoSeverity    = insightsv1.Severity_SEVERITY_INFO
)

// lintRules is the registry, in report order. A new rule is added to the
// file for its family and to this list; the drift test then requires its summary
// in the composition guidance.
var lintRules = slices.Concat(layoutLintRules, widgetLintRules, textLintRules, variableLintRules, pluginLintRules, colorLintRules)

// lintDocument is the part of a schema-valid document the rules read. It is
// decoded once per call, so every rule sees the same snapshot and the cost stays
// linear in the document size.
type lintDocument struct {
	variables map[string]bool
	widgets   []lintWidget
}

type lintWidget struct {
	index       int
	id          string
	title       string
	widgetType  string
	pluginID    string
	description string
	unit        string
	query       string
	// hasQueryRef is true when a saved query supplies the widget's query. A raw
	// query is then not used, so its placeholders are not variable references.
	hasQueryRef bool
	x, y, w, h  int
	showBar     bool
	showSpark   bool
	xAxisLabel  string
	yAxisLabel  string
	// variables lists each variable reference with the pointer of its variable member.
	variables []lintVariableRef
	// colorFields lists each authored hex that carries no status or role.
	colorFields []colorField
}

type lintVariableRef struct {
	pointer  string
	variable string
}

// wireDocument mirrors only the members lint reads. Unknown members are ignored
// here because the schema check has already rejected them on every save.
type wireDocument struct {
	Variables []struct {
		Name string `json:"name"`
	} `json:"variables"`
	Widgets []wireWidget `json:"widgets"`
}

type wireWidget struct {
	ID                string            `json:"id"`
	Title             string            `json:"title"`
	Type              string            `json:"type"`
	PluginID          string            `json:"pluginId"`
	Description       string            `json:"description"`
	Unit              string            `json:"unit"`
	Query             string            `json:"query"`
	Color             string            `json:"color"`
	Layout            wireLayout        `json:"layout"`
	QueryRef          *wireQueryRef     `json:"queryRef"`
	AnnotationSource  *wireAnnotation   `json:"annotationSource"`
	SelectionBindings []wireBinding     `json:"selectionBindings"`
	Options           *wireWidgetOption `json:"options"`
	Config            json.RawMessage   `json:"config"`
}

type wireLayout struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

type wireAnnotation struct {
	QueryRef *wireQueryRef `json:"queryRef"`
}

type wireQueryRef struct {
	Bindings []wireBinding `json:"bindings"`
}

type wireBinding struct {
	Source   string `json:"source"`
	Variable string `json:"variable"`
}

type wireWidgetOption struct {
	ShowStatBar    bool            `json:"showStatBar"`
	ShowSparkline  bool            `json:"showSparkline"`
	XAxisLabel     string          `json:"xAxisLabel"`
	YAxisLabel     string          `json:"yAxisLabel"`
	TooltipView    *wireTooltip    `json:"tooltipView"`
	Thresholds     []wireThreshold `json:"thresholds"`
	ReferenceLines []wireMark      `json:"referenceLines"`
	SeriesColors   []wireMark      `json:"seriesColors"`
}

type wireTooltip struct {
	Color  string `json:"color"`
	Source *struct {
		Ref *wireQueryRef `json:"ref"`
	} `json:"source"`
}

// wireThreshold names a status or a hue. Status is empty when the band has no status.
type wireThreshold struct {
	Status string `json:"status"`
	Color  string `json:"color"`
}

// wireMark is a colour-carrying rule: a reference line, or a series colour that names a hex or a role.
type wireMark struct {
	Color string `json:"color"`
	Role  string `json:"role"`
}

// wireWidgetConfig holds the plugin config members that carry colours: series colour rules.
type wireWidgetConfig struct {
	SeriesColors []wireMark `json:"seriesColors"`
}

// decodeLintDocument reads the members lint needs. It reports false when the
// document is not an object of the expected shape; a schema-valid document
// always decodes.
func decodeLintDocument(document Dashboard) (*lintDocument, bool) {
	var wire wireDocument
	if json.Unmarshal(document, &wire) != nil {
		return nil, false
	}
	doc := &lintDocument{variables: make(map[string]bool, len(wire.Variables))}
	for _, variable := range wire.Variables {
		doc.variables[variable.Name] = true
	}
	for i := range wire.Widgets {
		widget := &wire.Widgets[i]
		base := widgetBase(i)
		lw := lintWidget{
			index: i, id: widget.ID, title: widget.Title, widgetType: widget.Type, pluginID: widget.PluginID,
			description: widget.Description, unit: widget.Unit, query: widget.Query, hasQueryRef: widget.QueryRef != nil,
			x: widget.Layout.X, y: widget.Layout.Y, w: widget.Layout.W, h: widget.Layout.H,
		}
		if widget.Options != nil {
			lw.showBar = widget.Options.ShowStatBar
			lw.showSpark = widget.Options.ShowSparkline
			lw.xAxisLabel = widget.Options.XAxisLabel
			lw.yAxisLabel = widget.Options.YAxisLabel
		}
		lw.variables = append(lw.variables, variableRefs(base+"/queryRef", widget.QueryRef)...)
		for k, binding := range widget.SelectionBindings {
			lw.variables = append(lw.variables, lintVariableRef{pointer: base + "/selectionBindings/" + strconv.Itoa(k) + "/variable", variable: binding.Variable})
		}
		if widget.AnnotationSource != nil {
			lw.variables = append(lw.variables, variableRefs(base+"/annotationSource/queryRef", widget.AnnotationSource.QueryRef)...)
		}
		if widget.Options != nil && widget.Options.TooltipView != nil && widget.Options.TooltipView.Source != nil {
			lw.variables = append(lw.variables, variableRefs(base+"/options/tooltipView/source/ref", widget.Options.TooltipView.Source.Ref)...)
		}
		lw.colorFields = colorFieldsOf(base, widget)
		doc.widgets = append(doc.widgets, lw)
	}
	return doc, true
}

// colorFieldsOf lists the authored hex colours of one widget that carry no status or role. A threshold
// with a status keeps its colour as a hue override, and a series rule names either a hex or a role, so
// neither is listed as a bare colour. Plugin config is decoded leniently: the schema check has already
// refused a malformed document, and an unreadable config simply has no colours to check.
func colorFieldsOf(base string, widget *wireWidget) []colorField {
	fields := []colorField{}
	if widget.Color != "" {
		fields = append(fields, colorField{pointer: base + "/color", what: "widget colour", hex: widget.Color})
	}
	if widget.Options != nil {
		fields = append(fields, optionColorFields(base, widget.Options)...)
	}
	var config wireWidgetConfig
	if len(widget.Config) > 0 && json.Unmarshal(widget.Config, &config) == nil {
		fields = append(fields, seriesRuleColorFields(base, config.SeriesColors)...)
	}
	return fields
}

// optionColorFields lists the bare colours in a widget's options.
func optionColorFields(base string, option *wireWidgetOption) []colorField {
	var fields []colorField
	for k, threshold := range option.Thresholds {
		if threshold.Status == "" && threshold.Color != "" {
			fields = append(fields, colorField{pointer: base + "/options/thresholds/" + strconv.Itoa(k) + "/color", what: "threshold colour", hex: threshold.Color})
		}
	}
	fields = append(fields, lineAndSeriesColorFields(base, option)...)
	if option.TooltipView != nil && option.TooltipView.Color != "" {
		fields = append(fields, colorField{pointer: base + "/options/tooltipView/color", what: "tooltip colour", hex: option.TooltipView.Color})
	}
	return fields
}

// lineAndSeriesColorFields lists the reference line and series colours in a widget's options.
func lineAndSeriesColorFields(base string, option *wireWidgetOption) []colorField {
	var fields []colorField
	for k, line := range option.ReferenceLines {
		if line.Color != "" {
			fields = append(fields, colorField{pointer: base + "/options/referenceLines/" + strconv.Itoa(k) + "/color", what: "reference line colour", hex: line.Color})
		}
	}
	for k, rule := range option.SeriesColors {
		if rule.Role == "" && rule.Color != "" {
			fields = append(fields, colorField{pointer: base + "/options/seriesColors/" + strconv.Itoa(k) + "/color", what: "series colour", hex: rule.Color})
		}
	}
	return fields
}

// seriesRuleColorFields lists the bare colours in a plugin config's series colour rules. Status-badge
// mappings are not listed: a mapping colour is the status display itself, and until mappings can name a
// status it is the only way to show one. Its status moves into the mapping in a later change.
func seriesRuleColorFields(base string, rules []wireMark) []colorField {
	var fields []colorField
	for k, rule := range rules {
		if rule.Role == "" && rule.Color != "" {
			fields = append(fields, colorField{pointer: base + "/config/seriesColors/" + strconv.Itoa(k) + "/color", what: "series colour", hex: rule.Color})
		}
	}
	return fields
}

// variableRefs lists the bindings that read a dashboard variable. Only the
// variable source reads one; label, value and constant bindings do not.
func variableRefs(base string, ref *wireQueryRef) []lintVariableRef {
	if ref == nil {
		return nil
	}
	var refs []lintVariableRef
	for k, binding := range ref.Bindings {
		if binding.Source == "variable" {
			refs = append(refs, lintVariableRef{pointer: base + "/bindings/" + strconv.Itoa(k) + "/variable", variable: binding.Variable})
		}
	}
	return refs
}

// lintFindings runs every rule over a schema-valid document and returns its
// findings, errors first. Rules run in registry order and hits in document
// order, so the same document always produces the same list.
func lintFindings(document Dashboard) []*insightsv1.CheckFinding {
	doc, ok := decodeLintDocument(document)
	if !ok {
		return nil
	}
	var findings []*insightsv1.CheckFinding
	for _, rule := range lintRules {
		for _, hit := range rule.check(doc) {
			findings = append(findings, lintFinding(rule, hit))
		}
	}
	slices.SortStableFunc(findings, func(a, b *insightsv1.CheckFinding) int {
		return int(b.GetSeverity()) - int(a.GetSeverity())
	})
	return findings
}

func lintFinding(rule lintRule, hit lintHit) *insightsv1.CheckFinding {
	widgetID := hit.widgetID
	if !validID.MatchString(widgetID) {
		widgetID = ""
	}
	return &insightsv1.CheckFinding{
		RuleId:   rule.ID,
		Severity: rule.Severity,
		Source:   insightsv1.Source_SOURCE_LINT,
		WidgetId: widgetID,
		Pointer:  boundPointer(hit.pointer),
		Message:  truncateRunes(hit.message, maxFindingMessageRunes),
		Fix:      rule.Fix,
	}
}

// labelTitleRunes bounds the title quoted in a message, so two labels in one
// message stay well within the message limit.
const labelTitleRunes = 40

// widgetLabel names a widget for a message by its title and id, so an author can
// find it both on the canvas and in the document.
func widgetLabel(widget *lintWidget) string {
	title := []rune(widget.title)
	if len(title) > labelTitleRunes {
		title = append(title[:labelTitleRunes], '…')
	}
	return fmt.Sprintf("%q (%s)", string(title), widget.id)
}

// hasErrorFinding reports whether any finding is error severity, which rejects a save.
func hasErrorFinding(findings []*insightsv1.CheckFinding) bool {
	for _, finding := range findings {
		if finding.GetSeverity() == insightsv1.Severity_SEVERITY_ERROR {
			return true
		}
	}
	return false
}

// saveFindings is what a save and a dry run report for a document at the path
// id. Schema findings come first. Lint only reads a document that passed the
// schema, so it runs only then.
func saveFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	if findings := schemaFindings(id, document); len(findings) > 0 {
		return findings
	}
	return lintFindings(document)
}

// CheckDocument reports every finding for a document at its own id, the same
// findings a dry run reports. The paprika-insights lint command uses it.
func CheckDocument(document Dashboard) []*insightsv1.CheckFinding {
	return dryRunFindings(document)
}

// DashboardSchemaExamples returns the dashboard examples the schema endpoint
// serves, so the lint command can check exactly what agents are shown.
func DashboardSchemaExamples() []json.RawMessage {
	return authoringSchemaExamples("dashboard")
}

// WidgetSchemaExamples returns the widget examples the schema endpoint serves,
// each wrapped in a dashboard so the save-path rules can read it. The wrapper
// declares every variable the widget reads, so the variable rule checks the widget
// itself. The widget's layout is what the lint sees, so a widget example is
// checked for its height, its drawn bar and its sparkline like any other widget.
func WidgetSchemaExamples() ([]Dashboard, error) {
	var documents []Dashboard
	for i, raw := range authoringSchemaExamples("widget") {
		var widget wireWidget
		if err := json.Unmarshal(raw, &widget); err != nil {
			return nil, fmt.Errorf("widget schema example %d: %w", i, err)
		}
		declared := map[string]bool{}
		for _, ref := range variableRefs("", widget.QueryRef) {
			declared[ref.variable] = true
		}
		for _, binding := range widget.SelectionBindings {
			declared[binding.Variable] = true
		}
		for _, match := range placeholder.FindAllStringSubmatch(widget.Query, -1) {
			declared[match[1]] = true
		}
		variables := make([]map[string]string, 0, len(declared))
		for _, name := range slices.Sorted(maps.Keys(declared)) {
			variables = append(variables, map[string]string{"name": name})
		}
		document, err := json.Marshal(map[string]any{
			"schemaVersion": 1, "id": fmt.Sprintf("served-widget-%d", i), "title": "Served widget example",
			"timeRange": "1h", "refreshInterval": 30, "variables": variables, "widgets": []json.RawMessage{raw},
		})
		if err != nil {
			return nil, fmt.Errorf("wrap widget schema example %d: %w", i, err)
		}
		documents = append(documents, Dashboard(document))
	}
	return documents, nil
}

// lintSummaries returns each rule's summary in registry order. It exists so the
// composition test and any other consumer read the same text.
func lintSummaries() []string {
	summaries := make([]string, 0, len(lintRules))
	for _, rule := range lintRules {
		summaries = append(summaries, rule.Summary)
	}
	return summaries
}
