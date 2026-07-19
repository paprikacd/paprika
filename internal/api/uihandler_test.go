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
			name:         "applications route uses canonical exported directory",
			path:         "/dashboard/applications/?view=heatmap",
			wantContains: "no-cache",
		},
		{
			name:         "application detail route uses canonical exported directory",
			path:         "/dashboard/application/?application_name=checkout",
			wantContains: "no-cache",
		},
		{
			name:         "releases route uses canonical exported directory",
			path:         "/dashboard/releases/?namespace=team-00",
			wantContains: "no-cache",
		},
		{
			name:         "rollouts route uses canonical exported directory",
			path:         "/dashboard/rollouts/?namespace=team-00",
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

	staticRef := regexp.MustCompile(`(?:href|src)="/(_next/static/[^"]+)"`)
	checked := 0
	if walkErr := fs.WalkDir(sub, ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() || (!strings.HasSuffix(path, ".html") && !strings.HasSuffix(path, ".txt")) {
			return walkErr
		}
		data, readErr := fs.ReadFile(sub, path)
		if readErr != nil {
			return readErr
		}
		for _, match := range staticRef.FindAllSubmatch(data, -1) {
			assetPath := string(match[1])
			if _, statErr := fs.Stat(sub, assetPath); statErr != nil {
				t.Fatalf("%s references missing embedded asset %q: %v", path, assetPath, statErr)
			}
			checked++
		}
		return nil
	}); walkErr != nil {
		t.Fatalf("walk embedded UI files: %v", walkErr)
	}
	if checked == 0 {
		t.Fatal("embedded UI files did not reference any Next static assets")
	}
}
