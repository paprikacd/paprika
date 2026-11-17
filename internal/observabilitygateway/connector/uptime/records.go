package uptime

import (
	"context"
	"errors"
	"strings"

	"github.com/benebsworth/paprika/internal/dataframe"
)

type pageInfo struct {
	HasNextPage   bool   `json:"hasNextPage"`
	NextPageToken string `json:"nextPageToken"`
}

func (p pageInfo) partial(count, limit int) bool {
	return p.HasNextPage || p.NextPageToken != "" || count > limit
}

type service struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type servicesResponse struct {
	Services []service `json:"services"`
	PageInfo pageInfo  `json:"pageInfo"`
}

type check struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Enabled bool   `json:"enabled"`
}

type checkSummary struct {
	Check                check   `json:"check"`
	ServiceID            string  `json:"serviceId"`
	ServiceName          string  `json:"serviceName"`
	LatestStatus         *string `json:"latestStatus"`
	LatestResultAt       *string `json:"latestResultAt"`
	LatestResponseTimeMs *int    `json:"latestResponseTimeMs"`
}

type checksResponse struct {
	Summaries []checkSummary `json:"summaries"`
	PageInfo  pageInfo       `json:"pageInfo"`
}

type securitySummary struct {
	ServiceID            string  `json:"serviceId"`
	ServiceName          string  `json:"serviceName"`
	CheckID              *string `json:"checkId"`
	CheckEnabled         bool    `json:"checkEnabled"`
	LatestStatus         *string `json:"latestStatus"`
	LatestResultAt       *string `json:"latestResultAt"`
	OverallScore         *int    `json:"overallScore"`
	RiskLevel            string  `json:"riskLevel"`
	FindingCount         int     `json:"findingCount"`
	HighRiskFindingCount int     `json:"highRiskFindingCount"`
	ObservedSignalCount  int     `json:"observedSignalCount"`
	SupportedSignalCount int     `json:"supportedSignalCount"`
}

type securityResponse struct {
	Summaries []securitySummary `json:"summaries"`
	PageInfo  pageInfo          `json:"pageInfo"`
}

type alertEvent struct {
	ID          string  `json:"id"`
	AlertID     string  `json:"alertId"`
	Status      string  `json:"status"`
	TriggeredAt *string `json:"triggeredAt"`
	ResolvedAt  *string `json:"resolvedAt"`
	Alert       struct {
		Name    string `json:"name"`
		CheckID string `json:"checkId"`
	} `json:"alert"`
}

type alertsResponse struct {
	Events   []alertEvent `json:"events"`
	PageInfo pageInfo     `json:"pageInfo"`
}

func col(key, kind string) dataframe.Column {
	return dataframe.Column{Key: key, Type: kind}
}

func unitCol(key, unit string) dataframe.Column {
	return dataframe.Column{Key: key, Type: "number", Unit: unit}
}

func newFrame(columns ...dataframe.Column) *dataframe.Frame {
	return &dataframe.Frame{Columns: columns, Rows: make([][]any, 0)}
}

func optional[T any](value *T) any {
	if value == nil {
		return nil
	}
	return *value
}

func matches(id, selected string) bool { return selected == "" || id == selected }

func (b *backend) read(ctx context.Context, q *query) (*dataframe.Frame, error) {
	switch q.Operation {
	case "services":
		return b.services(ctx, q.Args.ServiceID)
	case "check_summaries":
		return b.checks(ctx, q.Args.ServiceID)
	case "security_summaries":
		return b.security(ctx, q.Args.ServiceID)
	case "alert_events":
		return b.alerts(ctx)
	case "overview":
		return b.overview(ctx)
	case "service_signals":
		return b.serviceSignals(ctx, q.Args.ServiceID)
	case "slo", "slo_summary":
		return b.slo(ctx, q)
	case "reliability_insights", "reliability_summary":
		return b.reliability(ctx, q.Operation)
	default:
		return nil, errors.New("uptime operation is not an allowed read")
	}
}

func (b *backend) services(ctx context.Context, selected string) (*dataframe.Frame, error) {
	var response servicesResponse
	if err := b.call(ctx, servicesRPC, b.listRequest(), &response); err != nil {
		return nil, err
	}
	frame := newFrame(col("serviceId", "string"), col("serviceName", "string"), col("serviceSlug", "string"))
	frame.Truncated = response.PageInfo.partial(len(response.Services), b.limit)
	for _, item := range response.Services[:min(len(response.Services), b.limit)] {
		if matches(item.ID, selected) {
			frame.Rows = append(frame.Rows, []any{item.ID, item.Name, item.Slug})
		}
	}
	return frame, nil
}

func (b *backend) checks(ctx context.Context, selected string) (*dataframe.Frame, error) {
	var response checksResponse
	if err := b.call(ctx, checksRPC, b.listRequest(), &response); err != nil {
		return nil, err
	}
	frame := newFrame(col("checkId", "string"), col("checkName", "string"), col("checkType", "string"), col("enabled", "boolean"), col("serviceId", "string"), col("serviceName", "string"), col("status", "string"), col("observedAt", "timestamp"), unitCol("responseTimeMs", "ms"))
	frame.Truncated = response.PageInfo.partial(len(response.Summaries), b.limit)
	for _, item := range response.Summaries[:min(len(response.Summaries), b.limit)] {
		if matches(item.ServiceID, selected) {
			frame.Rows = append(frame.Rows, []any{item.Check.ID, item.Check.Name, item.Check.Type, item.Check.Enabled, item.ServiceID, item.ServiceName, optional(item.LatestStatus), optional(item.LatestResultAt), optional(item.LatestResponseTimeMs)})
		}
	}
	return frame, nil
}

func (b *backend) security(ctx context.Context, selected string) (*dataframe.Frame, error) {
	var response securityResponse
	if err := b.call(ctx, securityRPC, b.listRequest(), &response); err != nil {
		return nil, err
	}
	frame := newFrame(col("serviceId", "string"), col("serviceName", "string"), col("checkId", "string"), col("enabled", "boolean"), col("status", "string"), col("observedAt", "timestamp"), unitCol("score", "percent"), col("riskLevel", "string"), col("findingCount", "number"), col("highRiskFindingCount", "number"), col("observedSignalCount", "number"), col("supportedSignalCount", "number"))
	frame.Truncated = response.PageInfo.partial(len(response.Summaries), b.limit)
	for _, item := range response.Summaries[:min(len(response.Summaries), b.limit)] {
		if matches(item.ServiceID, selected) {
			frame.Rows = append(frame.Rows, []any{item.ServiceID, item.ServiceName, optional(item.CheckID), item.CheckEnabled, optional(item.LatestStatus), optional(item.LatestResultAt), optional(item.OverallScore), item.RiskLevel, item.FindingCount, item.HighRiskFindingCount, item.ObservedSignalCount, item.SupportedSignalCount})
		}
	}
	return frame, nil
}

func (b *backend) loadAlerts(ctx context.Context) (alertsResponse, error) {
	var response alertsResponse
	request := b.listRequest()
	request.StatusFilter = "ALERT_EVENT_STATUS_TRIGGERED"
	err := b.call(ctx, alertsRPC, request, &response)
	return response, err
}

func (b *backend) alerts(ctx context.Context) (*dataframe.Frame, error) {
	response, err := b.loadAlerts(ctx)
	if err != nil {
		return nil, err
	}
	frame := newFrame(col("eventId", "string"), col("alertId", "string"), col("alertName", "string"), col("checkId", "string"), col("status", "string"), col("triggeredAt", "timestamp"), col("resolvedAt", "timestamp"))
	frame.Truncated = response.PageInfo.partial(len(response.Events), b.limit)
	for _, item := range response.Events[:min(len(response.Events), b.limit)] {
		if item.Status == "ALERT_EVENT_STATUS_TRIGGERED" {
			frame.Rows = append(frame.Rows, []any{item.ID, item.AlertID, item.Alert.Name, item.Alert.CheckID, item.Status, optional(item.TriggeredAt), optional(item.ResolvedAt)})
		}
	}
	return frame, nil
}

type overviewData struct {
	services servicesResponse
	checks   checksResponse
	security securityResponse
	alerts   alertsResponse
}

func (b *backend) loadOverview(ctx context.Context, withAlerts bool) (*overviewData, error) {
	data := new(overviewData)
	if err := b.call(ctx, servicesRPC, b.listRequest(), &data.services); err != nil {
		return nil, err
	}
	if err := b.call(ctx, checksRPC, b.listRequest(), &data.checks); err != nil {
		return nil, err
	}
	if err := b.call(ctx, securityRPC, b.listRequest(), &data.security); err != nil {
		return nil, err
	}
	if withAlerts {
		response, err := b.loadAlerts(ctx)
		if err != nil {
			return nil, err
		}
		data.alerts = response
	}
	return data, nil
}

func exactCount(count int, partial bool) any {
	if partial {
		return nil
	}
	return count
}

func (b *backend) overview(ctx context.Context) (*dataframe.Frame, error) {
	data, err := b.loadOverview(ctx, true)
	if err != nil {
		return nil, err
	}
	servicesPartial := data.services.PageInfo.partial(len(data.services.Services), b.limit)
	checksPartial := data.checks.PageInfo.partial(len(data.checks.Summaries), b.limit)
	securityPartial := data.security.PageInfo.partial(len(data.security.Summaries), b.limit)
	alertsPartial := data.alerts.PageInfo.partial(len(data.alerts.Events), b.limit)
	securityResults := 0
	for _, item := range data.security.Summaries[:min(len(data.security.Summaries), b.limit)] {
		if item.LatestResultAt != nil {
			securityResults++
		}
	}
	activeAlerts := 0
	for _, item := range data.alerts.Events[:min(len(data.alerts.Events), b.limit)] {
		if item.Status == "ALERT_EVENT_STATUS_TRIGGERED" {
			activeAlerts++
		}
	}
	loadedServices := min(len(data.services.Services), b.limit)
	loadedChecks := min(len(data.checks.Summaries), b.limit)
	frame := newFrame(col("serviceCount", "number"), col("monitorCount", "number"), col("activeAlertCount", "number"), col("securityResultCount", "number"), col("loadedServiceCount", "number"), col("loadedMonitorCount", "number"), col("loadedActiveAlertCount", "number"), col("loadedSecurityResultCount", "number"))
	frame.Truncated = servicesPartial || checksPartial || securityPartial || alertsPartial
	frame.Rows = append(frame.Rows, []any{exactCount(loadedServices, servicesPartial), exactCount(loadedChecks, checksPartial), exactCount(activeAlerts, alertsPartial), exactCount(securityResults, securityPartial), loadedServices, loadedChecks, activeAlerts, securityResults})
	return frame, nil
}

func (b *backend) serviceSignals(ctx context.Context, selected string) (*dataframe.Frame, error) {
	data, err := b.loadOverview(ctx, false)
	if err != nil {
		return nil, err
	}
	frame := newFrame(col("serviceId", "string"), col("serviceName", "string"), col("availability", "string"), col("enabledMonitorCount", "number"), col("reportingMonitorCount", "number"), unitCol("responseTimeMs", "ms"), unitCol("securityScore", "percent"), col("securityRisk", "string"))
	checksPartial := data.checks.PageInfo.partial(len(data.checks.Summaries), b.limit)
	frame.Truncated = checksPartial || data.services.PageInfo.partial(len(data.services.Services), b.limit) || data.security.PageInfo.partial(len(data.security.Summaries), b.limit)
	for _, item := range data.services.Services[:min(len(data.services.Services), b.limit)] {
		if !matches(item.ID, selected) {
			continue
		}
		state := summarizeAvailability(item.ID, data.checks.Summaries[:min(len(data.checks.Summaries), b.limit)], checksPartial)
		score, risk := serviceSecurity(item.ID, data.security.Summaries[:min(len(data.security.Summaries), b.limit)])
		frame.Rows = append(frame.Rows, []any{item.ID, item.Name, state.label, state.enabled, state.reporting, state.duration, score, risk})
	}
	return frame, nil
}

type availability struct {
	label                     string
	enabled, reporting, total int
	failed                    bool
	duration                  any
}

func summarizeAvailability(serviceID string, checks []checkSummary, partial bool) availability {
	var state availability
	for _, item := range checks {
		if item.ServiceID != serviceID || !availabilityType(item.Check.Type) {
			continue
		}
		state.total++
		if !item.Check.Enabled {
			continue
		}
		state.enabled++
		if item.LatestStatus == nil || item.LatestResultAt == nil {
			continue
		}
		state.reporting++
		state.failed = state.failed || *item.LatestStatus != "CHECK_STATUS_SUCCESS"
		state.duration = maxDuration(state.duration, item.LatestResponseTimeMs)
	}
	state.label = availabilityLabel(&state, partial)
	return state
}

func maxDuration(previous any, current *int) any {
	if current == nil {
		return previous
	}
	old, ok := previous.(int)
	if !ok || *current > old {
		return *current
	}
	return previous
}

func availabilityType(kind string) bool {
	switch kind {
	case "CHECK_TYPE_UPTIME", "CHECK_TYPE_BROWSER", "CHECK_TYPE_PLAYWRIGHT":
		return true
	default:
		return false
	}
}

func availabilityLabel(state *availability, partial bool) string {
	switch {
	case state.failed:
		return "Needs attention"
	case partial:
		return "Loaded signals only"
	case state.total == 0:
		return "No availability monitors"
	case state.enabled == 0:
		return "Monitoring paused"
	case state.reporting == 0:
		return "Waiting for data"
	case state.reporting < state.enabled:
		return "Partial data"
	default:
		return "Healthy"
	}
}

func serviceSecurity(serviceID string, items []securitySummary) (score, risk any) {
	for _, item := range items {
		if item.ServiceID == serviceID && item.LatestResultAt != nil {
			return optional(item.OverallScore), strings.TrimSpace(item.RiskLevel)
		}
	}
	return nil, nil
}
