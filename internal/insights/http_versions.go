package insights

import (
	"net/http"
	"strings"
)

// Intermediaries may weaken HTTP ETags when compressing a representation. Keep
// the exact stored-document version separate so a browser can still perform a
// strict If-Match write. This header is an opaque version, not an auth token.
const documentETagHeader = "X-Paprika-Document-ETag"

func setDocumentETag(w http.ResponseWriter, tag string) {
	w.Header().Set("ETag", tag)
	w.Header().Set(documentETagHeader, tag)
}

// Conditional GET uses weak comparison; write preconditions deliberately keep
// the store's strict comparison and must never call this helper.
func matchesReadETag(header, tag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == tag {
			return true
		}
	}
	return false
}
