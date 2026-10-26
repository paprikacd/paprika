package insights

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCollectionETagsRefreshAfterWritesAndStillRequireAuthentication(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	for _, tc := range []struct {
		path        string
		document    []byte
		secretField string
	}{
		{"dashboards", dashboard("demo", "Original"), `"widgets"`},
		{"saved-queries", []byte(`{"schemaVersion":1,"id":"demo","name":"Original","providerId":"prometheus","kind":"metrics","query":"up"}`), `"query":`},
	} {
		t.Run(tc.path, func(t *testing.T) {
			empty := request(t, h, http.MethodGet, "/api/"+tc.path, nil, nil)
			require.Equal(t, http.StatusOK, empty.Code)
			tag := empty.Header().Get("ETag")
			require.NotEmpty(t, tag)
			unchanged := request(t, h, http.MethodGet, "/api/"+tc.path, nil, map[string]string{"If-None-Match": tag})
			require.Equal(t, http.StatusNotModified, unchanged.Code)
			require.Empty(t, unchanged.Body.String())
			denied := request(t, h, http.MethodGet, "/api/"+tc.path, nil, map[string]string{"If-None-Match": tag, "Authorization": ""})
			require.Equal(t, http.StatusUnauthorized, denied.Code)
			saved := request(t, h, http.MethodPut, "/api/"+tc.path+"/demo", tc.document, map[string]string{"If-None-Match": "*"})
			require.Equal(t, http.StatusOK, saved.Code)
			current := request(t, h, http.MethodGet, "/api/"+tc.path+"/demo", nil, map[string]string{"If-None-Match": saved.Header().Get("ETag")})
			require.Equal(t, http.StatusNotModified, current.Code)
			require.Empty(t, current.Body.String())
			changed := request(t, h, http.MethodGet, "/api/"+tc.path, nil, map[string]string{"If-None-Match": tag})
			require.Equal(t, http.StatusOK, changed.Code)
			require.NotEqual(t, tag, changed.Header().Get("ETag"))
			require.Contains(t, changed.Body.String(), "Original")
			summary := request(t, h, http.MethodGet, "/api/"+tc.path+"?summary=true", nil, nil)
			require.Equal(t, http.StatusOK, summary.Code)
			require.NotContains(t, summary.Body.String(), tc.secretField)
			require.Contains(t, summary.Body.String(), "Original")
			require.NotEqual(t, changed.Header().Get("ETag"), summary.Header().Get("ETag"))
		})
	}
}

func TestDocumentVersionsRemainStrongWhenReadETagsAreWeakened(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://metrics.example.test"})
	h := s.Handler()
	for _, tc := range []struct {
		path     string
		document []byte
	}{
		{"dashboards", dashboard("demo", "Original")},
		{"saved-queries", []byte(`{"schemaVersion":1,"id":"demo","name":"Original","providerId":"prometheus","kind":"metrics","query":"up"}`)},
	} {
		t.Run(tc.path, func(t *testing.T) {
			path := "/api/" + tc.path + "/demo"
			created := request(t, h, http.MethodPut, path, tc.document, map[string]string{"If-None-Match": "*"})
			require.Equal(t, http.StatusOK, created.Code)
			tag := created.Header().Get(documentETagHeader)
			require.Equal(t, created.Header().Get("ETag"), tag)
			require.Regexp(t, `^"[a-f0-9]{64}"$`, tag)
			read := request(t, h, http.MethodGet, path, nil, nil)
			require.Equal(t, tag, read.Header().Get(documentETagHeader))
			cached := request(t, h, http.MethodGet, path, nil, map[string]string{"If-None-Match": `"other", W/` + tag})
			require.Equal(t, http.StatusNotModified, cached.Code)
			require.Equal(t, tag, cached.Header().Get(documentETagHeader))
			denied := request(t, h, http.MethodGet, path, nil, map[string]string{"Authorization": "", "If-None-Match": "W/" + tag})
			require.Equal(t, http.StatusUnauthorized, denied.Code)
			require.Empty(t, denied.Header().Get(documentETagHeader))
			next := []byte(strings.ReplaceAll(string(tc.document), "Original", "Updated"))
			weakWrite := request(t, h, http.MethodPut, path, next, map[string]string{"If-Match": "W/" + tag})
			require.Equal(t, http.StatusPreconditionFailed, weakWrite.Code)
			updated := request(t, h, http.MethodPut, path, next, map[string]string{"If-Match": tag})
			require.Equal(t, http.StatusOK, updated.Code)
			require.NotEqual(t, tag, updated.Header().Get(documentETagHeader))
			require.Equal(t, updated.Header().Get("ETag"), updated.Header().Get(documentETagHeader))
			stale := request(t, h, http.MethodPut, path, tc.document, map[string]string{"If-Match": tag})
			require.Equal(t, http.StatusPreconditionFailed, stale.Code)
			collection := request(t, h, http.MethodGet, "/api/"+tc.path, nil, nil)
			cachedList := request(t, h, http.MethodGet, "/api/"+tc.path, nil, map[string]string{"If-None-Match": "W/" + collection.Header().Get("ETag")})
			require.Equal(t, http.StatusNotModified, cachedList.Code)
		})
	}
}
