package insights

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strconv"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
	"github.com/benebsworth/paprika/internal/insights/variablevalue"
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
	// pair names the two widgets of a layout overlap; it is zero for other hits.
	pair overlapKey
}

const (
	errorSeverity   = insightsv1.Severity_SEVERITY_ERROR
	warningSeverity = insightsv1.Severity_SEVERITY_WARNING
	infoSeverity    = insightsv1.Severity_SEVERITY_INFO
)

// lintRules is the registry, in report order. A new rule is added to the
// file for its family and to this list; the drift test then requires its summary
// in the composition guidance.
var lintRules = slices.Concat(layoutLintRules, widgetLintRules, textLintRules, variableLintRules, pluginLintRules, colorLintRules, sloLintRules, tableLintRules, selectionLintRules)

// lintDocument is the part of a schema-valid document the rules read. It is
// decoded once per call, so every rule sees the same snapshot and the cost stays
// linear in the document size.
type lintDocument struct {
	variables map[string]bool
	// multi names each declared variable that takes several values, and allowAll each that can also be All.
	multi    map[string]bool
	allowAll map[string]bool
	// sourceVariables lists each declared variable with the members the variable rules read.
	sourceVariables []lintVariable
	// annotationVariables are the variables the dashboard-level event query reads, with its pointer.
	annotationVariables []lintVariableRef
	widgets             []lintWidget
	// providerTypes maps a provider id to its type, as the server resolved it for this check. An id
	// that is absent is unknown, and a rule that needs its type does not fire. The CLI check resolves no
	// providers, so it leaves the map nil.
	providerTypes map[string]string
}

type lintWidget struct {
	index       int
	id          string
	title       string
	widgetType  string
	pluginID    string
	providerID  string
	description string
	unit        string
	query       string
	// hasQueryRef is true when a saved query supplies the widget's query. A raw
	// query is then not used, so its placeholders are not variable references.
	hasQueryRef bool
	x, y, w, h  int
	showBar     bool
	showSpark   bool
	// statIcon is the stat's icon, and compares is true when the stat shows a change against an earlier window.
	statIcon   string
	compares   bool
	xAxisLabel string
	yAxisLabel string
	// variables lists each variable reference with the pointer of its variable member.
	variables []lintVariableRef
	// colorFields lists each authored hex that carries no status or role.
	colorFields []colorField
	// config is the plugin config as authored, read by the SLO rules.
	config json.RawMessage
	// hasThresholds is true when the widget declares any options.thresholds.
	hasThresholds bool
	// thresholds counts the widget's own options.thresholds bands.
	thresholds int
	// cellStyles are the record-table column styles, decoded from config.
	cellStyles []wireCellStyle
	// rank is the record-table rank, decoded from config, or nil when the table does not rank.
	rank *wireRank
	// rankErr is why the rank does not decode strictly, or empty. The UI refuses such a rank, so lint reports it.
	rankErr string
	// statusBands is true when the widget's own options.thresholds name a status.
	statusBands bool
}

type lintVariableRef struct {
	pointer  string
	variable string
	// queryRefID and parameter name the saved query parameter a variable binding fills, when the reference is a
	// saved query's. They are empty for other references.
	queryRefID string
	parameter  string
}

// wireDocument mirrors only the members lint reads. Unknown members are ignored
// here because the schema check has already rejected them on every save.
type wireDocument struct {
	Variables []wireVariable `json:"variables"`
	// AnnotationSource is the dashboard-level event source. Its query reference names variables like a widget's does.
	AnnotationSource *wireAnnotation `json:"annotationSource"`
	Widgets          []wireWidget    `json:"widgets"`
}

// wireVariable mirrors the variable members the variable rules read.
type wireVariable struct {
	Name         string               `json:"name"`
	Multi        bool                 `json:"multi"`
	AllowAll     bool                 `json:"allowAll"`
	DefaultValue *variablevalue.Value `json:"defaultValue"`
	Options      []string             `json:"options"`
	Source       *wireVarSource       `json:"source"`
}

// wireVarSource mirrors a variable source. Type selects which members apply.
type wireVarSource struct {
	Type       string        `json:"type"`
	ProviderID string        `json:"providerId"`
	Selector   *string       `json:"selector"`
	QueryRef   *wireQueryRef `json:"queryRef"`
}

type wireWidget struct {
	ID                string            `json:"id"`
	Title             string            `json:"title"`
	Type              string            `json:"type"`
	PluginID          string            `json:"pluginId"`
	ProviderID        string            `json:"providerId"`
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

// wireCompare is a stat's earlier-window comparison. Only its presence matters to lint.
type wireCompare struct {
	Window string `json:"window"`
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
	ID       string        `json:"id"`
	Bindings []wireBinding `json:"bindings"`
}

type wireBinding struct {
	Source    string `json:"source"`
	Variable  string `json:"variable"`
	Parameter string `json:"parameter"`
}

type wireWidgetOption struct {
	ShowStatBar    bool            `json:"showStatBar"`
	ShowSparkline  bool            `json:"showSparkline"`
	StatIcon       string          `json:"statIcon"`
	Compare        *wireCompare    `json:"compare"`
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

// wireWidgetConfig holds the plugin config members that carry colours: series colour rules and the
// value mappings of record-table status badges.
type wireWidgetConfig struct {
	SeriesColors []wireMark        `json:"seriesColors"`
	CellStyles   []wireStyleColors `json:"cellStyles"`
}

// wireStyleColors holds the colour members of one record-table column style: status badge mappings and
// the column's own threshold bands.
type wireStyleColors struct {
	Mappings   []wireMapping   `json:"mappings"`
	Thresholds []wireThreshold `json:"thresholds"`
}

// wireTableConfig holds the record-table column styles the table rules compare. It is decoded on its own, so a
// malformed member here never hides the colour rules, which read wireWidgetConfig. The rank is decoded apart,
// strictly, by tableRankOf, so a rank member of another type (limit 5.0) never hides the column styles.
type wireTableConfig struct {
	CellStyles []wireCellStyle `json:"cellStyles"`
}

// wireRank holds the members of a record-table rank that name its columns, and the options lint checks
// the way the schema does.
type wireRank struct {
	Status string `json:"status"`
	Value  string `json:"value"`
	Order  string `json:"order"`
	Limit  *int   `json:"limit"`
}

// tableRankOf reads a record-table's rank from its config, decoding it strictly as the zod rankSchema does.
// It returns nil with an empty reason when the table declares no rank, and nil with the decode error otherwise.
func tableRankOf(config json.RawMessage) (rank *wireRank, reason string) {
	var table struct {
		Rank json.RawMessage `json:"rank"`
	}
	if len(config) == 0 || json.Unmarshal(config, &table) != nil {
		return nil, ""
	}
	strict, reason := decodeStrictRecordRank(table.Rank)
	if strict == nil {
		return nil, reason
	}
	return &wireRank{Status: strict.Status, Value: strict.Value, Order: strict.Order, Limit: strict.Limit}, ""
}

// wireCellStyle is one record-table column style. Min and Max are pointers so a missing bound is distinct
// from zero; the schema check has already refused a bar without bounds, so lint reads them leniently.
type wireCellStyle struct {
	Column     string          `json:"column"`
	Display    string          `json:"display"`
	Unit       string          `json:"unit"`
	Min        *float64        `json:"min"`
	Max        *float64        `json:"max"`
	Mappings   []wireMapping   `json:"mappings"`
	Thresholds []wireThreshold `json:"thresholds"`
}

// wireMapping is one status-badge mapping. A mapping that names a status keeps its colour as a hue
// override; a colour-only mapping is a bare colour and is checked.
type wireMapping struct {
	Status string `json:"status"`
	Color  string `json:"color"`
}

// decodeLintDocument reads the members lint needs. It reports false when the
// document is not an object of the expected shape; a schema-valid document
// always decodes.
func decodeLintDocument(document Dashboard) (*lintDocument, bool) {
	var wire wireDocument
	if json.Unmarshal(document, &wire) != nil {
		return nil, false
	}
	doc := &lintDocument{variables: make(map[string]bool, len(wire.Variables)), multi: make(map[string]bool, len(wire.Variables)), allowAll: make(map[string]bool, len(wire.Variables))}
	for i := range wire.Variables {
		doc.variables[wire.Variables[i].Name] = true
		doc.multi[wire.Variables[i].Name] = wire.Variables[i].Multi
		doc.allowAll[wire.Variables[i].Name] = wire.Variables[i].Multi && wire.Variables[i].AllowAll
		doc.sourceVariables = append(doc.sourceVariables, lintVariableOf(i, &wire.Variables[i]))
	}
	for i := range wire.Widgets {
		doc.widgets = append(doc.widgets, lintWidgetOf(i, &wire.Widgets[i]))
	}
	if wire.AnnotationSource != nil {
		doc.annotationVariables = variableRefs("/annotationSource/queryRef", wire.AnnotationSource.QueryRef)
	}
	return doc, true
}

// setSLOLintFields copies the config and threshold presence the SLO rules read.
func setSLOLintFields(lw *lintWidget, widget *wireWidget) {
	lw.config = widget.Config
	lw.hasThresholds = widget.Options != nil && len(widget.Options.Thresholds) > 0
}

// lintWidgetOf reads one widget's members for lint. base pointers are rooted at the widget's index.
func lintWidgetOf(i int, widget *wireWidget) lintWidget {
	base := widgetBase(i)
	lw := lintWidget{
		index: i, id: widget.ID, title: widget.Title, widgetType: widget.Type, pluginID: widget.PluginID, providerID: widget.ProviderID,
		description: widget.Description, unit: widget.Unit, query: widget.Query, hasQueryRef: widget.QueryRef != nil,
		x: widget.Layout.X, y: widget.Layout.Y, w: widget.Layout.W, h: widget.Layout.H,
	}
	if widget.Options != nil {
		lw.showBar = widget.Options.ShowStatBar
		lw.showSpark = widget.Options.ShowSparkline
		lw.statIcon = widget.Options.StatIcon
		lw.compares = widget.Options.Compare != nil
		lw.xAxisLabel = widget.Options.XAxisLabel
		lw.yAxisLabel = widget.Options.YAxisLabel
		lw.thresholds = len(widget.Options.Thresholds)
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
	lw.cellStyles = tableCellStylesOf(widget.Config)
	lw.rank, lw.rankErr = tableRankOf(widget.Config)
	lw.statusBands = widget.Options != nil && hasDeclaredRankThreshold(widget.Options.Thresholds)
	setSLOLintFields(&lw, widget)
	return lw
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
		fields = append(fields, mappingColorFields(base, config.CellStyles)...)
	}
	return fields
}

// tableCellStylesOf reads a record-table's column styles from its config. A config that does not decode
// has no styles to compare, as an unreadable colour config has no colours to check.
func tableCellStylesOf(config json.RawMessage) []wireCellStyle {
	var table wireTableConfig
	if len(config) == 0 || json.Unmarshal(config, &table) != nil {
		return nil
	}
	return table.CellStyles
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

// mappingColorFields lists the status-badge mappings that carry a colour but no status.
func mappingColorFields(base string, styles []wireStyleColors) []colorField {
	var fields []colorField
	for k, style := range styles {
		for m, mapping := range style.Mappings {
			if mapping.Status == "" && mapping.Color != "" {
				fields = append(fields, colorField{pointer: base + "/config/cellStyles/" + strconv.Itoa(k) + "/mappings/" + strconv.Itoa(m) + "/color", what: "status badge colour", hex: mapping.Color})
			}
		}
		// A column's own bands colour cells exactly as the widget's thresholds do, so they get the same check.
		for t, threshold := range style.Thresholds {
			if threshold.Status == "" && threshold.Color != "" {
				fields = append(fields, colorField{pointer: base + "/config/cellStyles/" + strconv.Itoa(k) + "/thresholds/" + strconv.Itoa(t) + "/color", what: "column threshold colour", hex: threshold.Color})
			}
		}
	}
	return fields
}

// seriesRuleColorFields lists the bare colours in a plugin config's series colour rules.
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
			refs = append(refs, lintVariableRef{pointer: base + "/bindings/" + strconv.Itoa(k) + "/variable", variable: binding.Variable, queryRefID: ref.ID, parameter: binding.Parameter})
		}
	}
	return refs
}

// overlapRuleID is the rule a stored overlap is grandfathered under.
const overlapRuleID = "layout.overlap"

// lintFindings runs every rule over a schema-valid document and returns every
// finding, errors first. It is the full list the tests and the lint command read.
func lintFindings(document Dashboard) []*insightsv1.CheckFinding {
	set := newFindingSet(unboundedFindings)
	lintInto(set, document, nil, nil)
	return set.findings()
}

// lintInto runs every rule over a schema-valid document and adds its findings to
// set. Findings are added errors first, then warnings, then info, and in rule and
// hit order within each severity, so the same document always reports the same
// list. known names the widget pairs a stored dashboard already overlapped: those
// overlaps are warnings, not errors. providerTypes is the resolved provider types
// (see lintDocument). A document the schema rejects is not read.
func lintInto(set *findingSet, document Dashboard, known map[overlapKey]bool, providerTypes map[string]string) {
	doc, ok := decodeLintDocument(document)
	if !ok {
		return
	}
	doc.providerTypes = providerTypes
	// Each rule runs once; its hits are sorted into severity groups in rule order.
	bySeverity := map[insightsv1.Severity][]*insightsv1.CheckFinding{}
	for _, rule := range lintRules {
		hits := rule.check(doc)
		for i := range hits {
			hit := &hits[i]
			finding := lintFinding(rule, hit)
			finding.Severity = hitSeverity(rule, hit, known)
			bySeverity[finding.Severity] = append(bySeverity[finding.Severity], finding)
		}
	}
	for _, severity := range []insightsv1.Severity{errorSeverity, warningSeverity, infoSeverity} {
		for _, finding := range bySeverity[severity] {
			set.add(finding)
		}
	}
}

// hitSeverity is the severity a rule's hit is reported at. A layout overlap between
// a pair the stored dashboard already had is a warning, so a harmless edit that
// leaves it in place is saved.
func hitSeverity(rule lintRule, hit *lintHit, known map[overlapKey]bool) insightsv1.Severity {
	if rule.ID == overlapRuleID && known[hit.pair] {
		return warningSeverity
	}
	return rule.Severity
}

// storedOverlaps names the widget pairs that overlap in a stored dashboard. A save
// that leaves one of those pairs overlapping is not blocked. A create has no stored
// dashboard, so it has no such pairs.
func storedOverlaps(stored Dashboard) map[overlapKey]bool {
	if stored == nil {
		return nil
	}
	doc, ok := decodeLintDocument(stored)
	if !ok {
		return nil
	}
	known := map[overlapKey]bool{}
	for _, pair := range overlapPairs(doc) {
		known[pair.key] = true
	}
	return known
}

func lintFinding(rule lintRule, hit *lintHit) *insightsv1.CheckFinding {
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

// saveFindings is what a save and a dry run report for a document at the path
// id, as a full list. Schema findings come first. Lint only reads a document that
// passed the schema, so it runs only then.
func saveFindings(id string, document Dashboard) []*insightsv1.CheckFinding {
	return saveReport(id, document, nil, unboundedFindings, nil).findings()
}

// saveReport is what a save, or a dry run, reports for a document at the path id.
// stored is the dashboard the save would replace, or nil for a create. Schema
// findings come first, and lint reads only a document that passed the schema.
// keep bounds the widget findings the set materialises; the counts stay exact.
// providerTypes resolves the provider types the rules may read. It is called only after the schema passes, so the
// lint rules never read a rejected document. A save resolves its providers before it takes the mutation lock (see
// saveDashboard), so a rejected save can still have cost the bounded lookups. Nil means no provider is resolved;
// see providerTypesOf.
func saveReport(id string, document, stored Dashboard, keep int, providerTypes func() map[string]string) *findingSet {
	set := newFindingSet(keep)
	schemaInto(set, id, document)
	if set.total == 0 {
		var types map[string]string
		if providerTypes != nil {
			types = providerTypes()
		}
		lintInto(set, document, storedOverlaps(stored), types)
	}
	return set
}

// checkReport is the report of a dry run or a checked save at the path the document
// names. It reads the stored dashboard at that path, so an overlap the stored
// version already has is reported the way the save reports it.
func (s *Server) checkReport(r *http.Request, document Dashboard) *findingSet {
	id := dryRunID(document)
	return saveReport(id, document, s.storedDashboard(id), checkwire.MaxIssues, func() map[string]string { return s.providerTypesBounded(r, document) })
}

// storedDashboard returns the dashboard a save at id would replace, or nil when
// there is none or the id is not a valid dashboard id.
func (s *Server) storedDashboard(id string) Dashboard {
	if !validID.MatchString(id) {
		return nil
	}
	document, _, err := s.store.Get(id)
	if err != nil {
		return nil
	}
	return document
}

// CheckDocument reports every finding for a document at its own id, the same
// findings a dry run reports. The paprika-insights lint command uses it.
func CheckDocument(document Dashboard) []*insightsv1.CheckFinding {
	return saveFindings(dryRunID(document), document)
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
