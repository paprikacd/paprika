package shorted

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

type operation struct {
	path       string
	args       []string
	defaults   map[string]any
	marketData bool
	admin      bool
	section    string
	fields     []field
}

const marketService = "/shorts.v1alpha1.MarketService/"
const stockService = "/shorts.v1alpha1.StockService/"
const industryService = "/shorts.v1alpha1.IndustryIntelligenceService/GetIndustryIntelligence"
const priceService = "/marketdata.v1.MarketDataService/"

func operations() map[string]operation {
	ops := map[string]operation{
		"top_shorts":          {path: marketService + "GetTopShorts", args: []string{"period", "limit", "offset", "summary_only", "product_codes"}, defaults: map[string]any{"period": "3M", "limit": 30, "summary_only": true}, section: "timeSeries", fields: shortFields()},
		"industry_treemap":    {path: marketService + "GetIndustryTreeMap", args: []string{"period", "limit", "view_mode"}, defaults: map[string]any{"period": "3M", "limit": 10, "view_mode": "CURRENT_CHANGE"}, section: "stocks", fields: fields("industry:string", "product_code:string", "short_position:number:percent")},
		"stock_history":       {path: stockService + "GetStockData", args: []string{"product_code", "period", "from", "to", "as_of", "full_resolution", "max_points"}, defaults: map[string]any{"period": "3M", "max_points": maxRows}, section: "points", fields: shortFields()},
		"stock_prices":        {path: stockService + "GetStockPrices", args: []string{"product_code", "period", "from", "to", "max_points"}, defaults: map[string]any{"period": "3M", "max_points": maxRows}, section: "points", fields: priceFields("timestamp")},
		"stock_details":       {path: stockService + "GetStockDetails", args: []string{"product_code"}, fields: fields("product_code:string", "company_name:string", "industry:string", "summary:string", "website:string", "logo_gcs_url:string", "logo_icon_gcs_url:string")},
		"market_quotes":       {path: priceService + "GetMultipleStockPrices", args: []string{"stock_codes"}, marketData: true, section: "prices", fields: priceFields("timestamp")},
		"market_history":      {path: priceService + "GetHistoricalPrices", args: []string{"stock_code", "period", "interval"}, defaults: map[string]any{"period": "3m", "interval": "1d"}, marketData: true, section: "prices", fields: priceFields("timestamp")},
		"market_correlations": {path: priceService + "GetStockCorrelations", args: []string{"stock_codes", "period"}, defaults: map[string]any{"period": "3m"}, marketData: true, section: "correlations", fields: fields("stock_code:string", "other_stock_code:string", "correlation:number")},
		"market_news":         {path: "/shorts.v1alpha1.NewsService/GetMarketNews", args: []string{"limit", "source", "price_sensitive_only"}, defaults: map[string]any{"limit": 20}, section: "articles", fields: fields("id:string", "stock_code:string", "source:string", "headline:string", "url:string", "published_at:timestamp", "sentiment:string", "relevance_score:number", "is_price_sensitive:boolean", "summary:string", "image_url:string", "syndication_count:number")},
	}
	for name, section := range map[string]string{"industry_records": "records", "industry_time_buckets": "timeBuckets", "industry_entity_totals": "entityTotals", "industry_sources": "sources"} {
		ops[name] = operation{path: industryService, args: []string{"industry", "record_limit", "stock_code", "signal_kind", "metric_key"}, defaults: map[string]any{"record_limit": 50}, section: section, fields: industryFields(name)}
	}
	addApplicationOperations(ops)
	return ops
}

func prepare(raw string, signal connector.Signal) (query, operation, []byte, error) {
	q, err := decodeQuery(raw, signal)
	if err != nil {
		return q, operation{}, nil, err
	}
	op, ok := operations()[q.Operation]
	if !ok {
		return q, op, nil, errors.New("shorted operation is not supported")
	}
	if (signal == connector.SignalMetrics) != (q.Projection != nil) {
		return q, op, nil, errors.New("metrics require a projection; records must omit projection")
	}
	if projectionErr := validateProjection(q.Projection, &op); projectionErr != nil {
		return q, op, nil, projectionErr
	}
	args, err := buildArgs(q.Args, q.Operation, &op)
	if err != nil {
		return q, op, nil, err
	}
	adaptNativeArgs(q.Operation, args)
	body, err := json.Marshal(args)
	if err != nil {
		return q, op, nil, errors.New("shorted arguments cannot be encoded")
	}
	return q, op, body, nil
}

func decodeQuery(raw string, signal connector.Signal) (query, error) {
	var q query
	if strings.TrimSpace(raw) == "" {
		q.Operation = "top_shorts"
		q.Args = map[string]json.RawMessage{"limit": json.RawMessage("1")}
		if signal == connector.SignalMetrics {
			q.Projection = &dataframe.Projection{Value: "short_position", Labels: []string{"product_code"}}
		}
		return q, nil
	}
	if len(raw) > maxQueryBytes || decodeStrict([]byte(raw), &q) != nil {
		return q, errors.New("shorted query must be a bounded JSON object with operation, args and optional projection")
	}
	return q, nil
}

func validateProjection(projection *dataframe.Projection, op *operation) error {
	if projection == nil {
		return nil
	}
	frame := dataframe.Frame{Rows: make([][]any, 0)}
	for _, f := range op.fields {
		frame.Columns = append(frame.Columns, f.Column)
	}
	if _, err := dataframe.Prometheus(&frame, *projection, time.Time{}); err != nil {
		return errors.New("shorted projection does not match the operation columns")
	}
	return nil
}

func buildArgs(raw map[string]json.RawMessage, name string, op *operation) (map[string]any, error) {
	args := map[string]any{}
	for k, v := range op.defaults {
		args[camel(k)] = v
	}
	for key, value := range raw {
		if !slices.Contains(op.args, key) {
			return nil, errors.New("shorted operation contains an unsupported argument")
		}
		parsed, err := parseArg(key, value)
		if err != nil {
			return nil, err
		}
		args[camel(key)] = parsed
	}
	if err := validateArgs(name, args); err != nil {
		return nil, err
	}
	return args, nil
}

var stockCode = regexp.MustCompile(`^[A-Z0-9]{2,6}$`)

func parseArg(key string, raw json.RawMessage) (any, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("shorted arguments cannot be null")
	}
	switch key {
	case "limit", "offset", "record_limit", "max_points":
		return numberArg(key, raw)
	case "summary_only", "full_resolution", "price_sensitive_only", "exclude_local":
		var value bool
		if json.Unmarshal(raw, &value) != nil {
			return nil, errors.New("shorted boolean argument has an invalid type")
		}
		return value, nil
	case "positions":
		return parsePositions(raw)
	case "product_codes", "stock_codes":
		return codesArg(raw)
	default:
		return stringArg(key, raw)
	}
}

func numberArg(key string, raw json.RawMessage) (any, error) {
	var n int
	if json.Unmarshal(raw, &n) != nil || n < 0 || n > argMaximum(key) || (key != "offset" && n == 0) {
		return nil, errors.New("shorted numeric argument is outside its allowed bounds")
	}
	return n, nil
}

func codesArg(raw json.RawMessage) (any, error) {
	var codes []string
	if json.Unmarshal(raw, &codes) != nil || len(codes) == 0 || len(codes) > 50 {
		return nil, errors.New("shorted stock list must contain 1 to 50 codes")
	}
	seen := map[string]bool{}
	for i, code := range codes {
		codes[i] = strings.ToUpper(code)
		if !stockCode.MatchString(codes[i]) || seen[codes[i]] {
			return nil, errors.New("shorted stock list contains an invalid or duplicate code")
		}
		seen[codes[i]] = true
	}
	return codes, nil
}

func argMaximum(key string) int {
	switch key {
	case "offset":
		return 10000
	case "max_points":
		return maxRows
	case "record_limit":
		return 200
	default:
		return 100
	}
}

func parseStringArg(key, s string) (string, error) {
	switch key {
	case "stock_code", "product_code":
		s = strings.ToUpper(s)
		if !stockCode.MatchString(s) {
			return "", errors.New("shorted stock code is invalid")
		}
	case "from", "to", "as_of":
		if _, err := time.Parse("2006-01-02", s); err != nil {
			return "", errors.New("shorted date argument must be YYYY-MM-DD")
		}
	case "signal_kind", "metric_key":
		if !fieldFilter.MatchString(s) {
			return "", errors.New("shorted field filter is invalid")
		}
	case "industry", "source":
		if strings.TrimSpace(s) == "" {
			return "", errors.New("shorted text filter must not be blank")
		}
	default:
		return enumArg(key, s)
	}
	return s, nil
}

func enumArg(key, s string) (string, error) {
	values := map[string][]string{
		"period":    {"1d", "1w", "1m", "3m", "6m", "1y", "2y", "5y", "10y", "max"},
		"view_mode": {"CURRENT_CHANGE", "PERCENTAGE_CHANGE"}, "interval": {"1d"},
		"environment":    {"production", "development", ""},
		"sort_field":     {"SCREENER_SORT_FIELD_SHORT_PCT", "SCREENER_SORT_FIELD_SHORT_PCT_CHANGE", "SCREENER_SORT_FIELD_MARKET_CAP", "SCREENER_SORT_FIELD_PRICE_CHANGE_1M", "SCREENER_SORT_FIELD_PE_RATIO", "SCREENER_SORT_FIELD_DIVIDEND_YIELD", "SCREENER_SORT_FIELD_NEWS_SENTIMENT", "SCREENER_SORT_FIELD_DAYS_TO_COVER"},
		"sort_direction": {"SORT_DIRECTION_DESC", "SORT_DIRECTION_ASC"},
	}
	value := s
	if key == "period" {
		value = strings.ToLower(s)
	}
	if !slices.Contains(values[key], value) {
		return "", errors.New("shorted string choice is unsupported")
	}
	return s, nil
}

func validateArgs(name string, args map[string]any) error {
	for _, key := range requiredArgs(name) {
		if _, ok := args[key]; !ok {
			return errors.New("shorted operation is missing a required argument")
		}
	}
	if err := normalizePeriod(name, args); err != nil {
		return err
	}
	if err := validateDates(args); err != nil {
		return err
	}
	if name == "top_shorts" {
		return validateTopArgs(args)
	}
	codes, hasCodes := args["stockCodes"].([]string)
	if name == "market_correlations" && hasCodes && len(codes) > 10 {
		return errors.New("shorted correlations allow at most ten stocks")
	}
	return nil
}

func normalizePeriod(name string, args map[string]any) error {
	period, ok := args["period"].(string)
	if !ok {
		return nil
	}
	if strings.HasPrefix(name, "market_") {
		period = strings.ToLower(period)
		if !slices.Contains([]string{"1d", "1w", "1m", "3m", "6m", "1y", "2y"}, period) {
			return errors.New("shorted market-data period exceeds two years")
		}
	} else {
		period = strings.ToUpper(period)
	}
	if name == "market_correlations" && !slices.Contains([]string{"1m", "3m", "6m", "1y"}, period) {
		return errors.New("shorted correlation period must be 1m, 3m, 6m or 1y")
	}
	args["period"] = period
	return nil
}

func validateDates(args map[string]any) error {
	from, hasFrom := args["from"].(string)
	to, hasTo := args["to"].(string)
	if hasTo && !hasFrom {
		return errors.New("shorted to requires from")
	}
	if hasTo && to < from {
		return errors.New("shorted date range is reversed")
	}
	return nil
}

func requiredArgs(name string) []string {
	switch name {
	case "stock_history", "stock_prices", "stock_details":
		return []string{"productCode"}
	case "market_history":
		return []string{"stockCode"}
	case "portfolio_positions", "portfolio_summary":
		return []string{"positions"}
	case "market_quotes", "market_correlations":
		return []string{"stockCodes"}
	default:
		return nil
	}
}

func validateTopArgs(args map[string]any) error {
	if args["summaryOnly"] == true {
		return nil
	}
	if limit, ok := args["limit"].(int); ok && limit > 20 {
		args["limit"] = 20
	}
	if codes, ok := args["productCodes"].([]string); ok && len(codes) > 20 {
		return errors.New("shorted top-shorts history allows at most twenty stocks")
	}
	period, ok := args["period"].(string)
	if !ok || !slices.Contains([]string{"1D", "1W", "1M", "3M", "6M", "1Y", "2Y"}, period) {
		return errors.New("shorted top-shorts history is bounded to two years")
	}
	return nil
}

func camel(key string) string {
	parts := strings.Split(key, "_")
	for i := 1; i < len(parts); i++ {
		parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
	}
	return strings.Join(parts, "")
}

func stringArg(key string, raw json.RawMessage) (any, error) {
	var value string
	if json.Unmarshal(raw, &value) != nil || len(value) > 160 || strings.ContainsAny(value, "\x00\r\n") {
		return nil, errors.New("shorted string argument is invalid")
	}
	return parseStringArg(key, value)
}
