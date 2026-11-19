package insights

import (
	"math"
	"time"
)

// dashboardSLOBasis states what an slo-summary reading is, so no reader takes it for a health verdict.
const dashboardSLOBasis = "evaluation of the widget's author-declared objective; not a health verdict"

// dashboardSLODefaultListed is the default max_series, the number of groups listed per widget.
const dashboardSLODefaultListed = 3

// DashboardSLO is an slo-summary widget's evaluation of its authored objective over the returned
// window. It is built from the raw query result, and it never changes the widget's signal state or
// threshold. Groups lists at most max_series groups; GroupsOmitted counts the rest, including any the
// config's maxRows already left out.
type DashboardSLO struct {
	Basis         string              `json:"basis"`
	Objective     float64             `json:"objective"`
	Period        string              `json:"period"`
	EvaluatedAt   string              `json:"evaluatedAt"`
	State         string              `json:"state"`
	Reasons       []string            `json:"reasons"`
	Counts        sloCounts           `json:"counts"`
	Groups        []DashboardSLOGroup `json:"groups"`
	GroupsOmitted int                 `json:"groupsOmitted"`
}

// DashboardSLOGroup is one listed SLO group. Burn is dropped by the sloBurn omission step.
type DashboardSLOGroup struct {
	Labels          map[string]string `json:"labels"`
	State           string            `json:"state"`
	Reasons         []string          `json:"reasons"`
	Availability    *float64          `json:"availability"`
	ErrorRatio      *float64          `json:"errorRatio"`
	BudgetRemaining *float64          `json:"budgetRemaining"`
	Total           *float64          `json:"total"`
	Bad             *float64          `json:"bad"`
	Allowed         *float64          `json:"allowed"`
	Burn            []sloBurn         `json:"burn,omitempty"`
}

// dashboardSLOOutput evaluates an objective over a raw result and lists at most listed groups.
// A nil result, from a failed signal, evaluates to unknown with no_data.
func dashboardSLOOutput(cfg *sloConfig, result *QueryResult, listed int, end float64) *DashboardSLO {
	evaluation := evaluateSLO(cfg, result)
	groups := evaluation.Groups
	omitted := evaluation.GroupsOmitted
	if len(groups) > listed {
		omitted += len(groups) - listed
		groups = groups[:listed]
	}
	out := &DashboardSLO{
		Basis:         dashboardSLOBasis,
		Objective:     cfg.Objective,
		Period:        cfg.Period,
		EvaluatedAt:   time.UnixMilli(int64(math.Round(end * 1000))).UTC().Format(time.RFC3339Nano),
		State:         evaluation.State,
		Reasons:       evaluation.Reasons,
		Counts:        evaluation.Counts,
		Groups:        make([]DashboardSLOGroup, 0, len(groups)),
		GroupsOmitted: omitted,
	}
	for _, group := range groups {
		// The two types differ only in the burn tag, which conversion ignores, so they convert field for field.
		out.Groups = append(out.Groups, DashboardSLOGroup(group))
	}
	return out
}

// applyDashboardSLO evaluates an slo-summary widget on its signal. A failed signal has no raw result,
// so it evaluates to unknown rather than keeping a stale reading.
func applyDashboardSLO(widget *DashboardQueryWidget, signal *DashboardSignal, raw *QueryResult, listed int, end float64) {
	if widget.SignalID != signal.ID || widget.sloConfig == nil {
		return
	}
	if signal.Error != nil {
		raw = nil
	}
	if listed <= 0 {
		listed = dashboardSLODefaultListed
	}
	widget.SLO = dashboardSLOOutput(widget.sloConfig, raw, listed, end)
}

// dashboardSLODeclares reports whether an SLO state sets an attention level. A breaching objective
// counts as critical and an at-risk one as warning. Only author-declared objectives count.
func dashboardSLODeclares(slo *DashboardSLO, level string) bool {
	if slo == nil {
		return false
	}
	return (slo.State == "breaching" && level == "critical") || (slo.State == "at_risk" && level == "warning")
}

// dropDashboardSLOBurn removes the burn windows of every listed SLO group. The state, reasons,
// counts and budget stay, so the widget still reads its status.
func dropDashboardSLOBurn(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		slo := result.Widgets[index].SLO
		if slo == nil {
			continue
		}
		for group := range slo.Groups {
			if slo.Groups[group].Burn != nil {
				slo.Groups[group].Burn = nil
				dropped = true
			}
		}
	}
	return dropped
}
