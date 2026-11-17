package shorted

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

var fieldFilter = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

type position struct {
	StockCode string   `json:"stock_code"` //nolint:tagliatelle // Public query arguments deliberately use snake_case.
	Quantity  *float64 `json:"quantity"`
	Cost      *float64 `json:"cost,omitempty"`
}

func addApplicationOperations(ops map[string]operation) {
	ops["screener"] = operation{path: "/shorts.v1alpha1.ScreenerService/ScreenStocks", args: []string{"limit", "offset", "sort_field", "sort_direction", "product_codes"}, defaults: map[string]any{"limit": 10, "sort_field": "SCREENER_SORT_FIELD_SHORT_PCT", "sort_direction": "SORT_DIRECTION_DESC"}, section: "stocks", fields: fields("stock_code:string", "company_name:string", "industry:string", "short_pct:number:percent", "short_pct_change_4w:number:percent", "latest_price:number:AUD", "price_change_1m:number:percent", "latest_volume:number:shares", "market_cap:number:AUD", "pe_ratio:number", "dividend_yield:number:percent", "days_to_cover:number")}
	ops["portfolio_positions"] = operation{path: priceService + "GetMultipleStockPrices", args: []string{"positions"}, marketData: true, fields: fields("stock_code:string", "quantity:number:shares", "cost:number:AUD", "close:number:AUD", "market_value:number:AUD", "day_change:number:AUD", "day_change_percent:number:percent", "cost_basis:number:AUD", "gain:number:AUD", "complete:boolean")}
	ops["portfolio_summary"] = operation{path: priceService + "GetMultipleStockPrices", args: []string{"positions"}, marketData: true, fields: fields("market_value:number:AUD", "day_change:number:AUD", "day_change_percent:number:percent", "position_count:number", "valued_positions:number", "complete:boolean")}
	ops["sector_performance"] = operation{path: priceService + "GetMultipleStockPrices", marketData: true, fields: fields("sector:string", "performance:number:percent", "volume:number:shares", "expected_stocks:number", "observed_stocks:number", "complete:boolean", "top_gainers:string", "top_losers:string")}
	for _, name := range []string{"admin_jobs", "admin_issues"} {
		ops[name] = operation{path: "/api/admin/jobs", admin: true, fields: adminJobFields()}
	}
	ops["admin_fleet"] = operation{path: "/api/admin/jobs", admin: true, fields: fields("status:string", "active_jobs:number", "critical_jobs:number", "overdue_jobs:number", "warning_jobs:number", "retired_jobs:number", "stale:boolean")}
	ops["admin_sync"] = operation{path: "/api/admin/sync-status", admin: true, args: []string{"limit", "environment", "exclude_local"}, defaults: map[string]any{"limit": 20, "environment": "production", "exclude_local": true}, section: "runs", fields: fields("run_id:string", "started_at:timestamp", "completed_at:timestamp", "status:string", "shorts_records_updated:number", "prices_records_updated:number", "metrics_records_updated:number", "algolia_records_synced:number", "total_duration_seconds:number:s", "environment:string", "checkpoint_stocks_total:number", "checkpoint_stocks_processed:number", "checkpoint_stocks_successful:number", "checkpoint_stocks_failed:number")}
}

func adminJobFields() []field {
	return fields("name:string", "display_name:string", "category:string", "type:string", "region:string", "schedule:string", "schedule_human:string", "scheduler_state:string", "last_run_at:timestamp", "last_run_status:string", "last_success_at:timestamp", "duration_seconds:number:s", "succeeded_count:number", "failed_count:number", "running_count:number", "retired:boolean", "expected_max_gap_seconds:number:s", "overdue_by_seconds:number:s", "last_attempt_at:timestamp", "health:string", "stale:boolean")
}

func parsePositions(raw json.RawMessage) ([]position, error) {
	var objects []json.RawMessage
	if json.Unmarshal(raw, &objects) != nil || len(objects) == 0 || len(objects) > 50 {
		return nil, errors.New("shorted positions must contain 1 to 50 explicit holdings")
	}
	result := make([]position, 0, len(objects))
	seen := map[string]bool{}
	for _, object := range objects {
		var p position
		if decodeStrict(object, &p) != nil || p.Quantity == nil {
			return nil, errors.New("shorted position must contain stock_code, quantity and optional cost")
		}
		p.StockCode = strings.ToUpper(p.StockCode)
		if !validPosition(&p) || seen[p.StockCode] {
			return nil, errors.New("shorted position code or amount is invalid")
		}
		seen[p.StockCode] = true
		result = append(result, p)
	}
	return result, nil
}
func validPosition(p *position) bool {
	return stockCode.MatchString(p.StockCode) && boundedHoldingNumber(*p.Quantity) && (p.Cost == nil || boundedHoldingNumber(*p.Cost))
}

func boundedHoldingNumber(n float64) bool {
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 1_000_000
}

func adaptNativeArgs(name string, args map[string]any) {
	delete(args, "signalKind")
	delete(args, "metricKey")
	switch name {
	case "portfolio_positions", "portfolio_summary":
		positions, ok := args["positions"].([]position)
		if !ok {
			return
		}
		codes := make([]string, 0, len(positions))
		for _, p := range positions {
			codes = append(codes, p.StockCode)
		}
		delete(args, "positions")
		args["stockCodes"] = codes
	case "sector_performance":
		args["stockCodes"] = sectorCodes()
	case "screener":
		if codes, ok := args["productCodes"]; ok {
			delete(args, "productCodes")
			args["filters"] = map[string]any{"productCodes": codes}
		}
	}
}

func localFilters(args map[string]json.RawMessage) map[string]string {
	filters := map[string]string{}
	for _, key := range []string{"signal_kind", "metric_key"} {
		if raw, exists := args[key]; exists {
			var value string
			if json.Unmarshal(raw, &value) == nil {
				filters[key] = value
			}
		}
	}
	return filters
}
func (b *frameBuilder) matches(record map[string]any) bool {
	for key, value := range b.filters {
		if lookup(record, key) != value {
			return false
		}
	}
	return true
}

func readOperation(ctx context.Context, endpoint, token string, op *operation, body []byte) (json.RawMessage, error) {
	if !op.admin {
		return read(ctx, endpoint, token, op.path, body)
	}
	var args map[string]any
	if json.Unmarshal(body, &args) != nil {
		return nil, errors.New("shorted administrative query is invalid")
	}
	path := adminPath(op.path, args)
	req, err := backendRequest(ctx, endpoint, token, path, nil)
	if err != nil {
		return nil, err
	}
	req.Method = http.MethodGet
	response, err := httphelp.DoReadRequest(req, client)
	if err != nil {
		return nil, errors.New("shorted administrative request failed")
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // Best-effort close after bounded read.
	return responseBody(response)
}

func (b *frameBuilder) application(response map[string]any, q *query, section string) error {
	switch q.Operation {
	case "portfolio_positions", "portfolio_summary":
		return b.portfolio(response, q)
	case "sector_performance":
		return b.sectors(response)
	case "admin_jobs", "admin_issues", "admin_fleet":
		return b.adminJobs(response, q.Operation)
	case "screener":
		rows, readErr := records(response, "stocks")
		if readErr != nil {
			return readErr
		}
		if n, err := dataframe.Number(response["totalCount"]); err == nil && n > float64(len(rows)) {
			b.frame.Truncated = true
		}
	}
	return b.list(response, q.Operation, section)
}

func numeric(record map[string]any, key string) (float64, bool) {
	raw := lookup(record, key)
	if raw == nil {
		return 0, false
	}
	value, err := numberScalar(raw)
	if err != nil {
		return 0, false
	}
	n, err := dataframe.Number(value)
	return n, err == nil
}
func scalarNumber(n float64, known bool) any {
	if !known {
		return nil
	}
	return n
}

func (b *frameBuilder) portfolio(response map[string]any, q *query) error {
	positions, err := parsePositions(q.Args["positions"])
	if err != nil {
		return err
	}
	quotes, err := objectSection(response, "prices")
	if err != nil {
		return err
	}
	rows := make([]map[string]any, 0, len(positions))
	for _, p := range positions {
		quote, ok := quotes[p.StockCode].(map[string]any)
		if !ok {
			quote = map[string]any{}
		}
		rows = append(rows, portfolioPosition(quote, &p))
	}
	if q.Operation == "portfolio_summary" {
		return b.add(portfolioTotals(rows))
	}
	for _, row := range rows {
		if err := b.add(row); err != nil {
			return err
		}
	}
	return nil
}
func portfolioTotals(rows []map[string]any) map[string]any {
	value, change, known, changeKnown := 0.0, 0.0, 0, 0
	for _, row := range rows {
		if n, ok := numeric(row, "market_value"); ok {
			known++
			value += n
		}
		if n, ok := numeric(row, "day_change"); ok {
			changeKnown++
			change += n
		}
	}
	complete, dayComplete := known == len(rows), changeKnown == len(rows)
	return map[string]any{"market_value": scalarNumber(value, complete), "day_change": scalarNumber(change, dayComplete), "day_change_percent": scalarNumber(change/(value-change)*100, complete && dayComplete && value != change), "position_count": len(rows), "valued_positions": known, "complete": complete}
}

func portfolioPosition(quote map[string]any, p *position) map[string]any {
	closePrice, closeOK := numeric(quote, "close")
	change, changeOK := numeric(quote, "change")
	quantity := *p.Quantity
	row := map[string]any{"stock_code": p.StockCode, "quantity": quantity, "close": scalarNumber(closePrice, closeOK), "market_value": scalarNumber(closePrice*quantity, closeOK), "day_change": scalarNumber(change*quantity, changeOK), "day_change_percent": scalarNumber(change/(closePrice-change)*100, closeOK && changeOK && closePrice != change), "complete": closeOK}
	if p.Cost != nil {
		row["cost"] = *p.Cost
		row["cost_basis"] = *p.Cost * quantity
		row["gain"] = scalarNumber((closePrice-*p.Cost)*quantity, closeOK)
	}
	return row
}

type sector struct {
	name  string
	codes []string
}

var sourceSectors = []sector{
	{"Financials", []string{"CBA", "WBC", "ANZ", "NAB"}}, {"Materials", []string{"BHP", "RIO", "FMG", "NCM"}}, {"Healthcare", []string{"CSL", "COH", "SHL", "RMD"}}, {"Consumer Staples", []string{"WOW", "COL", "WES", "TWE"}}, {"Energy", []string{"WDS", "STO", "ORG", "OSH"}}, {"Technology", []string{"XRO", "WTC", "CPU", "APT"}},
}

func sectorCodes() []string {
	codes := make([]string, 0, 24)
	for _, s := range sourceSectors {
		codes = append(codes, s.codes...)
	}
	return codes
}

type performance struct {
	code   string
	change float64
}

func (b *frameBuilder) sectors(response map[string]any) error {
	quotes, err := objectSection(response, "prices")
	if err != nil {
		return err
	}
	for _, s := range sourceSectors {
		if err := b.add(sectorRow(quotes, s)); err != nil {
			return err
		}
	}
	return nil
}
func sectorRow(quotes map[string]any, s sector) map[string]any {
	total, volume, observed, volumes := 0.0, 0.0, 0, 0
	performances := make([]performance, 0, len(s.codes))
	for _, code := range s.codes {
		quote, ok := quotes[code].(map[string]any)
		if !ok {
			continue
		}
		if n, valid := numeric(quote, "change_percent"); valid {
			observed++
			total += n
			performances = append(performances, performance{code, n})
		}
		if n, valid := numeric(quote, "volume"); valid {
			volumes++
			volume += n
		}
	}
	slices.SortFunc(performances, func(a, b performance) int {
		if a.change > b.change {
			return -1
		}
		if a.change < b.change {
			return 1
		}
		return strings.Compare(a.code, b.code)
	})
	return map[string]any{"sector": s.name, "performance": scalarNumber(total/float64(len(s.codes)), observed == len(s.codes)), "volume": scalarNumber(volume, volumes == len(s.codes)), "expected_stocks": len(s.codes), "observed_stocks": observed, "complete": observed == len(s.codes), "top_gainers": performanceNames(performances[:min(2, len(performances))]), "top_losers": performanceNames(performances[max(0, len(performances)-2):])}
}
func performanceNames(items []performance) string {
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, item.code)
	}
	return strings.Join(names, ", ")
}

func (b *frameBuilder) adminJobs(response map[string]any, operation string) error {
	jobs, err := records(response, "jobs")
	if err != nil {
		return err
	}
	stale := response["stale"] == true
	if operation == "admin_fleet" {
		return b.add(fleetRow(jobs, stale))
	}
	for _, job := range jobs {
		if operation == "admin_issues" && (job["retired"] == true || !slices.Contains([]any{"critical", "overdue", "warning"}, job["health"])) {
			continue
		}
		job["stale"] = stale
		if err := b.add(job); err != nil {
			return err
		}
	}
	return nil
}
func fleetRow(jobs []map[string]any, stale bool) map[string]any {
	active, retired, critical, overdue, warning := 0, 0, 0, 0, 0
	for _, job := range jobs {
		if job["retired"] == true {
			retired++
			continue
		}
		active++
		switch job["health"] {
		case "critical":
			critical++
		case "overdue":
			overdue++
		case "warning":
			warning++
		}
	}
	status := "healthy"
	if warning > 0 || stale {
		status = "degraded"
	}
	if critical+overdue > 0 {
		status = "critical"
	}
	return map[string]any{"status": status, "active_jobs": active, "critical_jobs": critical, "overdue_jobs": overdue, "warning_jobs": warning, "retired_jobs": retired, "stale": stale}
}

func adminPath(path string, args map[string]any) string {
	values := url.Values{}
	for key, value := range args {
		switch v := value.(type) {
		case string:
			if v != "" {
				values.Set(key, v)
			}
		case bool:
			values.Set(key, strconv.FormatBool(v))
		case float64:
			values.Set(key, strconv.FormatFloat(v, 'f', 0, 64))
		}
	}
	if len(values) > 0 {
		return path + "?" + values.Encode()
	}
	return path
}
