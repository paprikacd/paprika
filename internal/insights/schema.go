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
		Examples: []json.RawMessage{authoringSchemaExample(kind)},
		Notes: []string{
			"Examples are illustrative documents, not live telemetry. Replace metrics-provider-id using list_insights_providers and discover metric and label names before querying.",
			"The service additionally validates semantic rules, references, unique identifiers, typed bindings, query literal boundaries and plugin configuration. JSON Schema alone does not express every runtime check.",
			"Create service-request-rate from the saved_query example before using the widget or dashboard example. Widget queryRef is authoritative; unavailable references fail without falling back to the required query field.",
			"Use get_dashboard or get_saved_query before editing. Preserve unchanged fields and supply the exact current ETag when updating.",
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
