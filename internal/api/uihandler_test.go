package apiserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUIHandlerCacheHeaders(t *testing.T) {
	handler, err := UIHandler()
	if err != nil {
		t.Fatalf("UIHandler() error = %v", err)
	}

	tests := []struct {
		name         string
		path         string
		wantContains string
	}{
		{
			name:         "dashboard route html is not immutable",
			path:         "/dashboard/",
			wantContains: "no-cache",
		},
		{
			name:         "spa fallback html is not immutable",
			path:         "/missing-client-route",
			wantContains: "no-cache",
		},
		{
			name:         "hashed static chunks are immutable",
			path:         "/_next/static/chunks/0k9f8nuyo3bm-.js",
			wantContains: "immutable",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			got := rec.Header().Get("Cache-Control")
			if !strings.Contains(got, tt.wantContains) {
				t.Fatalf("Cache-Control = %q, want to contain %q", got, tt.wantContains)
			}
		})
	}
}
