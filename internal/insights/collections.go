package insights

import (
	"encoding/json"
	"net/http"
)

func (s *Server) listDashboards(w http.ResponseWriter, r *http.Request) {
	documents := s.store.List()
	if r.URL.Query().Get("summary") == "true" {
		documents = summarizeDocuments(documents, []string{"id", "title", "description", "folder"}, true)
	}
	writeCollectionJSON(w, r, map[string]any{"dashboards": documents})
}

// Summaries keep MCP discovery bounded; full canonical documents are fetched by ID.
func summarizeDocuments(documents []json.RawMessage, fields []string, widgets bool) []json.RawMessage {
	summaries := make([]json.RawMessage, 0, len(documents))
	for _, document := range documents {
		var source map[string]json.RawMessage
		if json.Unmarshal(document, &source) != nil {
			continue
		} // Store entries have already passed strict document validation.
		summary := make(map[string]json.RawMessage, len(fields)+1)
		for _, field := range fields {
			if value, ok := source[field]; ok {
				summary[field] = value
			}
		}
		if widgets {
			var items []json.RawMessage
			if json.Unmarshal(source["widgets"], &items) == nil {
				summary["widgetCount"], _ = json.Marshal(len(items)) //nolint:errcheck // Integer JSON encoding cannot fail.
			}
		}
		encoded, err := json.Marshal(summary)
		if err == nil {
			summaries = append(summaries, encoded)
		}
	}
	return summaries
}

// ETags let visible dashboards detect external writes without retransmitting
// unchanged collections. Authorization still runs before conditional responses.
func writeCollectionJSON(w http.ResponseWriter, r *http.Request, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not encode collection")
		return
	}
	tag := etag(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", tag)
	if matchesReadETag(r.Header.Get("If-None-Match"), tag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	// #nosec G705 -- json.Marshal escapes HTML and the content type is application/json.
	_, _ = w.Write(body) //nolint:errcheck // The response has started; a failed connection cannot be recovered.
}
