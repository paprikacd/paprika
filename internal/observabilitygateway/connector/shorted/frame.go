package shorted

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benebsworth/paprika/internal/dataframe"
)

type field struct{ dataframe.Column }

func fields(specs ...string) []field {
	result := make([]field, 0, len(specs))
	for _, spec := range specs {
		parts := strings.Split(spec, ":")
		column := dataframe.Column{Key: parts[0], Label: strings.ReplaceAll(parts[0], "_", " "), Type: parts[1]}
		if len(parts) > 2 {
			column.Unit = parts[2]
		}
		result = append(result, field{Column: column})
	}
	return result
}

func shortFields() []field {
	return fields("product_code:string", "name:string", "industry:string", "timestamp:timestamp", "short_position:number:percent", "reported_short_positions:number:shares", "total_product_in_issue:number:shares", "available_from:timestamp")
}

func priceFields(timestamp string) []field {
	return fields("stock_code:string", timestamp+":timestamp", "open:number:AUD", "high:number:AUD", "low:number:AUD", "close:number:AUD", "adjusted_close:number:AUD", "volume:number:shares", "change:number:AUD", "change_percent:number:percent")
}

func industryFields(name string) []field {
	switch name {
	case "industry_sources":
		return fields("source_key:string", "display_name:string", "signal_kind:string", "publisher:string", "source_url:string", "licence:string", "cadence:string")
	case "industry_time_buckets":
		return fields("signal_kind:string", "source_key:string", "metric_key:string", "metric_label:string", "unit:string", "bucket_label:string", "bucket_start:timestamp", "total_value:number", "record_count:number", "entity_count:number", "zero_value_count:number")
	case "industry_entity_totals":
		return fields("signal_kind:string", "source_key:string", "metric_key:string", "stock_code:string", "entity_label:string", "unit:string", "total_value:number", "record_count:number", "latest_as_of:timestamp")
	default:
		return fields("source_key:string", "source_record_id:string", "signal_kind:string", "industry:string", "stock_code:string", "entity_abn:string", "metric_key:string", "metric_label:string", "has_metric_value:boolean", "metric_value:number", "unit:string", "period_start:timestamp", "period_end:timestamp", "as_of:timestamp", "title:string", "summary:string", "source_url:string", "confidence:number")
	}
}

type frameBuilder struct {
	frame   dataframe.Frame
	limit   int
	filters map[string]string
}

func decodeFrame(raw []byte, q *query, op *operation, limit int) (dataframe.Frame, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var response map[string]any
	if err := d.Decode(&response); err != nil || response == nil {
		return dataframe.Frame{}, errors.New("shorted response is not an object")
	}
	if _, ok := response["code"]; ok {
		return dataframe.Frame{}, errors.New("shorted response contains a protocol error")
	}
	b := frameBuilder{frame: dataframe.Frame{Columns: make([]dataframe.Column, 0, len(op.fields)), Rows: make([][]any, 0)}, limit: limit, filters: localFilters(q.Args)}
	for _, f := range op.fields {
		b.frame.Columns = append(b.frame.Columns, f.Column)
	}
	if response["downsampled"] == true {
		b.frame.Truncated = true
	}
	err := b.populate(response, q, op.section)
	return b.frame, err
}

func (b *frameBuilder) populate(response map[string]any, q *query, section string) error {
	switch q.Operation {
	case "stock_details":
		return b.add(response)
	case "top_shorts":
		return b.top(response)
	case "market_quotes":
		return b.quotes(response)
	case "market_correlations":
		return b.correlations(response)
	default:
		return b.application(response, q, section)
	}
}

func (b *frameBuilder) add(record map[string]any) error {
	if !b.matches(record) {
		return nil
	}
	if len(b.frame.Rows) >= b.limit {
		b.frame.Truncated = true
		return nil
	}
	row := make([]any, 0, len(b.frame.Columns))
	for _, column := range b.frame.Columns {
		value, err := scalar(lookup(record, column.Key), column.Type)
		if err != nil {
			return err
		}
		if s, ok := value.(string); ok && len(s) > dataframe.MaxCellBytes {
			s = s[:dataframe.MaxCellBytes]
			for !utf8.ValidString(s) {
				s = s[:len(s)-1]
			}
			value = s
			b.frame.Truncated = true
		}
		row = append(row, value)
	}
	b.frame.Rows = append(b.frame.Rows, row)
	return nil
}

func lookup(record map[string]any, key string) any {
	if value, ok := record[camel(key)]; ok {
		return value
	}
	return record[key]
}

func scalar(value any, kind string) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch kind {
	case "string":
		if s, ok := value.(string); ok {
			return s, nil
		}
	case "boolean":
		if v, ok := value.(bool); ok {
			return v, nil
		}
	case "number":
		return numberScalar(value)
	case "timestamp":
		return timestamp(value)
	}
	return nil, errors.New("shorted response field has an invalid scalar type")
}

func numberScalar(value any) (any, error) {
	var number any
	switch n := value.(type) {
	case json.Number:
		number = n
	case string:
		number = json.Number(n)
	case int:
		number = n
	case float64:
		number = n
	}
	if _, err := dataframe.Number(number); err != nil {
		return nil, errors.New("shorted response number is invalid")
	}
	return number, nil
}

func timestamp(value any) (any, error) {
	if s, ok := value.(string); ok {
		if s == "" {
			return nil, nil
		}
		for _, format := range []string{time.RFC3339Nano, "2006-01-02"} {
			if t, err := time.Parse(format, s); err == nil {
				return t.UTC().Format(time.RFC3339Nano), nil
			}
		}
	}
	return timestampObject(value)
}

// Some market-data deployments emit protobuf timestamps as seconds/nanos.
func timestampObject(value any) (any, error) {
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("shorted response timestamp is invalid")
	}
	secs, ok := integer(obj["seconds"])
	nanos, nanoOK := integer(obj["nanos"])
	if obj["nanos"] == nil {
		nanos = 0
		nanoOK = true
	}
	if !ok || !nanoOK || nanos < 0 || nanos >= 1e9 || secs < -62135596800 || secs > 253402300799 {
		return nil, errors.New("shorted response timestamp is invalid")
	}
	return time.Unix(secs, nanos).UTC().Format(time.RFC3339Nano), nil
}

func integer(value any) (int64, bool) {
	var s string
	switch v := value.(type) {
	case string:
		s = v
	case json.Number:
		s = string(v)
	default:
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil
}

func records(response map[string]any, key string) ([]map[string]any, error) {
	value := lookup(response, key)
	if value == nil {
		return nil, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, errors.New("shorted response section is not an array")
	}
	out := make([]map[string]any, 0, len(list))
	for _, v := range list {
		record, ok := v.(map[string]any)
		if !ok {
			return nil, errors.New("shorted response row is not an object")
		}
		out = append(out, record)
	}
	return out, nil
}

func (b *frameBuilder) list(response map[string]any, name, section string) error {
	rows, err := records(response, section)
	if err != nil {
		return err
	}
	for _, row := range rows {
		switch name {
		case "stock_history":
			inherit(row, response, "product_code", "name", "industry")
		case "stock_prices":
			row["stock_code"] = lookup(response, "product_code")
			row["timestamp"] = lookup(row, "date")
		case "market_history":
			row["timestamp"] = lookup(row, "date")
		case "industry_records":
			if lookup(row, "has_metric_value") != true {
				row["metricValue"] = nil
			} else if lookup(row, "metric_value") == nil {
				row["metricValue"] = 0
			}
		}
		if err := b.add(row); err != nil {
			return err
		}
	}
	return nil
}

func inherit(row, parent map[string]any, keys ...string) {
	for _, key := range keys {
		row[key] = lookup(parent, key)
	}
}

func (b *frameBuilder) top(response map[string]any) error {
	stocks, err := records(response, "timeSeries")
	if err != nil {
		return err
	}
	for _, stock := range stocks {
		points, err := records(stock, "points")
		if err != nil {
			return err
		}
		if stock["downsampled"] == true {
			b.frame.Truncated = true
		}
		if len(points) == 0 {
			stock["short_position"] = lookup(stock, "latest_short_position")
			if err := b.add(stock); err != nil {
				return err
			}
			continue
		}
		for _, point := range points {
			inherit(point, stock, "product_code", "name", "industry")
			if err := b.add(point); err != nil {
				return err
			}
		}
	}
	return nil
}

func objectSection(response map[string]any, key string) (map[string]any, error) {
	value := lookup(response, key)
	if value == nil {
		return map[string]any{}, nil
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("shorted response section is not an object")
	}
	return obj, nil
}

func sortedKeys(obj map[string]any) []string {
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (b *frameBuilder) quotes(response map[string]any) error {
	prices, err := objectSection(response, "prices")
	if err != nil {
		return err
	}
	for _, code := range sortedKeys(prices) {
		row, ok := prices[code].(map[string]any)
		if !ok {
			return errors.New("shorted quote is not an object")
		}
		if lookup(row, "stock_code") == nil {
			row["stock_code"] = code
		}
		row["timestamp"] = lookup(row, "date")
		if err := b.add(row); err != nil {
			return err
		}
	}
	return nil
}

func (b *frameBuilder) correlations(response map[string]any) error {
	outer, err := objectSection(response, "correlations")
	if err != nil {
		return err
	}
	for _, code := range sortedKeys(outer) {
		row, ok := outer[code].(map[string]any)
		if !ok {
			return errors.New("shorted correlation row is not an object")
		}
		inner, err := objectSection(row, "correlations")
		if err != nil {
			return err
		}
		for _, other := range sortedKeys(inner) {
			if err := b.add(map[string]any{"stock_code": code, "other_stock_code": other, "correlation": inner[other]}); err != nil {
				return err
			}
		}
	}
	return nil
}
