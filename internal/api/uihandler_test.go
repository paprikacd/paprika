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

// findAnEmbeddedStaticChunk returns the path (relative to the UI root, as a
// request path) of an arbitrary real /_next/static/chunks/*.js file in the
// embedded bundle. Content-hashed chunk filenames change on every UI
// rebuild, so tests must discover a real one rather than hardcoding a
// filename from a previous build — a stale hardcoded name silently starts
// exercising the SPA-fallback branch instead of the immutable-asset branch
// it was meant to test.
func findAnEmbeddedStaticChunk(t *testing.T) string {
	t.Helper()
	sub, err := fs.Sub(uiFiles, "uistatic")
	if err != nil {
		t.Fatalf("open embedded UI files: %v", err)
	}
	var found string
	if walkErr := fs.WalkDir(sub, "_next/static/chunks", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if found == "" && !entry.IsDir() && strings.HasSuffix(path, ".js") {
			found = path
		}
		return nil
	}); walkErr != nil {
		t.Fatalf("walk embedded static chunks: %v", walkErr)
	}
	if found == "" {
		t.Fatal("no embedded /_next/static/chunks/*.js file found")
	}
	return "/" + found
}

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
			path:         findAnEmbeddedStaticChunk(t),
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
		// App-shell nav chrome (sidebar.tsx): present on every dashboard
		// route, so these alone only catch a wholly pre-redesign bundle, not
		// a stale or missing overview body.
		"Operations console",
		"Fleet map",
		"Applications",
		// Fix round 2, Finding 2: the nav-chrome strings above are not
		// specific to the overview route at all — they would still pass
		// against a bundle whose overview body was stale or entirely
		// missing. "Loading the operations overview…" is
		// dashboard/page.tsx's Suspense fallback specifically for the
		// overview route (OverviewView's own static JSX, e.g. its
		// "Operations overview" heading, is behind that Suspense boundary
		// and only renders client-side, so it never reaches the static
		// export's index.html) — it does not appear in any other dashboard
		// route's index.html (e.g. dashboard/map or dashboard/applications
		// render their own distinct fallback text), so it is the strongest
		// overview-specific signal actually present in this static bundle.
		"Loading the operations overview",
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
