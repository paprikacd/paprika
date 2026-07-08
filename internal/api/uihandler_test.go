package apiserver

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
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

func TestEmbeddedDashboardBundleContainsCommandCenter(t *testing.T) {
	sub, err := fs.Sub(uiFiles, "uistatic")
	if err != nil {
		t.Fatalf("open embedded UI files: %v", err)
	}

	dashboardHTML, err := fs.ReadFile(sub, "dashboard/index.html")
	if err != nil {
		t.Fatalf("read dashboard HTML: %v", err)
	}

	for _, want := range []string{
		"Cluster command center",
		"Latest searches",
		"Application health map",
	} {
		if !strings.Contains(string(dashboardHTML), want) {
			t.Fatalf("dashboard HTML missing %q; rebuild internal/api/uistatic from ui/out", want)
		}
	}
}

func TestEmbeddedDashboardStaticReferencesExist(t *testing.T) {
	sub, err := fs.Sub(uiFiles, "uistatic")
	if err != nil {
		t.Fatalf("open embedded UI files: %v", err)
	}

	dashboardHTML, err := fs.ReadFile(sub, "dashboard/index.html")
	if err != nil {
		t.Fatalf("read dashboard HTML: %v", err)
	}

	staticRef := regexp.MustCompile(`(?:href|src)="/(_next/static/[^"]+)"`)
	matches := staticRef.FindAllSubmatch(dashboardHTML, -1)
	if len(matches) == 0 {
		t.Fatal("dashboard HTML did not reference any Next static assets")
	}

	for _, match := range matches {
		assetPath := string(match[1])
		if _, err := fs.Stat(sub, assetPath); err != nil {
			t.Fatalf("dashboard HTML references missing embedded asset %q: %v", assetPath, err)
		}
	}
}
