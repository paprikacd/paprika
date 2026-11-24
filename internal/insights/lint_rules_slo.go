package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// sloProviderLookupTimeout bounds the provider lookup a save makes before it takes the mutation lock. A slow
// catalog call then costs the save its provider type, which the rule reads as unknown, and never holds other saves.
const sloProviderLookupTimeout = 2 * time.Second

// guidanceSLO is the line of dashboardComposition that the SLO rules map to. It is also a line of
// internal/insights/guidance; TestLintSummariesAreComposed fails when it is missing there.
const guidanceSLO = "An slo-summary widget runs the query compiled from its objective config: it takes no queryRef and no options.thresholds, and its query text is editor output that is ignored at run time."

// sloLintRules cover the slo-summary widget. Its objective config is the source of the query, so a
// saved query reference or band thresholds would describe a different objective from the one that runs.
var sloLintRules = []lintRule{
	{
		ID:       "slo.provider-type",
		Severity: errorSeverity,
		Summary:  guidanceSLO,
		Fix:      "Point the slo-summary widget at a Prometheus provider; its query is PromQL compiled from config.",
		check:    checkSLOProviderType,
	},
	{
		ID:       "slo.group-unbounded",
		Severity: warningSeverity,
		Summary:  guidanceSLO,
		Fix:      "Add a matcher on the groupBy label to the total selector, such as service=~\"a|b\", so the groups are bounded.",
		check:    checkSLOGroupUnbounded,
	},
	{
		ID:       "slo.query-ref",
		Severity: errorSeverity,
		Summary:  guidanceSLO,
		Fix:      "Remove queryRef from the slo-summary widget; its query is compiled from config.",
		check:    checkSLOQueryRef,
	},
	{
		ID:       "slo.thresholds-ignored",
		Severity: warningSeverity,
		Summary:  guidanceSLO,
		Fix:      "Remove options.thresholds from the slo-summary widget; its status comes from the objective.",
		check:    checkSLOThresholds,
	},
	{
		ID:       "slo.query-stale",
		Severity: infoSeverity,
		Summary:  guidanceSLO,
		Fix:      "Replace the widget query with the text compiled from its config, or re-edit the widget in the editor so it regenerates.",
		check:    checkSLOQueryStale,
	},
}

// sloWidgets returns the slo-summary widgets of a document, in document order.
func sloWidgets(doc *lintDocument) []*lintWidget {
	var widgets []*lintWidget
	for i := range doc.widgets {
		if doc.widgets[i].widgetType == "plugin" && doc.widgets[i].pluginID == sloSummaryPluginID {
			widgets = append(widgets, &doc.widgets[i])
		}
	}
	return widgets
}

// providerTypesOf resolves the provider of each slo-summary widget in a document, so the provider-type rule
// can read its type. An id that does not resolve is left out of the map, which the rule reads as unknown and
// does not fire on. Only slo-summary widgets are resolved, so other documents cost nothing here.
func (s *Server) providerTypesOf(r *http.Request, document Dashboard) map[string]string {
	// A document without an slo-summary widget or a label-values variable source has no provider to resolve, so it is not decoded.
	if !bytes.Contains(document, []byte(sloSummaryPluginID)) && !bytes.Contains(document, []byte(`"labelValues"`)) && !bytes.Contains(document, []byte(`"savedQuery"`)) && !bytes.Contains(document, []byte(`"queryRef"`)) {
		return nil
	}
	doc, ok := decodeLintDocument(document)
	if !ok {
		return nil
	}
	types := s.resolveProviderTypes(r, lintProviderIDs(doc))
	for id, kind := range s.resolveSavedQueryKinds(lintSavedQueryIDs(doc)) {
		if types == nil {
			types = map[string]string{}
		}
		types[savedQueryKindKey(id)] = kind
	}
	for key, flag := range s.resolveSavedQueryParameterKinds(lintSavedQueryIDs(doc)) {
		if types == nil {
			types = map[string]string{}
		}
		types[key] = flag
	}
	return types
}

// lintProviderIDs lists the provider ids a document's rules read, in document order, with repeats.
// At most maxDashboardWidgets slo-summary widgets are listed. A valid document has no more, and a document the schema
// later rejects cannot make the save look up more providers than a valid one could. A valid document declares at most
// 20 variables, so each label-values source adds at most one lookup.
func lintProviderIDs(doc *lintDocument) []string {
	var ids []string
	for n, widget := range sloWidgets(doc) {
		if n == maxDashboardWidgets {
			break
		}
		ids = append(ids, widget.providerID)
	}
	for i := range doc.sourceVariables {
		if doc.sourceVariables[i].sourceType == "labelValues" {
			ids = append(ids, doc.sourceVariables[i].providerID)
		}
	}
	return ids
}

// lintSavedQueryIDs lists the saved queries a savedQuery variable source reads.
func lintSavedQueryIDs(doc *lintDocument) []string {
	var ids []string
	for i := range doc.sourceVariables {
		if doc.sourceVariables[i].sourceType == "savedQuery" && doc.sourceVariables[i].queryRefID != "" {
			ids = append(ids, doc.sourceVariables[i].queryRefID)
		}
	}
	return ids
}

// resolveSavedQueryKinds maps each stored saved query id to its kind. An id that is not stored is left out.
func (s *Server) resolveSavedQueryKinds(ids []string) map[string]string {
	var kinds map[string]string
	for _, id := range ids {
		document, _, err := s.savedQueries.get(id)
		if err != nil {
			continue
		}
		var stored struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(document, &stored) != nil {
			continue
		}
		if kinds == nil {
			kinds = map[string]string{}
		}
		kinds[id] = stored.Kind
	}
	return kinds
}

// resolveProviderTypes maps each resolvable provider id to its type. An empty or unresolvable id is left out.
func (s *Server) resolveProviderTypes(r *http.Request, ids []string) map[string]string {
	var types map[string]string
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, seen := types[id]; seen {
			continue
		}
		provider, err := s.resolveProvider(r, id)
		if err != nil {
			continue
		}
		if types == nil {
			types = map[string]string{}
		}
		types[id] = provider.public.Type
	}
	return types
}

// providerTypesBounded is providerTypesOf under sloProviderLookupTimeout. A lookup that runs past the bound reads
// as unknown providers, so the rule stays quiet rather than the save waiting on the catalog.
func (s *Server) providerTypesBounded(r *http.Request, document Dashboard) map[string]string {
	ctx, cancel := context.WithTimeout(r.Context(), sloProviderLookupTimeout)
	defer cancel()
	return s.providerTypesOf(r.WithContext(ctx), document)
}

// checkSLOProviderType fires for an slo-summary widget whose provider is known to be a type other than
// prometheus. Its query is PromQL, so another type would fail at run time. An unknown provider is not reported here.
func checkSLOProviderType(doc *lintDocument) []lintHit {
	var hits []lintHit
	for _, widget := range sloWidgets(doc) {
		providerType, known := doc.providerTypes[widget.providerID]
		if !known || providerType == "prometheus" {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/providerId",
			widgetID: widget.id,
			message:  widgetLabel(widget) + " is an SLO summary on a " + providerType + " provider; an SLO summary needs a Prometheus provider",
		})
	}
	return hits
}

// checkSLOGroupUnbounded fires for a groupBy objective whose total selector has no matcher that bounds the grouping
// label. Such a selector returns every series of the metric, so the groups are not bounded by the author and can exceed
// the provider's series limit. A config that does not validate is reported by the schema check, not here.
func checkSLOGroupUnbounded(doc *lintDocument) []lintHit {
	var hits []lintHit
	for _, widget := range sloWidgets(doc) {
		cfg, err := validateSLOSummaryConfig(widget.config)
		if err != nil || cfg.GroupBy == "" {
			continue
		}
		if selectorBoundsLabel(cfg.Total, cfg.GroupBy) {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/config/total",
			widgetID: widget.id,
			message:  widgetLabel(widget) + " groups by " + cfg.GroupBy + " but its total selector has no matcher on " + cfg.GroupBy + ", so its groups are not bounded",
		})
	}
	return hits
}

// selectorBoundsLabel reports whether a PromQL selector has a matcher on label that bounds the series: an = or =~
// matcher whose value is not empty and not a match-all pattern (.* or .+). Only matchers inside braces count, and a
// quoted value is read as a value, so text such as service= inside another label's value never bounds the label.
func selectorBoundsLabel(selector, label string) bool {
	inBraces := false
	for i := 0; i < len(selector); {
		c := selector[i]
		switch {
		case isQuote(c):
			i = quotedEnd(selector, i)
		case c == '{' || c == '}':
			inBraces = c == '{'
			i++
		case inBraces && isLabelNameStart(c):
			m, next := readMatcher(selector, i)
			if m.bounds(label) {
				return true
			}
			i = next
		default:
			i++
		}
	}
	return false
}

// labelMatcher is one matcher of a selector. Templated marks an unquoted {{placeholder}} value, which the dashboard fills in.
type labelMatcher struct {
	name, op, value string
	templated       bool
}

// bounds reports whether the matcher bounds label: an = or =~ on it that is not empty, a match-all pattern or a placeholder.
func (m labelMatcher) bounds(label string) bool {
	if m.name != label || (m.op != "=" && m.op != "=~") {
		return false
	}
	if m.templated {
		return true
	}
	return m.value != "" && m.value != ".*" && m.value != ".+"
}

// readMatcher reads the label matcher that starts at i and returns it with the index after it. The name is empty
// when the text at i is not followed by an operator, and the caller then moves past the name.
func readMatcher(selector string, i int) (m labelMatcher, next int) {
	end := i
	for end < len(selector) && isLabelNameChar(selector[end]) {
		end++
	}
	op, after := matcherOp(selector, skipBlanks(selector, end))
	if op == "" {
		return labelMatcher{}, end
	}
	m = labelMatcher{name: selector[i:end], op: op}
	next = skipBlanks(selector, after)
	switch {
	case strings.HasPrefix(selector[next:], "{{"):
		closing := strings.Index(selector[next:], "}}")
		if closing < 0 {
			return m, len(selector)
		}
		m.templated = true
		return m, next + closing + 2
	case next < len(selector) && isQuote(selector[next]):
		valueEnd := quotedEnd(selector, next)
		m.value = selector[next+1 : max(next+1, valueEnd-1)]
		return m, valueEnd
	default:
		return m, next
	}
}

// quotedEnd returns the index just past the quoted string that opens at start. A backslash escapes the next byte.
// An unterminated string runs to the end of the selector.
func quotedEnd(selector string, start int) int {
	quote := selector[start]
	for i := start + 1; i < len(selector); i++ {
		switch selector[i] {
		case '\\':
			i++
		case quote:
			return i + 1
		}
	}
	return len(selector)
}

// matcherOp reads a PromQL matcher operator at i. It returns the operator and the index after it, or "" when none starts there.
func matcherOp(selector string, i int) (op string, next int) {
	for _, candidate := range []string{"=~", "!~", "!=", "="} {
		if strings.HasPrefix(selector[i:], candidate) {
			return candidate, i + len(candidate)
		}
	}
	return "", i
}

func skipBlanks(selector string, i int) int {
	for i < len(selector) && (selector[i] == ' ' || selector[i] == '\t' || selector[i] == '\n' || selector[i] == '\r') {
		i++
	}
	return i
}

func isQuote(c byte) bool {
	return c == '"' || c == '\'' || c == '`'
}

func isLabelNameStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isLabelNameChar(c byte) bool {
	return isLabelNameStart(c) || (c >= '0' && c <= '9')
}

// checkSLOQueryRef fires for an slo-summary widget that takes its query from a saved query.
func checkSLOQueryRef(doc *lintDocument) []lintHit {
	var hits []lintHit
	for _, widget := range sloWidgets(doc) {
		if widget.hasQueryRef {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/queryRef",
				widgetID: widget.id,
				message:  widgetLabel(widget) + " is an SLO summary and takes its query from config, not from a saved query",
			})
		}
	}
	return hits
}

// checkSLOThresholds fires for an slo-summary widget that declares bands. Its status is set by the
// objective, so the thresholds have no effect.
func checkSLOThresholds(doc *lintDocument) []lintHit {
	var hits []lintHit
	for _, widget := range sloWidgets(doc) {
		if widget.hasThresholds {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/thresholds",
				widgetID: widget.id,
				message:  widgetLabel(widget) + " declares thresholds, which an SLO summary ignores; its status comes from the objective",
			})
		}
	}
	return hits
}

// checkSLOQueryStale fires for an slo-summary widget whose stored query is not the text compiled from its
// config. The compiled text is what runs, so the stored copy only misleads a reader. A config that does not
// compile is reported by the schema check, not here.
func checkSLOQueryStale(doc *lintDocument) []lintHit {
	var hits []lintHit
	for _, widget := range sloWidgets(doc) {
		cfg, err := validateSLOSummaryConfig(widget.config)
		if err != nil {
			continue
		}
		compiled, err := compileSLOQuery(&cfg)
		if err != nil || widget.query == compiled {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/query",
			widgetID: widget.id,
			message:  widgetLabel(widget) + " has a query that differs from its compiled objective; the compiled query is what runs",
		})
	}
	return hits
}
