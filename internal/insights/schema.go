package insights

import (
	"encoding/json"
	"errors"
	"net/http"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

const maxSchemaResponseBytes = 64 << 10

type authoringSchemaResponse struct {
	SchemaVersion int               `json:"schemaVersion"`
	Kind          string            `json:"kind"`
	Schema        json.RawMessage   `json:"schema"`
	Examples      []json.RawMessage `json:"examples"`
	Notes         []string          `json:"notes"`
}

const schemaWidgetExample = `{"id":"request-rate","title":"Request rate","type":"stat","providerId":"metrics-provider-id","query":"sum(rate(http_requests_total{service={{service}}}[5m]))","unit":"req/s","queryRef":{"id":"service-request-rate","bindings":[{"parameter":"service","source":"variable","variable":"service"}]},"options":{"decimals":2,"showSparkline":true},"layout":{"x":0,"y":0,"w":4,"h":2}}`
const schemaSavedQueryExample = `{"schemaVersion":1,"id":"service-request-rate","name":"Service request rate","description":"Requests per second for the selected service.","tags":["service","requests"],"metadata":{"signal":"request-rate"},"providerId":"metrics-provider-id","kind":"metrics","query":"sum(rate(http_requests_total{service={{service}}}[5m]))","parameters":[{"name":"service","type":"string","defaultValue":"checkout"}]}`
const schemaDashboardExample = `{"schemaVersion":1,"id":"service-overview","title":"Service overview","timeRange":"1h","refreshInterval":30,"variables":[{"name":"service","label":"Service","defaultValue":"checkout","options":["checkout","payments"]}],"widgets":[` + schemaWidgetExample + `]}`
const schemaRecordWidgetExample = `{"id":"service-records","title":"Service records","type":"plugin","pluginId":"record-table","dataKind":"records","config":{"pageSize":20,"density":"compact","showSearch":false},"providerId":"records-provider-id","query":"SELECT service, requests FROM reporting.service_summary","unit":"","queryRef":{"id":"service-records","bindings":[{"parameter":"service","source":"variable","variable":"service"}]},"layout":{"x":0,"y":2,"w":12,"h":5}}`
const schemaRecordQueryExample = `{"schemaVersion":1,"id":"service-records","name":"Service records","providerId":"records-provider-id","kind":"records","query":"{\"sql\":\"SELECT service, requests FROM reporting.service_summary WHERE service=$1\",\"parameters\":[{{service}}]}","parameters":[{"name":"service","type":"string","defaultValue":"checkout"}]}`
const schemaStackedWidgetExample = `{"id":"namespace-cpu","title":"CPU by namespace","type":"plugin","pluginId":"stacked-timeseries","dataKind":"metrics","providerId":"metrics-provider-id","query":"sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=\"\",container!=\"POD\"}[5m]))","unit":"cores","config":{"display":"area","maxSeries":8,"maxPoints":120,"legendDisplay":"table","legendPosition":"right"},"options":{"decimals":2,"showLegend":true,"showGrid":true,"showTooltip":true},"layout":{"x":0,"y":2,"w":8,"h":4}}`
const schemaGaugeBankExample = `{"id":"node-cpu","title":"CPU by node","type":"plugin","pluginId":"threshold-gauge","dataKind":"metrics","providerId":"metrics-provider-id","query":"100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode=\"idle\"}[5m])))","unit":"%","config":{"display":"radial","seriesMode":"all","columns":3,"maxSeries":6,"showThresholds":false},"options":{"min":0,"max":100,"decimals":1,"showLegend":false,"thresholds":[{"value":0,"color":"#53876a","label":"Normal"},{"value":70,"color":"#b29658","label":"Elevated"},{"value":90,"color":"#b64a3a","label":"High"}]},"layout":{"x":8,"y":2,"w":4,"h":4}}`
const schemaDistributionExample = `{"id":"request-latency","title":"Request latency distribution","type":"plugin","pluginId":"distribution-heatmap","dataKind":"metrics","providerId":"metrics-provider-id","query":"sum by (le) (rate(http_request_duration_seconds_bucket[5m]))","unit":"s","config":{"bucketLabel":"le","bucketUnit":"s","densityUnit":"observations/s","aggregation":"none","maxBuckets":24,"maxColumns":60},"options":{"decimals":2,"showLegend":true,"showTooltip":true},"layout":{"x":0,"y":6,"w":8,"h":4}}`
const schemaConnectionMapExample = `{"id":"request-locations","title":"Request locations","type":"plugin","pluginId":"connection-map","dataKind":"records","providerId":"records-provider-id","query":"{\"sql\":\"SELECT latitude, longitude, location, requests FROM reporting.locations\"}","unit":"requests","config":{"latitude":"latitude","longitude":"longitude","label":"location","value":"requests","maxPoints":120},"options":{"decimals":0,"showTooltip":true},"layout":{"x":8,"y":6,"w":4,"h":4}}`

func (s *Server) getAuthoringSchema(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	schema, err := insightsschema.Document(kind)
	if errors.Is(err, insightsschema.ErrUnknownKind) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "authoring schema is unavailable")
		return
	}
	response := authoringSchemaResponse{
		SchemaVersion: 1, Kind: kind, Schema: schema,
		Examples: authoringSchemaExamples(kind),
		Notes: []string{
			"Examples are illustrative documents, not live telemetry. Replace metrics-provider-id using list_insights_providers and discover metric and label names before querying.",
			"The service additionally validates semantic rules, references, unique identifiers, typed bindings, query literal boundaries and plugin configuration. JSON Schema alone does not express every runtime check.",
			"Examples containing queryRef require their corresponding saved_query example first: service-request-rate or service-records. Widget queryRef is authoritative; unavailable references fail without falling back to the required query field. Rich-chart examples without queryRef use explicit illustrative queries; discover the real provider's metrics, labels or records columns before adapting them.",
			"Use get_dashboard or get_saved_query before editing. Preserve unchanged fields and supply the exact current ETag when updating.",
			"Records examples require a records-capable provider from list_insights_providers and a dashboard service variable. The SQL example needs a PostgreSQL provider with reader access to your reporting view; replace the illustrative table and columns. Bind SQL values with $1 and an unquoted {{service}} in the JSON parameters array, never inside the SQL body.",
			"Built-in records plugins use type=plugin and dataKind=records: record-table config {columns?:string[1..64],pageSize?:5..100,density?:compact|comfortable,showSearch?:boolean,cellStyles?:[{column:string,display:bar|color-text|color-background,min?:number,max?:number}]}; defaults are 20 rows, comfortable density and search shown. Compact rows preserve sorting and selection. Up to 16 unique numeric result columns may have cell styles. Bar cells require explicit finite min<max; signed scales anchor at zero, filtering never rescales bars, and out-of-scale values retain their exact reading. Color modes use widget options.thresholds or widget.color; backgrounds choose readable text. Nulls remain unknown. Only bar styles accept min/max. Other records plugins: record-list {title:string,body?:string,subtitle?:string,url?:string,status?:string}; record-treemap {label:string,value:string,group?:string}; record-matrix {x:string,y:string,value:string,min?:number,max?:number}. Config strings name result columns, not expressions.",
			"Record charts: records-line and records-bar config {x:string,y:string[],group?:string,rightAxis?:string[],annotations?:[{x:string|number,label:string}]}; y contains 1..8 numeric columns and rightAxis is a subset. Metric plugins include pie {donut?:boolean} and status-history {maxSeries?:1..24,maxPoints?:8..120}; use dataKind=metrics for those.",
			"Rich metric plugins use type=plugin and dataKind=metrics. stacked-timeseries config {display?:area|bar,maxSeries?:1..12,maxPoints?:12..240,legendDisplay?:compact|table,legendPosition?:bottom|right}; defaults are area, 8 series, 120 points, compact legend below. Input series must be timestamp-aligned additive observations; positive and negative values stack separately. Missing observations leave gaps rather than inventing a complete total.",
			"directional-traffic config {directionLabel?:string,outboundValue?:string,maxSeries?:1..12,maxPoints?:12..240,legendDisplay?:compact|table,legendPosition?:bottom|right}; defaults are direction, outbound, 8 series, 120 points, compact legend below. Input observations must be nonnegative; series whose direction label equals outboundValue are drawn below zero while inspection retains the original positive value. Other series remain above zero. Label fields use metric label names, not expressions.",
			"Stacked and directional table legends show Current, Mean and Max from all returned valid-timestamp observations before display downsampling. Current is the latest raw observation, including unknown; Mean is the arithmetic mean of finite samples, not a time-weighted average; Max is the maximum finite sample. Statistics never use cumulative stack heights or direction-negated display values. A right legend moves below the plot in widgets narrower than 680px.",
			"distribution-heatmap config {bucketLabel?:string,bucketUnit?:string,densityUnit?:string,group?:{label:string},aggregation?:none|sum,maxBuckets?:1..48,maxColumns?:8..120}; defaults are le, widget unit, observations/s, no group filter, none, 24 buckets and 60 columns. Input must contain cumulative histogram buckets, including numeric bucket boundaries or +Inf. Use query-side rates when densityUnit is per second; this chart only differences adjacent buckets. Multiple histogram groups require exact group labels or explicit sum, and summed groups must have identical boundaries. Group accepts at most 8 exact label matches. Non-monotonic/negative or missing bucket observations remain unknown.",
			"threshold-gauge config {label?:string,display?:linear|segmented|radial,orientation?:horizontal|vertical,segments?:8..60,showThresholds?:boolean,seriesMode?:first|all,columns?:1..12,maxSeries?:1..12}; defaults are linear, horizontal, 24 segments, threshold labels shown, first series and at most 6 gauges. Horizontal bars align label, track and value; vertical bars fill bottom-up. Orientation does not alter radial arcs. All-series banks default to 3 columns for radial, 4 for vertical bars and 1 for horizontal rows; narrow panels wrap. Segmented tracks use a continuous threshold scale when four-pixel cells cannot fit. Use widget options.min/max for the scale, options.thresholds for colored limits, options.decimals for display precision and options.showLegend for shared bank bounds/threshold labels. Each gauge uses its own latest observation, including unknown; hidden series are disclosed. Full labels and exact observations remain accessible when compact labels are ellipsized.",
			"connection-map uses dataKind=records with config {latitude?:string,longitude?:string,label?:string,value?:string,status?:string,showLocations?:boolean,maxPoints?:1..500}; coordinate/label defaults are latitude, longitude, label and maxPoints defaults to 120. Latitude and longitude must be numeric degrees within [-90,90] and [-180,180]; optional value must be numeric. Positions come only from returned coordinates, never inferred from IP addresses. Invalid coordinates and omitted rows are disclosed. Set showLocations=false for a map-only view; exact point inspection remains available and geographic proportions are preserved.",
			"pipeline-topology uses dataKind=records with config {source?:string,target?:string,value?:string,status?:string,maxNodes?:2..64,maxEdges?:1..200}; defaults are source, target, 32 nodes and 80 edges. Source/target fields name stages; optional value must be numeric. Duplicate source/target pairs aggregate finite values only when every contributing row is finite, otherwise the value is unknown. Cycles remain explicit and limits disclose omitted nodes/edges.",
			"incident-calendar uses dataKind=records with config {date?:string,value?:string,label?:string,status?:string,aggregation?:count|sum|max,months?:1..6,endDate?:YYYY-MM-DD}; defaults are date, count and 3 months ending at the latest returned date. Dates use UTC and must be valid calendar dates or ISO timestamps; numeric dates are Unix milliseconds. Sum/max require a numeric value field, while count counts observed rows. Days without observations stay unknown rather than becoming zero. Explicit endDate controls the visible UTC month window.",
		},
	}
	encoded, err := json.Marshal(response)
	if err != nil || len(encoded) > maxSchemaResponseBytes {
		writeError(w, http.StatusInternalServerError, "authoring schema exceeds its response limit")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(encoded); err != nil {
		return // A disconnected client cannot receive a replacement response.
	}
}

func authoringSchemaExamples(kind string) []json.RawMessage {
	examples := []json.RawMessage{authoringSchemaExample(kind)}
	switch kind {
	case "widget":
		return append(examples, json.RawMessage(schemaRecordWidgetExample), json.RawMessage(schemaStackedWidgetExample), json.RawMessage(schemaGaugeBankExample), json.RawMessage(schemaDistributionExample), json.RawMessage(schemaConnectionMapExample))
	case "saved_query":
		return append(examples, json.RawMessage(schemaRecordQueryExample))
	default:
		return examples
	}
}

func authoringSchemaExample(kind string) json.RawMessage {
	switch kind {
	case "dashboard":
		return json.RawMessage(schemaDashboardExample)
	case "widget":
		return json.RawMessage(schemaWidgetExample)
	default:
		return json.RawMessage(schemaSavedQueryExample)
	}
}
