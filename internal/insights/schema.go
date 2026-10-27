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
const schemaRecordWidgetExample = `{"id":"service-records","title":"Service records","type":"plugin","pluginId":"record-table","dataKind":"records","config":{"pageSize":20},"providerId":"records-provider-id","query":"SELECT service, requests FROM reporting.service_summary","unit":"","queryRef":{"id":"service-records","bindings":[{"parameter":"service","source":"variable","variable":"service"}]},"layout":{"x":0,"y":2,"w":12,"h":5}}`
const schemaRecordQueryExample = `{"schemaVersion":1,"id":"service-records","name":"Service records","providerId":"records-provider-id","kind":"records","query":"{\"sql\":\"SELECT service, requests FROM reporting.service_summary WHERE service=$1\",\"parameters\":[{{service}}]}","parameters":[{"name":"service","type":"string","defaultValue":"checkout"}]}`

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
			"Create service-request-rate from the saved_query example before using the widget or dashboard example. Widget queryRef is authoritative; unavailable references fail without falling back to the required query field.",
			"Use get_dashboard or get_saved_query before editing. Preserve unchanged fields and supply the exact current ETag when updating.",
			"Records examples require a records-capable provider from list_insights_providers and a dashboard service variable. The SQL example needs a PostgreSQL provider with reader access to your reporting view; replace the illustrative table and columns. Bind SQL values with $1 and an unquoted {{service}} in the JSON parameters array, never inside the SQL body.",
			"Built-in records plugins use type=plugin and dataKind=records: record-table config {columns?:string[],pageSize?:5..100}; record-list {title:string,body?:string,subtitle?:string,url?:string,status?:string}; record-treemap {label:string,value:string,group?:string}; record-matrix {x:string,y:string,value:string,min?:number,max?:number}. Config strings name result columns, not expressions.",
			"Record charts: records-line and records-bar config {x:string,y:string[],group?:string,rightAxis?:string[],annotations?:[{x:string|number,label:string}]}; y contains 1..8 numeric columns and rightAxis is a subset. Metric plugins include pie {donut?:boolean} and status-history {maxSeries?:1..24,maxPoints?:8..120}; use dataKind=metrics for those.",
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
		return append(examples, json.RawMessage(schemaRecordWidgetExample))
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
