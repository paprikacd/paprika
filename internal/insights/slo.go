package insights

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
)

// This file ports ui/src/features/insights/slo.ts. Both implementations run the shared cases in
// docs/design/insights/conformance/slo.json, so they cannot silently diverge. Errors carry the
// same codes as the UI: the error message is the code.

const (
	sloCodeInvalidConfig   = "invalid_config"
	sloCodeUnknownKey      = "unknown_key"
	sloCodeInvalidObjects  = "invalid_objective"
	sloCodeInvalidPeriod   = "invalid_period"
	sloCodeInvalidSelector = "invalid_selector"
	sloCodeGoodBadExcl     = "good_bad_exclusive"
	sloCodeInvalidBurn     = "invalid_burn_alerts"
	sloCodeInvalidGroupBy  = "invalid_group_by"
	sloCodeInvalidMaxRows  = "invalid_max_rows"
	sloCodeQueryTooLong    = "query_too_long"

	sloDefaultMaxRows = 6
	sloMaxRowsLimit   = 12
	// sloProviderSeriesLimit is the most series a provider returns (providers.go maxSeries). Each group runs two series per window.
	sloProviderSeriesLimit = 100
	sloMaxQueryLength      = 8192
	sloMinObjective        = 50.0
	sloMaxObjective        = 99.9999
	sloBurnMultiwindow     = "multiwindow"
	sloBurnPage            = "page"
	sloBurnNone            = "none"
	sloStepFloorSeconds    = 60.0

	// sloSummaryPluginID is the built-in plugin id of the SLO summary widget.
	sloSummaryPluginID = "slo-summary"
)

// sloConfig is the authored objective. Bad or Good is set, never both. Zero BurnAlerts and MaxRows take
// their defaults.
type sloConfig struct {
	Objective  float64 `json:"objective"`
	Period     string  `json:"period"`
	Total      string  `json:"total"`
	Bad        string  `json:"bad,omitempty"`
	Good       string  `json:"good,omitempty"`
	BurnAlerts string  `json:"burnAlerts,omitempty"`
	GroupBy    string  `json:"groupBy,omitempty"`
	MaxRows    int     `json:"maxRows,omitempty"`
}

// sloEvaluation is the evaluation of one widget's objective over its result. Later slices wrap it in
// the query_dashboard output.
type sloEvaluation struct {
	State         string     `json:"state"`
	Reasons       []string   `json:"reasons"`
	Counts        sloCounts  `json:"counts"`
	Groups        []sloGroup `json:"groups"`
	GroupsOmitted int        `json:"groupsOmitted"`
}

type sloCounts struct {
	Meeting   int `json:"meeting"`
	AtRisk    int `json:"at_risk"` //nolint:tagliatelle // The state name is at_risk on the wire, as in slo.ts.
	Breaching int `json:"breaching"`
	Unknown   int `json:"unknown"`
}

type sloGroup struct {
	Labels          map[string]string `json:"labels"`
	State           string            `json:"state"`
	Reasons         []string          `json:"reasons"`
	Availability    *float64          `json:"availability"`
	ErrorRatio      *float64          `json:"errorRatio"`
	BudgetRemaining *float64          `json:"budgetRemaining"`
	Total           *float64          `json:"total"`
	Bad             *float64          `json:"bad"`
	Allowed         *float64          `json:"allowed"`
	Burn            []sloBurn         `json:"burn"`
}

type sloBurn struct {
	Long      string   `json:"long"`
	Short     string   `json:"short"`
	Factor    float64  `json:"factor"`
	Severity  string   `json:"severity"`
	LongBurn  *float64 `json:"longBurn"`
	ShortBurn *float64 `json:"shortBurn"`
	Firing    bool     `json:"firing"`
}

type sloPair struct {
	long, short string
	spent       float64
	severity    string
	page        bool
}

// sloBurnPairs are the SRE-workbook multiwindow pairs, critical first. The factor a pair reaches is
// spent * period / long, so it scales to the period.
var sloBurnPairs = []sloPair{
	{long: "1h", short: "5m", spent: 0.02, severity: "critical", page: true},
	{long: "6h", short: "30m", spent: 0.05, severity: "critical", page: true},
	{long: "1d", short: "2h", spent: 0.1, severity: "warning", page: false},
	{long: "3d", short: "6h", spent: 0.1, severity: "warning", page: false},
}

var sloWindowSeconds = map[string]float64{"5m": 300, "30m": 1800, "1h": 3600, "2h": 7200, "6h": 21600, "1d": 86400, "3d": 259200}
var sloPeriodSeconds = map[string]float64{"1d": 86400, "7d": 604800, "28d": 2419200, "30d": 2592000}

var (
	sloLabelName   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	sloPlaceholder = regexp.MustCompile(`\{\{[A-Za-z_][A-Za-z0-9_]*\}\}`)
	// Keep this pattern identical to SELECTOR in slo.ts.
	sloSelector = regexp.MustCompile(`^[A-Za-z_:][A-Za-z0-9_:]*(\{ *([A-Za-z_][A-Za-z0-9_]* *(=|!=|=~|!~) *"(?:[^"\\]|\\.)*" *(, *[A-Za-z_][A-Za-z0-9_]* *(=|!=|=~|!~) *"(?:[^"\\]|\\.)*" *)*,? *)?\})?$`)
)

// sloStateRank orders groups: evaluated groups worst first, then meeting, then unknown groups last.
var sloStateRank = map[string]int{"breaching": 0, "at_risk": 1, "meeting": 2, "unknown": 3}
var sloReasonOrder = []string{"budget_exhausted", "fast_burn", "slow_burn", "no_traffic", "no_data", "incomplete"}

// isSLOSummaryWidget reports whether a widget is a slo-summary plugin widget.
func isSLOSummaryWidget(widget *dashboardReadWidget) bool {
	return widget.Type == "plugin" && widget.PluginID == sloSummaryPluginID
}

func isSLOSelector(raw string) bool {
	return sloSelector.MatchString(sloPlaceholder.ReplaceAllString(raw, `"x"`))
}

// validateSLOSummaryConfig decodes and validates an authored config. It applies the same checks, in the same
// order, as validateSloConfig in slo.ts. The error message is the code.
func validateSLOSummaryConfig(raw json.RawMessage) (sloConfig, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return sloConfig{}, errors.New(sloCodeInvalidConfig)
	}
	if code := sloUnknownKeyCode(fields); code != "" {
		return sloConfig{}, errors.New(code)
	}
	var cfg sloConfig
	if code := sloRequiredCode(fields, &cfg); code != "" {
		return sloConfig{}, errors.New(code)
	}
	if code := sloOptionalCode(fields, &cfg); code != "" {
		return sloConfig{}, errors.New(code)
	}
	return cfg, nil
}

var sloAllowedKeys = map[string]bool{"objective": true, "period": true, "total": true, "bad": true, "good": true, "burnAlerts": true, "groupBy": true, "maxRows": true}

// sloUnknownKeyCode returns unknown_key for the first key, in sorted order, that the config does not allow.
func sloUnknownKeyCode(fields map[string]json.RawMessage) string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !sloAllowedKeys[key] {
			return sloCodeUnknownKey
		}
	}
	return ""
}

// sloRequiredCode checks the objective, period, total and the single bad or good selector.
func sloRequiredCode(fields map[string]json.RawMessage, cfg *sloConfig) string {
	if !sloObjectiveOK(fields, cfg) {
		return sloCodeInvalidObjects
	}
	if !decodesAs(fields, "period", &cfg.Period) {
		return sloCodeInvalidPeriod
	}
	if _, ok := sloPeriodSeconds[cfg.Period]; !ok {
		return sloCodeInvalidPeriod
	}
	if !decodesAs(fields, "total", &cfg.Total) || !isSLOSelector(cfg.Total) {
		return sloCodeInvalidSelector
	}
	return sloSelectorCode(fields, cfg)
}

// sloObjectiveOK reports whether the objective is a finite percent in range with at most four decimals.
func sloObjectiveOK(fields map[string]json.RawMessage, cfg *sloConfig) bool {
	return decodesAs(fields, "objective", &cfg.Objective) && finiteNumber(cfg.Objective) &&
		cfg.Objective >= sloMinObjective && cfg.Objective <= sloMaxObjective &&
		math.Abs(cfg.Objective*10000-math.Round(cfg.Objective*10000)) <= 1e-6
}

// sloSelectorCode requires exactly one of bad or good, and that it is a selector.
func sloSelectorCode(fields map[string]json.RawMessage, cfg *sloConfig) string {
	_, hasBad := fields["bad"]
	_, hasGood := fields["good"]
	switch {
	case hasBad == hasGood:
		return sloCodeGoodBadExcl
	case hasBad && (!decodesAs(fields, "bad", &cfg.Bad) || !isSLOSelector(cfg.Bad)):
		return sloCodeInvalidSelector
	case hasGood && (!decodesAs(fields, "good", &cfg.Good) || !isSLOSelector(cfg.Good)):
		return sloCodeInvalidSelector
	}
	return ""
}

// sloOptionalCode checks the fields that may be absent: burnAlerts, groupBy and maxRows.
func sloOptionalCode(fields map[string]json.RawMessage, cfg *sloConfig) string {
	if _, present := fields["burnAlerts"]; present && !sloBurnAlertsOK(fields, cfg) {
		return sloCodeInvalidBurn
	}
	if _, present := fields["groupBy"]; present && !sloGroupByOK(fields, cfg) {
		return sloCodeInvalidGroupBy
	}
	if _, present := fields["maxRows"]; present && !sloMaxRowsOK(fields, cfg) {
		return sloCodeInvalidMaxRows
	}
	return ""
}

func sloBurnAlertsOK(fields map[string]json.RawMessage, cfg *sloConfig) bool {
	return decodesAs(fields, "burnAlerts", &cfg.BurnAlerts) &&
		(cfg.BurnAlerts == sloBurnMultiwindow || cfg.BurnAlerts == sloBurnPage || cfg.BurnAlerts == sloBurnNone)
}

func sloGroupByOK(fields map[string]json.RawMessage, cfg *sloConfig) bool {
	return decodesAs(fields, "groupBy", &cfg.GroupBy) && sloLabelName.MatchString(cfg.GroupBy) &&
		cfg.GroupBy != "slo_window" && cfg.GroupBy != "slo_part"
}

func sloMaxRowsOK(fields map[string]json.RawMessage, cfg *sloConfig) bool {
	return decodesAs(fields, "maxRows", &cfg.MaxRows) && cfg.MaxRows >= 1 && cfg.MaxRows <= sloMaxRowsCap(cfg)
}

// sloMaxRowsCap is the most groups a config may list. It mirrors sloMaxRowsLimit in slo.ts: the provider
// returns 100 series, each group runs two per window, and the result is capped at 12 groups.
func sloMaxRowsCap(cfg *sloConfig) int {
	return min(sloMaxRowsLimit, sloProviderSeriesLimit/(2*len(sloWindowsOf(cfg))))
}

// decodesAs reports whether the field is present and decodes into dst. A JSON null decodes to the zero value,
// which the range and selector checks then reject, as the UI's typeof checks do.
func decodesAs(fields map[string]json.RawMessage, key string, dst any) bool {
	raw, ok := fields[key]
	return ok && json.Unmarshal(raw, dst) == nil
}

func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func sloBurnAlertsOf(cfg *sloConfig) string {
	if cfg.BurnAlerts == "" {
		return sloBurnMultiwindow
	}
	return cfg.BurnAlerts
}

func sloMaxRowsOf(cfg *sloConfig) int {
	if cfg.MaxRows == 0 {
		return sloDefaultMaxRows
	}
	return cfg.MaxRows
}

// sloKeptPairs returns the preset's pairs whose long window is shorter than the period.
func sloKeptPairs(cfg *sloConfig) []sloPair {
	alerts := sloBurnAlertsOf(cfg)
	if alerts == sloBurnNone {
		return nil
	}
	period := sloPeriodSeconds[cfg.Period]
	kept := make([]sloPair, 0, len(sloBurnPairs))
	for _, pair := range sloBurnPairs {
		if alerts == sloBurnPage && !pair.page {
			continue
		}
		if sloWindowSeconds[pair.long] < period {
			kept = append(kept, pair)
		}
	}
	return kept
}

// sloWindowsOf returns the burn windows of the kept pairs in ascending order, then the period window.
func sloWindowsOf(cfg *sloConfig) []string {
	seen := map[string]bool{}
	windows := []string{}
	for _, pair := range sloKeptPairs(cfg) {
		for _, window := range []string{pair.long, pair.short} {
			if !seen[window] {
				seen[window] = true
				windows = append(windows, window)
			}
		}
	}
	sort.Slice(windows, func(i, j int) bool { return sloWindowSeconds[windows[i]] < sloWindowSeconds[windows[j]] })
	return append(windows, cfg.Period)
}

// compileSLOQuery returns the PromQL the widget runs. It must produce the same text as compileSloQuery in slo.ts.
func compileSLOQuery(cfg *sloConfig) (string, error) {
	aggregate := func(inner string) string {
		if cfg.GroupBy != "" {
			return "sum by (" + cfg.GroupBy + ")(" + inner + ")"
		}
		return "sum(" + inner + ")"
	}
	relabel := func(expression, part, window string) string {
		return `label_replace(label_replace(` + expression + `, "slo_part", "` + part + `", "", ""), "slo_window", "` + window + `", "", "")`
	}

	parts := make([]string, 0, 2*len(sloWindowsOf(cfg)))
	for _, window := range sloWindowsOf(cfg) {
		total := aggregate("increase(" + cfg.Total + "[" + window + "])")
		parts = append(parts, relabel(total, "total", window))
		var bad string
		if cfg.Bad != "" {
			bad = "(" + aggregate("increase("+cfg.Bad+"["+window+"])") + " or (0 * " + total + "))"
		} else {
			bad = "clamp_min(" + total + " - (" + aggregate("increase("+cfg.Good+"["+window+"])") + " or (0 * " + total + ")), 0)"
		}
		parts = append(parts, relabel(bad, "bad", window))
	}
	query := strings.Join(parts, " or ")
	if len(query) > sloMaxQueryLength {
		return "", errors.New(sloCodeQueryTooLong)
	}
	return query, nil
}

// sloStepSeconds is the query step in seconds: the range, with a floor of 60 seconds.
func sloStepSeconds(start, end float64) float64 {
	return math.Max(sloStepFloorSeconds, end-start)
}

// sloEvaluationTimestamp is the newest timestamp any series reports: the range end the windows were evaluated at.
// It mirrors evaluationTimestamp in slo.ts.
func sloEvaluationTimestamp(result *QueryResult) (float64, bool) {
	if result == nil {
		return 0, false
	}
	var newest float64
	found := false
	for _, series := range result.Series {
		for _, point := range series.Points {
			if !found || point.Timestamp > newest {
				newest, found = point.Timestamp, true
			}
		}
	}
	return newest, found
}

// sloValueAt returns the finite sample at the evaluation timestamp. A window with no sample there has no reading.
// It mirrors valueAt in slo.ts.
func sloValueAt(points []Point, at float64) (float64, bool) {
	for _, point := range points {
		if point.Timestamp == at && point.Value != nil && finiteNumber(*point.Value) {
			return *point.Value, true
		}
	}
	return 0, false
}

type sloReadings struct {
	labels map[string]string
	values map[string]float64
}

// sloReadGroups groups the series by labels other than the SLO labels, keeping each window's latest reading.
func sloReadGroups(result *QueryResult, windows []string) (groups map[string]*sloReadings, order []string) {
	groups = map[string]*sloReadings{}
	order = []string{}
	at, ok := sloEvaluationTimestamp(result)
	if !ok {
		return groups, order
	}
	known := map[string]bool{}
	for _, window := range windows {
		known[window] = true
	}
	for _, series := range result.Series {
		window, part := series.Labels["slo_window"], series.Labels["slo_part"]
		if !known[window] || (part != "total" && part != "bad") {
			continue
		}
		labels := sloGroupLabels(series.Labels)
		key := sloLabelsKey(labels)
		group, ok := groups[key]
		if !ok {
			group = &sloReadings{labels: labels, values: map[string]float64{}}
			groups[key] = group
			order = append(order, key)
		}
		sloRecordReading(group, window+"|"+part, series.Points, at)
	}
	return groups, order
}

// sloGroupLabels returns the labels that identify a group: every label except the SLO labels.
func sloGroupLabels(all map[string]string) map[string]string {
	labels := make(map[string]string, len(all))
	for key, value := range all {
		if key != "slo_window" && key != "slo_part" {
			labels[key] = value
		}
	}
	return labels
}

// sloRecordReading keeps the first series' reading at the evaluation timestamp for a window and part.
func sloRecordReading(group *sloReadings, slot string, points []Point, at float64) {
	if _, seen := group.values[slot]; seen {
		return
	}
	if value, ok := sloValueAt(points, at); ok {
		group.values[slot] = value
	}
}

// sloLabelsKey is a stable key for a label set: sorted name=value pairs.
func sloLabelsKey(labels map[string]string) string {
	names := make([]string, 0, len(labels))
	for name := range labels {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		b.WriteString(name)
		b.WriteByte(0)
		b.WriteString(labels[name])
		b.WriteByte(0)
	}
	return b.String()
}

func sloPtr(value float64) *float64 {
	return &value
}

func sloUnknownGroup(labels map[string]string, reason string, total, bad *float64, burn []sloBurn) sloGroup {
	return sloGroup{Labels: labels, State: "unknown", Reasons: []string{reason}, Total: total, Bad: bad, Burn: burn}
}

// evaluateSLO evaluates the windows of a result against the objective. It mirrors evaluateSlo in slo.ts.
func evaluateSLO(cfg *sloConfig, result *QueryResult) sloEvaluation {
	truncated := result != nil && result.Truncated
	groupMap, order := sloReadGroups(result, sloWindowsOf(cfg))

	groups := make([]sloGroup, 0, len(order))
	for _, key := range order {
		groups = append(groups, sloEvaluateGroup(cfg, groupMap[key], truncated))
	}
	sort.SliceStable(groups, func(i, j int) bool { return sloGroupBefore(&groups[i], &groups[j]) })

	evaluation := sloEvaluation{Reasons: []string{}, Groups: groups}
	for _, group := range groups {
		switch group.State {
		case "meeting":
			evaluation.Counts.Meeting++
		case "at_risk":
			evaluation.Counts.AtRisk++
		case "breaching":
			evaluation.Counts.Breaching++
		default:
			evaluation.Counts.Unknown++
		}
	}
	if maxRows := sloMaxRowsOf(cfg); len(groups) > maxRows {
		evaluation.Groups = groups[:maxRows]
		evaluation.GroupsOmitted = len(groups) - maxRows
	}
	evaluation.State, evaluation.Reasons = sloOverall(groups, truncated, cfg.GroupBy != "")
	return evaluation
}

// sloEvaluateGroup evaluates one group. A group with no period traffic, no period data or no bad series is
// unknown, not meeting. A truncated result cannot prove meeting, so meeting becomes unknown.
func sloEvaluateGroup(cfg *sloConfig, readings *sloReadings, truncated bool) sloGroup {
	pairs := sloKeptPairs(cfg)
	burn := make([]sloBurn, 0, len(pairs))
	for _, pair := range pairs {
		burn = append(burn, sloBurn{Long: pair.long, Short: pair.short, Factor: pair.spent * sloPeriodSeconds[cfg.Period] / sloWindowSeconds[pair.long], Severity: pair.severity})
	}
	total, hasTotal := readings.values[cfg.Period+"|total"]
	bad, hasBad := readings.values[cfg.Period+"|bad"]
	var totalPtr, badPtr *float64
	if hasTotal {
		totalPtr = sloPtr(total)
	}
	if hasBad {
		badPtr = sloPtr(bad)
	}
	// A truncated result can drop some of this group's series, so a group that is missing any window reading is
	// incomplete. A group whose readings all arrived is exact, whatever else the provider dropped.
	if truncated && !sloGroupComplete(cfg, readings) {
		return sloUnknownGroup(readings.labels, "incomplete", totalPtr, badPtr, burn)
	}
	if reason := sloPeriodGate(hasTotal, total, hasBad); reason != "" {
		return sloUnknownGroup(readings.labels, reason, totalPtr, badPtr, burn)
	}

	allowance := 1 - cfg.Objective/100
	errorRatio := bad / total
	allowed := total * allowance
	budgetRemaining := 100 * (1 - bad/allowed)
	sloApplyBurn(readings, pairs, burn, allowance)

	reasons := []string{}
	if budgetRemaining <= 0 {
		reasons = append(reasons, "budget_exhausted")
	}
	if sloAnyFiring(burn, "critical") {
		reasons = append(reasons, "fast_burn")
	}
	if sloAnyFiring(burn, "warning") {
		reasons = append(reasons, "slow_burn")
	}
	state := sloGroupState(reasons)
	return sloGroup{
		Labels:          readings.labels,
		State:           state,
		Reasons:         reasons,
		Availability:    sloPtr(100 * (1 - errorRatio)),
		ErrorRatio:      sloPtr(errorRatio),
		BudgetRemaining: sloPtr(budgetRemaining),
		Total:           totalPtr,
		Bad:             badPtr,
		Allowed:         sloPtr(allowed),
		Burn:            burn,
	}
}

// sloGroupComplete reports whether a group has a total and a bad reading for every window it was evaluated over.
func sloGroupComplete(cfg *sloConfig, readings *sloReadings) bool {
	for _, window := range sloWindowsOf(cfg) {
		_, hasTotal := readings.values[window+"|total"]
		_, hasBad := readings.values[window+"|bad"]
		if !hasTotal || !hasBad {
			return false
		}
	}
	return true
}

// sloPeriodGate returns the unknown reason when the period cannot be read: no total, no traffic, or no bad series.
func sloPeriodGate(hasTotal bool, total float64, hasBad bool) string {
	switch {
	case !hasTotal:
		return "no_data"
	case total <= 0:
		return "no_traffic"
	case !hasBad:
		return "no_data"
	}
	return ""
}

// sloGroupState is breaching when the budget is spent or a critical pair fires, at risk when a warning pair fires,
// and meeting otherwise.
func sloGroupState(reasons []string) string {
	switch {
	case sloHasReason(reasons, "budget_exhausted") || sloHasReason(reasons, "fast_burn"):
		return "breaching"
	case sloHasReason(reasons, "slow_burn"):
		return "at_risk"
	}
	return "meeting"
}

// sloApplyBurn fills each pair's long and short burn rate and whether it fires. A rate is unknown when its
// window has no traffic or no bad reading.
func sloApplyBurn(readings *sloReadings, pairs []sloPair, burn []sloBurn, allowance float64) {
	burnRate := func(window string) *float64 {
		windowTotal, okTotal := readings.values[window+"|total"]
		windowBad, okBad := readings.values[window+"|bad"]
		if !okTotal || windowTotal <= 0 || !okBad {
			return nil
		}
		return sloPtr((windowBad / windowTotal) / allowance)
	}
	for i, pair := range pairs {
		longBurn := burnRate(pair.long)
		shortBurn := burnRate(pair.short)
		burn[i].LongBurn = longBurn
		burn[i].ShortBurn = shortBurn
		burn[i].Firing = longBurn != nil && shortBurn != nil &&
			*longBurn >= burn[i].Factor && *shortBurn >= burn[i].Factor
	}
}

// sloGroupBefore orders groups worst state first, then by budget ascending, then by label key.
func sloGroupBefore(a, b *sloGroup) bool {
	if rank := sloStateRank[a.State] - sloStateRank[b.State]; rank != 0 {
		return rank < 0
	}
	budgetA, budgetB := math.Inf(1), math.Inf(1)
	if a.BudgetRemaining != nil {
		budgetA = *a.BudgetRemaining
	}
	if b.BudgetRemaining != nil {
		budgetB = *b.BudgetRemaining
	}
	if budgetA != budgetB {
		return budgetA < budgetB
	}
	return sloLabelsKey(a.Labels) < sloLabelsKey(b.Labels)
}

// sloOverall is the overall state of a services-mode result. It is the worst evaluated group's state, where
// evaluated means not unknown. When no evaluated group is worse than meeting, but some group is unknown or a
// truncated grouped result may have dropped whole groups, the overall is partial: it never reads meeting. A
// truncated ungrouped result has one group, which is exact when its readings all arrived. With no groups the
// state is unknown with no_data, and a truncated result adds incomplete.
func sloOverall(groups []sloGroup, truncated, grouped bool) (state string, reasons []string) {
	if len(groups) == 0 {
		if truncated {
			return "unknown", []string{"no_data", "incomplete"}
		}
		return "unknown", []string{"no_data"}
	}
	state, source := sloOverallSource(groups, truncated && grouped)
	present := map[string]bool{}
	// A truncated result can hide whole groups, so incomplete is always reported with it.
	if truncated {
		present["incomplete"] = true
	}
	for _, group := range source {
		for _, reason := range group.Reasons {
			present[reason] = true
		}
	}
	reasons = []string{}
	for _, reason := range sloReasonOrder {
		if present[reason] {
			reasons = append(reasons, reason)
		}
	}
	return state, reasons
}

// sloOverallSource returns the overall state and the groups whose reasons it reports.
func sloOverallSource(groups []sloGroup, hidden bool) (string, []sloGroup) {
	worst := ""
	anyUnknown := false
	for _, group := range groups {
		if group.State == "unknown" {
			anyUnknown = true
		} else if worst == "" || sloStateRank[group.State] < sloStateRank[worst] {
			worst = group.State
		}
	}
	switch {
	case worst == "":
		return "unknown", groups
	case worst != "meeting":
		return worst, sloGroupsIn(groups, worst)
	case hidden || anyUnknown:
		return "partial", sloGroupsIn(groups, "unknown")
	}
	return "meeting", nil
}

// sloGroupsIn returns the groups in one state, in order.
func sloGroupsIn(groups []sloGroup, state string) []sloGroup {
	var matched []sloGroup
	for _, group := range groups {
		if group.State == state {
			matched = append(matched, group)
		}
	}
	return matched
}

func sloAnyFiring(burn []sloBurn, severity string) bool {
	for _, entry := range burn {
		if entry.Severity == severity && entry.Firing {
			return true
		}
	}
	return false
}

func sloHasReason(reasons []string, reason string) bool {
	for _, candidate := range reasons {
		if candidate == reason {
			return true
		}
	}
	return false
}
