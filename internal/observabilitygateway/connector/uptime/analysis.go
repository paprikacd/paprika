package uptime

import (
	"context"
	"errors"
	"strings"

	"github.com/benebsworth/paprika/internal/dataframe"
)

type serviceSLO struct {
	ServiceID             string  `json:"serviceId"`
	ServiceName           string  `json:"serviceName"`
	ServiceSlug           string  `json:"serviceSlug"`
	SLATarget             float64 `json:"slaTarget"`
	CurrentUptime         float64 `json:"currentUptime"`
	ErrorBudgetTotal      float64 `json:"errorBudgetTotal"`
	ErrorBudgetRemaining  float64 `json:"errorBudgetRemaining"`
	ErrorBudgetPercentage float64 `json:"errorBudgetPercentage"`
	SLABreached           bool    `json:"slaBreached"`
	TotalChecks           int     `json:"totalChecks"`
	FailedChecks          int     `json:"failedChecks"`
}

type sloResponse struct {
	Services []serviceSLO `json:"services"`
}

func (b *backend) slo(ctx context.Context, q *query) (*dataframe.Frame, error) {
	window := 30
	if q.Args.WindowDays != nil {
		window = *q.Args.WindowDays
	}
	var response sloResponse
	if err := b.call(ctx, sloRPC, rpcRequest{OrgID: b.config.OrgID, WindowDays: window}, &response); err != nil {
		return nil, err
	}
	items := make([]serviceSLO, 0)
	for _, item := range response.Services {
		if matchesSLO(&item, &q.Args) {
			items = append(items, item)
		}
	}
	partial := len(items) > b.limit
	items = items[:min(len(items), b.limit)]
	if q.Operation == "slo_summary" {
		return summarizeSLO(items, window, partial), nil
	}
	frame := newFrame(col("serviceId", "string"), col("serviceName", "string"), col("serviceSlug", "string"), unitCol("slaTarget", "percent"), unitCol("uptime", "percent"), unitCol("errorBudgetTotal", "minutes"), unitCol("errorBudgetRemaining", "minutes"), unitCol("errorBudgetPercentage", "percent"), col("slaBreached", "boolean"), col("totalChecks", "number"), col("failedChecks", "number"), col("windowDays", "number"), unitCol("burnRate", "percent"), col("burnStatus", "string"), col("observed", "boolean"))
	frame.Truncated = partial
	for _, item := range items {
		observed := item.TotalChecks > 0
		burn := (100 - item.ErrorBudgetPercentage) / float64(window) * 30
		frame.Rows = append(frame.Rows, []any{item.ServiceID, item.ServiceName, item.ServiceSlug, item.SLATarget, observedValue(item.CurrentUptime, observed), item.ErrorBudgetTotal, observedValue(item.ErrorBudgetRemaining, observed), observedValue(item.ErrorBudgetPercentage, observed), observedValue(item.SLABreached, observed), item.TotalChecks, item.FailedChecks, window, observedValue(burn, observed), observedValue(burnStatus(burn), observed), observed})
	}
	return frame, nil
}

func matchesSLO(item *serviceSLO, args *queryArgs) bool {
	if !matches(item.ServiceID, args.ServiceID) {
		return false
	}
	return args.BreachedOnly == nil || !*args.BreachedOnly || (item.TotalChecks > 0 && item.SLABreached)
}

func observedValue(value any, observed bool) any {
	if !observed {
		return nil
	}
	return value
}

func burnStatus(rate float64) string {
	switch {
	case rate > 200:
		return "Critical"
	case rate > 100:
		return "Elevated"
	default:
		return "Sustainable"
	}
}

func summarizeSLO(items []serviceSLO, window int, partial bool) *dataframe.Frame {
	observed, onTrack, breached, burnAlerts := 0, 0, 0, 0
	uptimeTotal := 0.0
	for _, item := range items {
		if item.TotalChecks <= 0 {
			continue
		}
		observed++
		uptimeTotal += item.CurrentUptime
		if item.SLABreached {
			breached++
		} else {
			onTrack++
		}
		if (100-item.ErrorBudgetPercentage)/float64(window)*30 > 200 {
			burnAlerts++
		}
	}
	var average any
	if observed > 0 && !partial {
		average = uptimeTotal / float64(observed)
	}
	frame := newFrame(col("serviceCount", "number"), col("observedServiceCount", "number"), col("unobservedServiceCount", "number"), col("onTrackCount", "number"), col("breachedCount", "number"), col("burnAlertCount", "number"), unitCol("averageUptime", "percent"), col("windowDays", "number"), col("loadedServiceCount", "number"))
	frame.Truncated = partial
	frame.Rows = append(frame.Rows, []any{exactCount(len(items), partial), exactCount(observed, partial), exactCount(len(items)-observed, partial), exactCount(onTrack, partial), exactCount(breached, partial), exactCount(burnAlerts, partial), average, window, len(items)})
	return frame
}

type reliabilityInsight struct {
	ID               string   `json:"id"`
	Category         string   `json:"category"`
	Severity         string   `json:"severity"`
	Title            string   `json:"title"`
	Description      string   `json:"description"`
	Recommendation   string   `json:"recommendation"`
	AffectedServices []string `json:"affectedServices"`
	GeneratedAt      *string  `json:"generatedAt"`
}

type reliabilityReport struct {
	ID                 string               `json:"id"`
	OrgID              string               `json:"orgId"`
	Summary            string               `json:"summary"`
	OverallHealthScore float64              `json:"overallHealthScore"`
	Insights           []reliabilityInsight `json:"insights"`
	PeriodStart        *string              `json:"periodStart"`
	PeriodEnd          *string              `json:"periodEnd"`
	GeneratedAt        *string              `json:"generatedAt"`
}

type reliabilityResponse struct {
	LatestReport *reliabilityReport `json:"latestReport"`
}

func (b *backend) reliability(ctx context.Context, operation string) (*dataframe.Frame, error) {
	// Uptime's current reliability handler checks only the membership lookup
	// error, not its boolean. ListServices correctly enforces organization
	// membership; never read a report before this independent authorization gate.
	var access servicesResponse
	if err := b.call(ctx, servicesRPC, rpcRequest{OrgID: b.config.OrgID, Page: &pageRequest{PageSize: 1}}, &access); err != nil {
		return nil, err
	}
	var response reliabilityResponse
	if err := b.call(ctx, reliabilityRPC, rpcRequest{OrgID: b.config.OrgID}, &response); err != nil {
		return nil, err
	}
	report := response.LatestReport
	if report != nil && report.OrgID != b.config.OrgID {
		return nil, errors.New("uptime returned a report outside its configured organization")
	}
	if operation == "reliability_summary" {
		return summarizeReliability(report), nil
	}
	return reliabilityRecords(report, b.limit), nil
}

func reliabilityRecords(report *reliabilityReport, limit int) *dataframe.Frame {
	frame := newFrame(col("insightId", "string"), col("reportId", "string"), col("category", "string"), col("severity", "string"), col("title", "string"), col("description", "string"), col("recommendation", "string"), col("affectedServices", "string"), col("generatedAt", "timestamp"))
	if report == nil {
		return frame
	}
	frame.Truncated = len(report.Insights) > limit
	for index := range min(len(report.Insights), limit) {
		item := &report.Insights[index]
		frame.Rows = append(frame.Rows, []any{item.ID, report.ID, item.Category, item.Severity, item.Title, item.Description, item.Recommendation, strings.Join(item.AffectedServices, ", "), optional(item.GeneratedAt)})
	}
	return frame
}

func summarizeReliability(report *reliabilityReport) *dataframe.Frame {
	frame := newFrame(col("reportId", "string"), col("summary", "string"), unitCol("healthScore", "percent"), col("insightCount", "number"), col("criticalCount", "number"), col("warningCount", "number"), col("infoCount", "number"), col("periodStart", "timestamp"), col("periodEnd", "timestamp"), col("generatedAt", "timestamp"))
	if report == nil {
		return frame
	}
	critical, warning, info := 0, 0, 0
	for index := range report.Insights {
		item := &report.Insights[index]
		switch item.Severity {
		case "critical":
			critical++
		case "warning":
			warning++
		case "info":
			info++
		}
	}
	frame.Rows = append(frame.Rows, []any{report.ID, report.Summary, report.OverallHealthScore, len(report.Insights), critical, warning, info, optional(report.PeriodStart), optional(report.PeriodEnd), optional(report.GeneratedAt)})
	return frame
}
