package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
)

func (s *Server) listDashboards(w http.ResponseWriter, r *http.Request) {
	summary := r.URL.Query().Get("summary") == "true"
	variant := "dashboards:full"
	if summary {
		variant = "dashboards:summary"
	}
	// A conditional read asks the store's generation first, so an unchanged list is not listed or encoded again.
	if tag := collectionTag(s.bootTag, s.store.Generation(), variant); matchesReadETag(r.Header.Get("If-None-Match"), tag) {
		writeNotModified(w, tag)
		return
	}
	documents, generation := s.store.ListVersioned()
	if summary {
		documents = summarizeDocuments(documents, []string{"id", "title", "description", "folder"}, true)
	}
	writeTaggedCollection(w, collectionTag(s.bootTag, generation, variant), map[string]any{"dashboards": documents})
}

// collectionTag names one state of a collection: the process that serves it, the generation of the store it was
// read at, and the listing variant. A write or a delete moves the generation, and a restart moves the boot, so a
// tag never matches a list it did not describe.
func collectionTag(boot string, generation uint64, variant string) string {
	return fmt.Sprintf(`"c-%s-%d-%s"`, boot, generation, variant)
}

// writeTaggedCollection writes a collection under the tag of the generation it was read at.
func writeTaggedCollection(w http.ResponseWriter, tag string, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not encode collection")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", tag)
	// #nosec G705 -- json.Marshal escapes HTML and the content type is application/json.
	_, _ = w.Write(body) //nolint:errcheck // The response has started; a failed connection cannot be recovered.
}

// writeNotModified answers a conditional read whose tag still names the current generation.
func writeNotModified(w http.ResponseWriter, tag string) {
	w.Header().Set("ETag", tag)
	w.WriteHeader(http.StatusNotModified)
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
